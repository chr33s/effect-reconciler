/**
 * Semantic observation (spec.2 §3): what an application may learn about the
 * lifetimes it asked for.
 *
 * The contract is deliberately two-sided. `status` is authoritative and cannot
 * be missed, so application state that depends on failure stays discoverable.
 * The failure stream is a live convenience: bounded, live-only, and lossy
 * under overflow, because publishing must never block reconciliation.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Option } from "effect"
import * as Reconciler from "../src/Reconciler.js"
import {
  awaitStatus,
  drainFailures,
  failureQueue,
  idle,
  StartupFailed,
  statusTag
} from "./util.js"

describe("status", () => {
  it.live("reports every semantic state of one lifetime", () =>
    Effect.gen(function* () {
      const ownerGate = yield* Deferred.make<void>()
      const startGate = yield* Deferred.make<void>()
      const stopGate = yield* Deferred.make<void>()
      let failing = false
      const Def = Reconciler.define((define) => {
        const Owner = define.one("Owner", {
          start: () => Deferred.await(ownerGate)
        })
        const Res = define.one("Res", {
          owner: Owner,
          start: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Deferred.await(stopGate))
              yield* Deferred.await(startGate)
              if (failing) return yield* new StartupFailed({ reason: "boom" })
            })
        })
        return { Owner, Res }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly owner: Option.Option<string>; readonly res: boolean }>((bind) => ({
          owner: bind.one(Def.Owner, (s) => s.owner),
          res: bind.one(Def.Res, (s) => (s.res ? Option.some("r") : Option.none()))
        }))
      )
      const ref = Reconciler.ref(Def.Res, "r", Reconciler.ref(Def.Owner, "o", null))

      // Nothing exists yet.
      expect(yield* statusTag(controller, ref)).toBe("None")

      // Desire is owner-relative: with no owner there is nothing to run.
      yield* controller.commit({ owner: Option.none(), res: true })
      yield* idle(controller)
      expect(yield* statusTag(controller, ref)).toBe("None")

      // Desired, but its owner has not finished starting, so no generation
      // exists for it yet. What was asked for lives in the application's own
      // state; the runtime reports what exists.
      yield* controller.commit({ owner: Option.some("o"), res: true })
      yield* awaitStatus(controller, Reconciler.ref(Def.Owner, "o", null), "Starting")
      expect(yield* statusTag(controller, ref)).toBe("None")

      // Owner Running: the lifetime is admitted and observable while starting.
      yield* Deferred.succeed(ownerGate, void 0)
      yield* awaitStatus(controller, ref, "Starting")

      yield* Deferred.succeed(startGate, void 0)
      yield* idle(controller)
      expect(yield* statusTag(controller, ref)).toBe("Running")

      // Withdrawn while its finalizer is blocked.
      yield* controller.commit({ owner: Option.some("o"), res: false })
      yield* awaitStatus(controller, ref, "Stopping")
      yield* Deferred.succeed(stopGate, void 0)
      yield* idle(controller)
      expect(yield* statusTag(controller, ref)).toBe("None")

      // And a failed generation reports its cause.
      failing = true
      yield* controller.commit({ owner: Option.some("o"), res: true })
      yield* awaitStatus(controller, ref, "Failed")
      const status = yield* controller.status(ref)
      expect(Option.isSome(status)).toBe(true)
      if (Option.isSome(status) && status.value._tag === "Failed") {
        expect((Cause.squash(status.value.cause) as StartupFailed)._tag).toBe("StartupFailed")
      }
    }))

  it.live("a failure that was never observed on the stream is still discoverable", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: () => new StartupFailed({ reason: "boom" })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({ res: bind.one(Def.Res, () => Option.some("a")) }))
      )
      const ref = Reconciler.ref(Def.Res, "a", null)

      // No subscriber exists, so the notification is dropped entirely.
      yield* controller.commit({})
      yield* idle(controller)
      const subscription = yield* failureQueue(controller)
      expect(yield* drainFailures(subscription)).toEqual([])

      // The state itself is not lost: this is why status is the authority.
      const status = yield* controller.status(ref)
      expect(Option.isSome(status) && status.value._tag).toBe("Failed")
    }))
})

describe("failure stream", () => {
  it.live("§3.1/§3.2 — reports current desire only, never a stale generation", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: string) =>
            Effect.gen(function* () {
              if (k === "slow") {
                // Obsoleted while starting, then fails late.
                yield* Effect.uninterruptible(Deferred.await(gate))
                return yield* new StartupFailed({ reason: "late" })
              }
              if (k === "bad") return yield* new StartupFailed({ reason: "current" })
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )
      const subscription = yield* failureQueue(controller)

      yield* controller.commit({ key: "slow" })
      yield* awaitStatus(controller, Reconciler.ref(Def.Res, "slow", null), "Starting")

      // Supersede it. The replacement waits for the superseded generation's
      // finalization boundary, so release it and let it fail late.
      yield* controller.commit({ key: "bad" })
      yield* Deferred.succeed(gate, void 0)
      yield* awaitStatus(controller, Reconciler.ref(Def.Res, "bad", null), "Failed")
      yield* idle(controller)

      const received = yield* drainFailures(subscription)
      expect(received).toHaveLength(1)
      expect(received[0]!.lifetime.key).toBe("bad")
    }))

  it.live("§3.3 — a retry that fails again reports a fresh failure", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: () => new StartupFailed({ reason: "boom" })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({ res: bind.one(Def.Res, () => Option.some("a")) }))
      )
      const ref = Reconciler.ref(Def.Res, "a", null)
      const subscription = yield* failureQueue(controller)

      yield* controller.commit({})
      yield* idle(controller)
      expect(yield* drainFailures(subscription)).toHaveLength(1)

      yield* controller.retry(ref)
      yield* idle(controller)

      const again = yield* drainFailures(subscription)
      expect(again).toHaveLength(1)
      expect(again[0]!.lifetime.key).toBe("a")
    }))

  it.live("§3.4/§3.5 — subscriptions are Scope-owned and retain nothing when absent", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => ({
        Res: define.many("Res", {
          start: () => new StartupFailed({ reason: "boom" })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly keys: ReadonlyArray<string> }>((bind) => ({
          res: bind.many(Def.Res, (s) => s.keys)
        }))
      )

      // A subscription bound to a nested Scope sees what is published while it
      // is attached, and nothing after that Scope closes.
      const seen = yield* Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* failureQueue(controller)
          yield* controller.commit({ keys: ["a"] })
          yield* idle(controller)
          return yield* drainFailures(subscription)
        })
      )
      expect(seen.map((failure) => failure.lifetime.key)).toEqual(["a"])

      // Published with no subscriber attached: nothing is retained for the
      // next one, which only ever sees live events.
      yield* controller.commit({ keys: ["a", "b"] })
      yield* idle(controller)
      const later = yield* failureQueue(controller)
      expect(yield* drainFailures(later)).toEqual([])

      yield* controller.commit({ keys: ["a", "b", "c"] })
      yield* idle(controller)
      expect((yield* drainFailures(later)).map((failure) => failure.lifetime.key)).toEqual(["c"])
    }))

  it.live("§3.6/§3.7 — overflow drops the oldest and never blocks reconciliation", () =>
    Effect.gen(function* () {
      const started: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.many("Res", {
          start: (k: string) =>
            Effect.gen(function* () {
              started.push(k)
              return yield* new StartupFailed({ reason: k })
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly keys: ReadonlyArray<string> }>((bind) => ({
          res: bind.many(Def.Res, (s) => s.keys)
        }))
      )
      // Attached with a small buffer and deliberately not draining, so the
      // subscriber falls behind and the bounded buffers drop.
      const subscription = yield* failureQueue(controller, { capacity: 16, strategy: "sliding" })

      const keys = Array.from({ length: 200 }, (_, index) => `k${index}`)
      yield* controller.commit({ keys })

      // Reconciliation converged despite the backlog: publication never waits
      // for a subscriber.
      yield* idle(controller)
      expect(started).toHaveLength(200)

      // The subscriber fell behind, so it lost events rather than holding the
      // reconciler up. How many survive is not part of the contract; that
      // some were dropped is.
      const received = yield* drainFailures(subscription)
      const receivedKeys = received.map((failure) => failure.lifetime.key)
      expect(receivedKeys.length).toBeLessThan(keys.length)
      expect(receivedKeys).not.toContain(keys[0])
    }))
})
