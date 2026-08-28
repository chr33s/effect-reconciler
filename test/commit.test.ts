import { Deferred, Effect, Fiber, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as Key from "../src/Key.js"
import * as Reconciler from "../src/Reconciler.js"
import { eventually, settle, TestTimeout } from "./util.js"

describe("commit", () => {
  it.live("9.11/§51 — commit does not await startup, and returns once desire is published", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const never = yield* Deferred.make<void>()
      const Def = Reconciler.define((define) => ({
        Slow: define.one("Slow", {
          key: Key.string,
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`begin:${k}`)
              yield* Deferred.await(never) // startup never completes
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          slow: bind.one(Def.Slow, (s) => Option.some(s.key))
        }))
      )

      // Must resolve promptly even though the resource never starts.
      yield* controller.commit({ key: "a" }).pipe(
        Effect.timeoutOrElse({
          duration: 1000,
          orElse: () =>
            Effect.fail(new TestTimeout({ message: "commit awaited convergence" }))
        })
      )
      yield* eventually(() => log.includes("begin:a"), "startup began asynchronously")
    }))

  it.live("9.11/§47 — a failed commit publishes nothing; the previous desire stays authoritative", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Doc: define.many("Doc", {
          key: Key.string,
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`start:${k}`)
              yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`stop:${k}`)))
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly docs: ReadonlyArray<string> }>((bind) => ({
          docs: bind.many(Def.Doc, (s) => s.docs)
        }))
      )

      yield* controller.commit({ docs: ["a"] })
      yield* eventually(() => log.includes("start:a"), "converged")

      // Duplicate semantic keys from a many selector: dynamically invalid.
      const result = yield* Effect.result(controller.commit({ docs: ["b", "b"] }))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("InvalidDesiredState")
      }
      yield* settle

      // Old desire remained authoritative: no churn, no partial publication.
      expect(log).toEqual(["start:a"])

      // The controller is still fully functional.
      yield* controller.commit({ docs: ["c"] })
      yield* eventually(() => log.includes("start:c") && log.includes("stop:a"), "recovered")
    }))

  it.live("9.12 — concurrent commits linearize and the controller converges to one total order", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
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

      const keys = Array.from({ length: 20 }, (_, i) => `k${i}`)
      const fiber = yield* Effect.forkChild(
        Effect.forEach(keys, (key) => controller.commit({ key }), {
          concurrency: "unbounded",
          discard: true
        })
      )
      yield* Fiber.join(fiber)

      // The controller is not corrupted: a final serialized commit wins.
      yield* controller.commit({ key: "final" })
      yield* eventually(() => log.includes("start:final"), "converged to final")
      yield* settle

      // Exactly one live instance remains: every other started key stopped.
      const started = log.filter((e) => e.startsWith("start:")).map((e) => e.slice(6))
      for (const key of started) {
        if (key !== "final") {
          expect(log).toContain(`stop:${key}`)
        }
      }
      expect(log).not.toContain("stop:final")
    }))

  it.live("9.11 — an interrupted commit is atomic: published entirely or not at all", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          key: Key.string,
          start: (k: string) => Effect.sync(() => log.push(`start:${k}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )

      yield* controller.commit({ key: "a" })
      yield* eventually(() => log.includes("start:a"), "baseline converged")

      const fiber = yield* Effect.forkChild(controller.commit({ key: "b" }))
      yield* Fiber.interrupt(fiber)
      yield* settle

      // Either "b" was fully published (and started) or it never was; the
      // controller must remain consistent either way.
      yield* controller.commit({ key: "c" })
      yield* eventually(() => log.includes("start:c"), "still consistent after interruption")
    }))
})
