import { Context, Deferred, Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as Key from "../src/Key.js"
import * as Reconciler from "../src/Reconciler.js"
import * as Replacement from "../src/Replacement.js"
import { SettingsService } from "./fixtures.js"
import { eventually, idle, StartupFailed } from "./util.js"

describe("replacement", () => {
  it.live("9.7 — sequential replacement with latest-state coalescing (B never starts)", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const stopGate = yield* Deferred.make<void>()
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          key: Key.string,
          replacement: Replacement.sequential(),
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`start:${k}`)
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  log.push(`stopping:${k}`)
                  yield* Deferred.await(stopGate)
                  log.push(`stopped:${k}`)
                })
              )
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )

      yield* controller.commit({ key: "A" })
      yield* eventually(() => log.includes("start:A"), "A running")

      // A begins stopping (finalizer blocked); B is desired...
      yield* controller.commit({ key: "B" })
      yield* eventually(() => log.includes("stopping:A"), "A stopping")
      // ...then C supersedes B while A is still finalizing.
      yield* controller.commit({ key: "C" })

      // Finalization boundary reached: latest desire (C) starts. B never does.
      yield* Deferred.succeed(stopGate, void 0)
      yield* eventually(() => log.includes("start:C"), "C started")
      yield* idle(controller)

      // The total order is the proof: B was superseded before the slot freed,
      // and C only started once A had fully finalized.
      expect(log).toEqual(["start:A", "stopping:A", "stopped:A", "start:C"])
    }))

  it.live("9.8 — overlap replacement permits safe coexistence", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const stopGate = yield* Deferred.make<void>()
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          key: Key.string,
          replacement: Replacement.overlap(),
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`start:${k}`)
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  log.push(`stopping:${k}`)
                  yield* Deferred.await(stopGate)
                  log.push(`stopped:${k}`)
                })
              )
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )

      yield* controller.commit({ key: "A" })
      yield* eventually(() => log.includes("start:A"), "A running")

      yield* controller.commit({ key: "B" })
      // B starts while A is still stopping (its finalizer is blocked).
      yield* eventually(() => log.includes("start:B"), "B started during A's stop")
      expect(log).toContain("stopping:A")
      expect(log).not.toContain("stopped:A")

      yield* Deferred.succeed(stopGate, void 0)
      yield* eventually(() => log.includes("stopped:A"), "A finalized")
    }))

  it.live("sequential exclusivity survives an ancestor stopping during a descendant's finalization", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const childStopGate = yield* Deferred.make<void>()
      const Def = Reconciler.define((define) => {
        const Settings = define.one("Settings", {
          key: Key.number,
          start: (revision: number) =>
            Effect.succeed(Context.make(SettingsService, { revision }))
        })
        const Owner = define.one("Owner", {
          key: Key.string,
          requires: { settings: Settings },
          replacement: Replacement.overlap(),
          start: () => Effect.void
        })
        const Child = define.one("Child", {
          key: Key.string,
          owner: Owner,
          replacement: Replacement.sequential(),
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`child:start:${k}`)
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  if (k === "A") yield* Deferred.await(childStopGate)
                  log.push(`child:stopped:${k}`)
                })
              )
            })
        })
        return { Settings, Owner, Child }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly revision: number; readonly childKey: string }>((bind) => ({
          settings: bind.one(Def.Settings, (s) => Option.some(s.revision)),
          owner: bind.one(Def.Owner, () => Option.some("o")),
          child: bind.one(Def.Child, (s) => Option.some(s.childKey))
        }))
      )

      yield* controller.commit({ revision: 1, childKey: "A" })
      yield* eventually(() => log.includes("child:start:A"), "child A running")

      // Child A begins its own (blocked) finalization...
      yield* controller.commit({ revision: 1, childKey: "B" })

      // ...then the owner is replaced (provider change, same key). The
      // owner's Scope-close does not await A's in-flight close, but A's
      // sequential slot must still stay blocked until A truly finalizes.
      yield* controller.commit({ revision: 2, childKey: "B" })

      yield* Deferred.succeed(childStopGate, void 0)
      yield* eventually(() => log.includes("child:start:B"), "child B admitted")
      yield* idle(controller)

      // B never ran beside A, and only started after A's finalization
      // boundary — across the owner replacement in between.
      expect(log).toEqual(["child:start:A", "child:stopped:A", "child:start:B"])
    }))

  it.live("sequential replacement waits for a failed startup's partial-resource finalizers", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const releaseGate = yield* Deferred.make<void>()
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          key: Key.string,
          replacement: Replacement.sequential(),
          start: (k: string) =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => log.push(`acquire:${k}`)),
                () =>
                  Effect.gen(function* () {
                    if (k === "A") yield* Deferred.await(releaseGate)
                    log.push(`release:${k}`)
                  })
              )
              if (k === "A") return yield* new StartupFailed({ reason: "boom" })
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )

      yield* controller.commit({ key: "A" })
      yield* eventually(() => log.includes("acquire:A"), "A attempted")

      // A failed; its (blocked) cleanup is still releasing the exclusive
      // resource. The replacement must not start until release completes.
      yield* controller.commit({ key: "B" })

      yield* Deferred.succeed(releaseGate, void 0)
      yield* eventually(() => log.includes("acquire:B"), "B admitted after release")
      yield* idle(controller)

      // The exclusive resource was released before it was re-acquired.
      expect(log).toEqual(["acquire:A", "release:A", "acquire:B"])
    }))
})
