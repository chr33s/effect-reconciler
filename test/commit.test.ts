import { Deferred, Effect, Fiber, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as Reconciler from "../src/Reconciler.js"
import { eventually, holding, idle, TestTimeout } from "./util.js"

describe("commit", () => {
  it.live("9.11/§51 — commit does not await startup, and returns once desire is published", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const never = yield* Deferred.make<void>()
      const Def = Reconciler.define((define) => ({
        Slow: define.one("Slow", {
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
      yield* idle(controller)

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
      yield* idle(controller)

      // Exactly one live instance remains: every other started key stopped.
      const started = log.filter((e) => e.startsWith("start:")).map((e) => e.slice(6))
      for (const key of started) {
        if (key !== "final") {
          expect(log).toContain(`stop:${key}`)
        }
      }
      expect(log).not.toContain("stop:final")
    }))

  it.live("§1.3 — interruption before the publication point publishes nothing", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: string) => Effect.sync(() => log.push(`start:${k}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )

      yield* controller.commit({ key: "a" })
      yield* idle(controller)
      expect(log).toEqual(["start:a"])

      // Hold the controller's mutex so the commit is deterministically parked
      // before its publication region, then interrupt it there.
      const parked = yield* Deferred.make<void>()
      yield* Effect.forkChild(
        holding(controller)(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(controller.commit({ key: "b" }), {
              startImmediately: true
            })
            // The commit is now waiting for the permit this fiber holds.
            yield* Fiber.interrupt(fiber)
            yield* Deferred.succeed(parked, void 0)
          })
        )
      )
      yield* Deferred.await(parked)
      yield* idle(controller)

      // Nothing was published: "a" is untouched and "b" never existed.
      expect(log).toEqual(["start:a"])
    }))

  it.live("§1.3 — a commit that returns has definitely published, exactly once", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: string) => Effect.sync(() => log.push(`start:${k}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )

      // Publication has completed by the time the commit fiber finishes, so a
      // later interrupt of that fiber cannot unpublish or double-publish it.
      const fiber = yield* Effect.forkChild(controller.commit({ key: "a" }), {
        startImmediately: true
      })
      yield* Fiber.join(fiber)
      yield* Fiber.interrupt(fiber)
      yield* idle(controller)

      expect(log).toEqual(["start:a"])
    }))

  it.live("§1.3 — an interrupted commit never wedges the publication point", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: string) => Effect.sync(() => log.push(`start:${k}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )

      // A burst of commits interrupted at unpredictable points, all racing the
      // publication region.
      for (let i = 0; i < 50; i++) {
        const fiber = yield* Effect.forkChild(controller.commit({ key: `k${i}` }), {
          startImmediately: true
        })
        yield* Fiber.interrupt(fiber)
      }

      // The controller is neither corrupted nor wedged: a final commit still
      // publishes and converges, and every started key was one that was
      // actually committed.
      yield* controller.commit({ key: "final" })
      yield* idle(controller)

      const started = log.filter((e) => e.startsWith("start:")).map((e) => e.slice(6))
      for (const key of started) {
        expect(key === "final" || /^k\d+$/.test(key)).toBe(true)
      }
      expect(log[log.length - 1]).toBe("start:final")
    }))

  it.live("9.11/§50 — an interrupt at an uncontrolled point never publishes half a snapshot", () =>
    Effect.gen(function* () {
      // Where the interrupt lands relative to the publication point is not
      // controlled here — that is what the three tests above pin down. What
      // this one requires is that wherever it lands, the authoritative desired
      // snapshot is one whole committed state, never a mixture of two.
      const live = new Set<string>()
      const Def = Reconciler.define((define) => ({
        Doc: define.many("Doc", {
          start: (uri: string) =>
            Effect.gen(function* () {
              live.add(uri)
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  live.delete(uri)
                })
              )
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly docs: ReadonlyArray<string> }>((bind) => ({
          docs: bind.many(Def.Doc, (s) => s.docs)
        }))
      )

      // Multi-instance states, so a partially published snapshot would be
      // directly observable as a mixture of the two.
      const first = ["a1", "a2", "a3"]
      const second = ["b1", "b2", "b3"]
      yield* controller.commit({ docs: first })
      yield* idle(controller)
      expect([...live].sort()).toEqual(first)

      // A spread of interrupt timings: some before the commit fiber has run at
      // all, some at increasing delays into the publication window.
      const rounds = [
        { startImmediately: false, delay: 0 },
        { startImmediately: true, delay: 0 },
        { startImmediately: false, delay: 0 },
        { startImmediately: true, delay: 1 },
        { startImmediately: true, delay: 2 },
        { startImmediately: true, delay: 5 }
      ]
      let published = 0
      let retained = 0

      for (const [round, { delay, startImmediately }] of rounds.entries()) {
        const before = [...live].sort()
        const wanted = round % 2 === 0 ? second : first
        const fiber = yield* Effect.forkChild(controller.commit({ docs: wanted }), {
          startImmediately
        })
        if (delay > 0) yield* Effect.sleep(delay)
        yield* Fiber.interrupt(fiber)
        yield* idle(controller)

        const after = [...live].sort()
        expect([first, second]).toContainEqual(after)
        if (after.join() === wanted.join()) {
          published++
        } else {
          // Not published means untouched: the previous desire stayed
          // authoritative in full.
          expect(after).toEqual(before)
          retained++
        }
      }

      // Both sides of the linearization point were actually exercised, so the
      // invariant above was not checked against one outcome only.
      expect(published).toBeGreaterThan(0)
      expect(retained).toBeGreaterThan(0)

      // ...and the controller is still fully functional afterwards.
      yield* controller.commit({ docs: ["c1"] })
      yield* idle(controller)
      expect([...live].sort()).toEqual(["c1"])
    }))
})
