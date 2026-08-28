import { Context, Deferred, Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as Reconciler from "../src/Reconciler.js"
import * as Replacement from "../src/Replacement.js"
import { bindEditor, makeEditor, model, SettingsService } from "./fixtures.js"
import { count, eventually, idle } from "./util.js"

describe("capability dependencies", () => {
  it.live("9.4 — provider-only replacement invalidates dependents only", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const editor = makeEditor(log)
      const controller = yield* Reconciler.make(bindEditor(editor))

      yield* controller.commit(
        model({
          settingsRevision: Option.some(1),
          user: Option.some("alice"),
          workspaceId: Option.some("acme"),
          language: Option.some("ts"),
          documents: ["foo"],
          diagnostics: true
        })
      )
      yield* eventually(() => log.includes("start:diagnostics:foo:s1:ts"), "converged")

      // Settings replaced; everything else stays semantically identical.
      yield* controller.commit(
        model({
          settingsRevision: Option.some(2),
          user: Option.some("alice"),
          workspaceId: Option.some("acme"),
          language: Option.some("ts"),
          documents: ["foo"],
          diagnostics: true
        })
      )
      yield* eventually(
        () => log.includes("start:diagnostics:foo:s2:ts"),
        "diagnostics rebound to new settings"
      )
      yield* idle(controller)

      // Diagnostics was replaced...
      expect(log).toContain("stop:diagnostics:foo:s1:ts")
      // ...while owners that do not depend on Settings were retained.
      expect(count(log, "start:session:alice")).toBe(1)
      expect(count(log, "start:workspace:acme@alice")).toBe(1)
      expect(count(log, "start:language:ts")).toBe(1)
      expect(count(log, "start:document:foo")).toBe(1)
      expect(count(log, "stop:document:foo")).toBe(0)
    }))

  it.live("9.5 — provider replaced during dependent startup: late success is discarded, no generation mixing", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const lateGate = yield* Deferred.make<void>()

      class DepService extends Context.Service<
        DepService,
        { readonly settingsRevision: number }
      >()("test/DepService") {}

      const Def = Reconciler.define((define) => {
        const Settings = define.one("Settings", {
          start: (revision: number) =>
            Effect.succeed(Context.make(SettingsService, { revision }))
        })
        const Dep = define.one("Dep", {
          requires: { settings: Settings },
          // Overlap: D#2 may start while D#1 is still being torn down.
          replacement: Replacement.overlap(),
          start: (_: null) =>
            Effect.gen(function* () {
              const settings = yield* SettingsService
              log.push(`dep:begin:s${settings.revision}`)
              if (settings.revision === 1) {
                // Startup that outlives its provider generation.
                yield* Effect.uninterruptible(Deferred.await(lateGate))
              }
              return Context.make(DepService, { settingsRevision: settings.revision })
            })
        })
        // Only ever admitted beneath a Running Dep generation.
        const Probe = define.one("Probe", {
          owner: Dep,
          start: (_: null) =>
            Effect.gen(function* () {
              const dep = yield* DepService
              log.push(`probe:s${dep.settingsRevision}`)
            })
        })
        return { Settings, Dep, Probe }
      })

      const controller = yield* Reconciler.make(
        Def.bind<{ readonly revision: number }>((bind) => ({
          settings: bind.one(Def.Settings, (s) => Option.some(s.revision)),
          dep: bind.one(Def.Dep, () => Option.some(null)),
          probe: bind.one(Def.Probe, () => Option.some(null))
        }))
      )

      yield* controller.commit({ revision: 1 })
      yield* eventually(() => log.includes("dep:begin:s1"), "D#1 starting against S#1")

      // Provider replaced while D#1 is still starting.
      yield* controller.commit({ revision: 2 })
      yield* eventually(() => log.includes("probe:s2"), "D#2 running against S#2")

      // D#1's startup completes late — its result must be discarded.
      yield* Deferred.succeed(lateGate, void 0)
      yield* idle(controller)

      expect(log.filter((e) => e.startsWith("probe:"))).toEqual(["probe:s2"])
    }))

  it.live("§25 — ambiguous providers are rejected at creation", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => {
        const Provider = define.many("Provider", {
          start: (_: null) => Effect.void
        })
        const Dep = define.one("Dep", {
          requires: { provider: Provider },
          start: (_: null) => Effect.void
        })
        return { Provider, Dep }
      })
      const bound = Def.bind<{}>((bind) => ({
        provider: bind.many(Def.Provider, () => []),
        dep: bind.one(Def.Dep, () => Option.some(null))
      }))
      const result = yield* Effect.result(Reconciler.make(bound))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("AmbiguousProvider")
      }
    }))

  it.live("cross-definition handles are rejected at creation", () =>
    Effect.gen(function* () {
      const A = Reconciler.define((define) => ({
        Thing: define.one("Thing", { start: (_: null) => Effect.void })
      }))
      const B = Reconciler.define((define) => ({
        Other: define.one("Other", { start: (_: null) => Effect.void })
      }))
      const bound = A.bind<{}>((bind) => ({
        // Handle from definition B bound against definition A.
        thing: bind.one(B.Other, () => Option.none())
      }))
      const result = yield* Effect.result(Reconciler.make(bound))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ForeignHandle")
      }
    }))
})
