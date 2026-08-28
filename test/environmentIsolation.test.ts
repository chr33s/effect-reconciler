import { Context, Deferred, Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as Reconciler from "../src/Reconciler.js"
import * as Replacement from "../src/Replacement.js"
import { SessionService, SettingsService } from "./fixtures.js"
import { eventually, idle } from "./util.js"

describe("environment isolation", () => {
  it.live("9.18 — overlapping owner generations never leak services across generations", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const stopGate = yield* Deferred.make<void>()
      const Def = Reconciler.define((define) => {
        const Session = define.one("Session", {
          replacement: Replacement.overlap(),
          start: (userId: string) =>
            Effect.gen(function* () {
              // Keep the old generation Stopping while the new one runs.
              yield* Effect.addFinalizer(() => Deferred.await(stopGate))
              return Context.make(SessionService, { userId })
            })
        })
        const Workspace = define.one("Workspace", {
          owner: Session,
          replacement: Replacement.overlap(),
          start: (workspaceId: string) =>
            Effect.gen(function* () {
              const session = yield* SessionService
              // Records which session generation's capability this
              // descendant captured at admission.
              log.push(`observed:${workspaceId}:key=${session.userId}`)
            })
        })
        return { Session, Workspace }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly user: string }>((bind) => ({
          session: bind.one(Def.Session, (s) => Option.some(s.user)),
          // Same workspace key beneath both sessions, to stress isolation.
          workspace: bind.one(Def.Workspace, () => Option.some("acme"))
        }))
      )

      yield* controller.commit({ user: "alice" })
      yield* eventually(() => log.includes("observed:acme:key=alice"), "alice tree ready")

      yield* controller.commit({ user: "bob" })
      yield* eventually(() => log.includes("observed:acme:key=bob"), "bob tree ready")

      // Release the old generation's blocked finalizer and let the controller
      // converge fully before judging what was observed.
      yield* Deferred.succeed(stopGate, void 0)
      yield* idle(controller)

      // Both generations existed; each descendant saw exactly its own
      // generation's service. Zero cross-generation observations.
      expect(log.filter((e) => e.startsWith("observed:"))).toEqual([
        "observed:acme:key=alice",
        "observed:acme:key=bob"
      ])
    }))

  it.live("§60 — root environment services reach every startup Effect", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: string) =>
            Effect.gen(function* () {
              // Not a reconciled lifetime and not a `requires` provider: an
              // ordinary root service living for the Controller's root Scope.
              const settings = yield* SettingsService
              log.push(`res:${k}:s${settings.revision}`)
            })
        })
      }))
      const bound = Def.bind<{ readonly key: string }>((bind) => ({
        res: bind.one(Def.Res, (s) => Option.some(s.key))
      }))

      // `Reconciler.make` asks for exactly what the startup Effects need from
      // the root environment; providing it is ordinary Effect code.
      yield* Effect.gen(function* () {
        const controller = yield* Reconciler.make(bound)
        yield* controller.commit({ key: "a" })
        yield* eventually(() => log.includes("res:a:s7"), "root service observed")
      }).pipe(Effect.provideService(SettingsService, { revision: 7 }))
    }))

  it.live("§28 — a dependent captures one internally consistent provider set at admission", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => {
        const Settings = define.one("Settings", {
          start: (revision: number) =>
            Effect.succeed(Context.make(SettingsService, { revision }))
        })
        const Session = define.one("Session", {
          start: (userId: string) =>
            Effect.succeed(Context.make(SessionService, { userId }))
        })
        const Dep = define.one("Dep", {
          owner: Session,
          requires: { settings: Settings },
          start: () =>
            Effect.gen(function* () {
              const settings = yield* SettingsService
              const session = yield* SessionService
              log.push(`dep:${session.userId}:s${settings.revision}`)
            })
        })
        return { Settings, Session, Dep }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly user: string; readonly revision: number }>((bind) => ({
          settings: bind.one(Def.Settings, (s) => Option.some(s.revision)),
          session: bind.one(Def.Session, (s) => Option.some(s.user)),
          dep: bind.one(Def.Dep, () => Option.some(null))
        }))
      )

      yield* controller.commit({ user: "alice", revision: 1 })
      yield* eventually(() => log.includes("dep:alice:s1"), "consistent capture")

      // Both provider and owner replaced together: the new dependent
      // generation sees the new pair, never a mixed set.
      yield* controller.commit({ user: "bob", revision: 2 })
      yield* eventually(() => log.includes("dep:bob:s2"), "new consistent capture")
      yield* idle(controller)

      const observations = log.filter((e) => e.startsWith("dep:"))
      expect(observations).toEqual(["dep:alice:s1", "dep:bob:s2"])
    }))
})
