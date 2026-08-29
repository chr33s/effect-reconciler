import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import { makeDirectBaseline, makeDirectProbe } from "./direct.js"

const eventually = (condition: () => boolean): Effect.Effect<void> => {
  const loop: Effect.Effect<void> = Effect.suspend(() =>
    condition() ? Effect.void : Effect.andThen(Effect.sleep(1), loop)
  )
  return Effect.timeoutOrElse(loop, {
    duration: 2_000,
    orElse: () => Effect.die(new Error("direct Layer + Atom baseline timed out"))
  })
}

describe("direct Layer + Atom baseline characterization", () => {
  it.live("a mounted AtomRuntime builds the Layer selected by state", () =>
    Effect.gen(function* () {
      const probe = makeDirectProbe()
      const baseline = makeDirectBaseline(probe)
      const unmount = baseline.mount()
      yield* eventually(() => AsyncResult.isSuccess(baseline.registry.get(baseline.runtime)))
      expect(probe.events).toContain("start:A")
      unmount()
      baseline.registry.dispose()
    }))

  it.live("refresh starts the new Layer without awaiting the old finalization boundary", () =>
    Effect.gen(function* () {
      const probe = makeDirectProbe()
      const gate = yield* Deferred.make<void>()
      probe.stopGates.set("A", gate)
      const baseline = makeDirectBaseline(probe)
      const unmount = baseline.mount()
      yield* eventually(() => probe.events.includes("start:A"))

      baseline.set("B")
      yield* eventually(() => probe.events.includes("start:B"))

      // This is overlap, not the reconciler's sequential policy: the old
      // finalizer is blocked and the replacement Layer has already acquired.
      expect(probe.events).toContain("stopping:A")
      expect(probe.events).not.toContain("stop:A")
      expect(probe.events).toContain("start:B")

      yield* Deferred.succeed(gate, void 0)
      yield* eventually(() => probe.events.includes("stop:A"))
      unmount()
      baseline.registry.dispose()
    }))

  it.live("AtomRuntime.fn interrupts a finite Effect when its captured runtime changes", () =>
    Effect.gen(function* () {
      const baseline = makeDirectBaseline()
      const entered = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      let interrupted = false
      const command = baseline.runtime.fn<void>()(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, void 0)
          yield* Deferred.await(never)
        }).pipe(
          Effect.onInterrupt(() => Effect.sync(() => {
            interrupted = true
          }))
        ))
      const unmount = baseline.registry.mount(command)
      baseline.registry.set(command, undefined)
      yield* Deferred.await(entered)

      baseline.set("B")
      yield* eventually(() => interrupted)

      unmount()
      baseline.registry.dispose()
    }))

  it.live("resource existence is mount-driven unless application glue mounts desire", () =>
    Effect.gen(function* () {
      const probe = makeDirectProbe()
      const baseline = makeDirectBaseline(probe)

      // Merely writing desired state does not evaluate or retain the runtime.
      baseline.set("B")
      yield* Effect.sleep(10)
      expect(probe.events).toEqual([])

      const unmount = baseline.mount()
      yield* eventually(() => probe.events.includes("start:B"))
      unmount()
      yield* Effect.sleep(20)
      // AtomRuntime's selected Layer remains cached after the listener leaves;
      // the registry is the owning lifetime in this direct baseline.
      expect(probe.events).not.toContain("stop:B")
      baseline.registry.dispose()
      yield* eventually(() => probe.events.includes("stop:B"))
    }))
})
