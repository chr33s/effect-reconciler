import { Data, Effect } from "effect"
import { TestHooksId, type TestHooks } from "../src/internal/controller.js"
import type { LifetimeRef } from "../src/LifetimeRef.js"
import type * as Reconciler from "../src/Reconciler.js"
import type { LifetimeStatus } from "../src/Status.js"

/**
 * The controller's test-only bookkeeping hooks. They are attached to the
 * object `Reconciler.make` returns but deliberately kept off the public
 * `Controller` type, so tests reach them through this one bridge.
 */
export const hooks = <State>(controller: Reconciler.Controller<State>): TestHooks =>
  (controller as unknown as { readonly [TestHooksId]: TestHooks })[TestHooksId]

/** Completes once the controller has converged on the published desire. */
export const idle = <State>(controller: Reconciler.Controller<State>): Effect.Effect<void> =>
  hooks(controller).idle

/** Runs `effect` while holding the controller's serialization mutex. */
export const holding = <State>(controller: Reconciler.Controller<State>) =>
  hooks(controller).holding

/** A test expectation that never became true in time. */
export class TestTimeout extends Data.TaggedError("TestTimeout")<{
  readonly message: string
}> {}

/** Startup failure injected by a test's `start` Effect. */
export class StartupFailed extends Data.TaggedError("StartupFailed")<{
  readonly reason: string
}> {}

/** Poll until the condition holds (or fail after 5s). Convergence is
 * asynchronous, so tests await observable consequences instead of commits. */
export const eventually = (
  condition: () => boolean,
  label = "condition"
): Effect.Effect<void, TestTimeout> => {
  const loop: Effect.Effect<void> = Effect.suspend(() =>
    condition() ? Effect.void : Effect.andThen(Effect.sleep(5), loop)
  )
  return loop.pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () =>
        Effect.fail(new TestTimeout({ message: `eventually: ${label} not met within 5s` }))
    })
  )
}

/**
 * A real-time window in which nothing further is expected to happen.
 *
 * Only for the few assertions that cannot use `idle`: proving the absence of
 * an event while a lifetime is deliberately wedged, or after shutdown has
 * stopped the reconcile loop, where no convergence barrier can exist.
 */
/** Poll `controller.status(ref)` until it reports `tag`. */
export const awaitStatus = <State>(
  controller: Reconciler.Controller<State>,
  ref: LifetimeRef,
  tag: LifetimeStatus["_tag"]
): Effect.Effect<void, TestTimeout> => {
  const loop: Effect.Effect<void> = Effect.gen(function* () {
    const status = yield* controller.status(ref)
    if (status._tag === tag) return
    yield* Effect.sleep(2)
    yield* loop
  })
  return loop.pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () =>
        Effect.fail(
          new TestTimeout({ message: `status of ${String(ref.key)} never became ${tag}` })
        )
    })
  )
}

export const quietFor = (millis = 60): Effect.Effect<void> => Effect.sleep(millis)

export const count = (log: ReadonlyArray<string>, entry: string): number =>
  log.filter((e) => e === entry).length
