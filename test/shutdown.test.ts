import { Deferred, Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as Key from "../src/Key.js"
import * as Reconciler from "../src/Reconciler.js"
import { eventually, quietFor } from "./util.js"

describe("shutdown", () => {
  it.live("9.13 — shutdown interrupts startup, awaits finalization, suppresses late readiness", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const gate = yield* Deferred.make<void>()
      const Def = Reconciler.define((define) => {
        const Slow = define.one("Slow", {
          key: Key.string,
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`begin:${k}`)
              yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`cleanup:${k}`)))
              yield* Deferred.await(gate)
              log.push(`completed:${k}`)
            })
        })
        const Child = define.one("Child", {
          key: Key.null,
          owner: Slow,
          start: () => Effect.sync(() => log.push("child:start"))
        })
        return { Slow, Child }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          slow: bind.one(Def.Slow, (s) => Option.some(s.key)),
          child: bind.one(Def.Child, () => Option.some(null))
        }))
      )

      yield* controller.commit({ key: "a" })
      yield* eventually(() => log.includes("begin:a"), "startup in progress")

      yield* controller.shutdown
      // Structured finalization completed before shutdown returned.
      expect(log).toContain("cleanup:a")
      expect(log).not.toContain("completed:a")

      // Late completion cannot resurrect anything after shutdown. The
      // reconcile loop is gone with the root Scope, so there is no
      // convergence barrier left to wait on: a real-time window is the only
      // way to give a wrong implementation a chance to misbehave.
      yield* Deferred.succeed(gate, void 0)
      yield* quietFor()
      expect(log).not.toContain("child:start")
    }))

  it.live("9.14 — shutdown is idempotent", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", { key: Key.string, start: () => Effect.void })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({
          res: bind.one(Def.Res, () => Option.none())
        }))
      )
      yield* controller.shutdown
      yield* controller.shutdown
    }))

  it.live("9.15 — commit after shutdown fails with ControllerClosed", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", { key: Key.string, start: () => Effect.void })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )
      yield* controller.shutdown
      const result = yield* Effect.result(controller.commit({ key: "a" }))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ControllerClosed")
      }
    }))

  it.live("§55 — scope teardown shuts the controller down and closes live lifetimes", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      // A nested Scope: the Controller must shut down when it closes, before
      // the assertions below run.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const Def = Reconciler.define((define) => ({
            Res: define.one("Res", {
              key: Key.string,
              start: (k: string) =>
                Effect.gen(function* () {
                  log.push(`start:${k}`)
                  yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`stop:${k}`)))
                })
            })
          }))
          const controller = yield* Reconciler.make(
            Def.bind<{ readonly key: string }>((bind) => ({
              res: bind.one(Def.Res, (s) => Option.some(s.key))
            }))
          )
          yield* controller.commit({ key: "a" })
          yield* eventually(() => log.includes("start:a"), "converged")
        })
      )
      expect(log).toEqual(["start:a", "stop:a"])
    }))
})
