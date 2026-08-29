/**
 * Supervision policy (spec §9.8).
 *
 * The policy does exactly what `Controller.retry` does, on a schedule instead
 * of on a call — so the tests are about the two things that makes non-obvious:
 * that the *schedule* is per semantic identity and survives generations, and
 * that it stops mattering the moment the question it was asking is answered
 * some other way.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schedule } from "effect"
import * as Reconciler from "../src/Reconciler.js"
import * as Supervision from "../src/Supervision.js"
import { awaitStatus, eventually, idle, quietFor, StartupFailed, statusTag } from "./util.js"

interface Model {
  readonly keys: ReadonlyArray<string>
}

/** A family that fails until told otherwise, and counts its attempts. */
const makeFlaky = (
  supervision: Supervision.SupervisionPolicy,
  attemptsBeforeSuccess: Record<string, number> = {}
) => {
  const attempts: Array<string> = []
  const Def = Reconciler.define((define) => ({
    Res: define.many("Res", {
      supervision,
      start: (key: string) =>
        Effect.suspend(() => {
          attempts.push(key)
          const needed = attemptsBeforeSuccess[key] ?? Number.POSITIVE_INFINITY
          const so_far = attempts.filter((k) => k === key).length
          return so_far > needed ? Effect.void : new StartupFailed({ reason: key })
        })
    })
  }))
  return {
    attempts,
    Def,
    binding: Def.bind<Model>((b) => ({ res: b.many(Def.Res, (m) => m.keys) }))
  }
}

/** Fast enough that a test is not a stopwatch, slow enough to be a schedule. */
const fast = Schedule.spaced("5 millis")

describe("supervision", () => {
  it.live("§9.8 — the default is still manual: nothing retries by itself", () =>
    Effect.gen(function* () {
      const { attempts, Def, binding } = makeFlaky(Supervision.manual())
      const controller = yield* Reconciler.make(binding)
      yield* controller.commit({ keys: ["a"] })
      yield* awaitStatus(controller, Reconciler.ref(Def.Res, "a", null), "Failed")

      // The v0 contract, unchanged by the existence of a policy: a failed
      // generation holds its slot, and nobody but the application moves it.
      yield* quietFor(120)
      expect(attempts).toEqual(["a"])
      expect(yield* statusTag(controller, Reconciler.ref(Def.Res, "a", null))).toBe("Failed")
    }))

  it.live("§9.8 — restarts a failed startup until it succeeds, under the same key", () =>
    Effect.gen(function* () {
      const { attempts, Def, binding } = makeFlaky(Supervision.restart(fast), { a: 2 })
      const controller = yield* Reconciler.make(binding)
      const ref = Reconciler.ref(Def.Res, "a", null)

      yield* controller.commit({ keys: ["a"] })
      yield* awaitStatus(controller, ref, "Running")

      // Three attempts, one identity: retry never changes the semantic key,
      // so an application that watched this saw one lifetime become healthy,
      // not three lifetimes come and go.
      expect(attempts).toEqual(["a", "a", "a"])
      yield* idle(controller)
      expect((yield* controller.snapshot).lifetimes.map((e) => e.lifetime.key)).toEqual(["a"])
    }))

  it.live("§9.8 — stops when the schedule is exhausted, leaving the generation Failed", () =>
    Effect.gen(function* () {
      const { attempts, Def, binding } = makeFlaky(
        Supervision.restart(Schedule.spaced("5 millis").pipe(Schedule.upTo({ times: 2 })))
      )
      const controller = yield* Reconciler.make(binding)
      const ref = Reconciler.ref(Def.Res, "a", null)

      yield* controller.commit({ keys: ["a"] })
      yield* eventually(() => attempts.length === 3, "three attempts")
      yield* quietFor(120)

      // Exhaustion is an ending, not an error: the lifetime is Failed, which
      // is a state the application can see, act on, and retry out of by hand.
      expect(attempts).toEqual(["a", "a", "a"])
      expect(yield* statusTag(controller, ref)).toBe("Failed")

      yield* controller.retry(ref)
      yield* eventually(() => attempts.length === 4, "manual retry still works")
    }))

  it.live("§9.8 — withdrawing desire ends the backoff, and nothing restarts", () =>
    Effect.gen(function* () {
      const { attempts, Def, binding } = makeFlaky(Supervision.restart(Schedule.spaced("40 millis")))
      const controller = yield* Reconciler.make(binding)
      const ref = Reconciler.ref(Def.Res, "a", null)

      yield* controller.commit({ keys: ["a"] })
      yield* awaitStatus(controller, ref, "Failed")
      const attemptsWhenWithdrawn = attempts.length

      // The sleep is still in flight when desire goes away. What it must not
      // do is wake up later and admit something nobody wants.
      yield* controller.commit({ keys: [] })
      yield* idle(controller)
      yield* quietFor(150)
      expect(attempts.length).toBe(attemptsWhenWithdrawn)
      expect(yield* statusTag(controller, ref)).toBe("None")
    }))

  it.live("§9.8 — the backoff resets once the lifetime runs", () =>
    Effect.gen(function* () {
      // Two attempts to succeed, then it is asked to fail again by being
      // replaced: the second failure must start counting from the beginning,
      // not from wherever the first one left off.
      const attempts: Array<string> = []
      let failing = true
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          supervision: Supervision.restart(
            Schedule.spaced("5 millis").pipe(Schedule.upTo({ times: 1 }))
          ),
          start: (key: string) =>
            Effect.suspend(() => {
              attempts.push(key)
              return failing ? new StartupFailed({ reason: key }) : Effect.void
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((b) => ({
          res: b.one(Def.Res, (m) => Option.some(m.key))
        }))
      )

      // One failure plus one scheduled attempt: `recurs(1)` allows exactly one.
      yield* controller.commit({ key: "a" })
      yield* eventually(() => attempts.length === 2, "first budget spent")
      yield* quietFor(60)
      expect(attempts.length).toBe(2)

      // It becomes healthy. Had the schedule not reset here, the next failure
      // would find an exhausted budget and never retry at all.
      failing = false
      yield* controller.retry(Reconciler.ref(Def.Res, "a", null))
      yield* awaitStatus(controller, Reconciler.ref(Def.Res, "a", null), "Running")
      const afterRunning = attempts.length

      failing = true
      yield* controller.commit({ key: "b" })
      yield* eventually(
        () => attempts.length === afterRunning + 2,
        "a fresh budget for a fresh failure"
      )
    }))
})
