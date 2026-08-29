import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { pipe } from "effect/Function"
import * as Scope from "effect/Scope"
import type * as Semaphore from "effect/Semaphore"
import { forget, type LiveInstance, type LiveState } from "./liveState.js"

/**
 * Stopping a generation, and knowing when it has actually stopped.
 *
 * `Scope.close` on an already-closing Scope returns immediately without
 * awaiting the finalizers in flight, so close-call completion is NOT a
 * finalization boundary. Everything here exists to give one that is: each
 * generation carries a `closing` deferred completed only when the close that
 * really ran has finished, joiners await that deferred rather than calling
 * close again, and bookkeeping is dropped against it. That boundary is what
 * makes `Replacement.sequential()`'s exclusivity sound.
 */
export interface Finalization {
  /**
   * Initiate (or join) the dedicated close of one generation's Scope. The
   * returned Effect completes only when that generation's finalizers have
   * fully run.
   *
   * The `closing` deferred is claimed when this function is **called**, not
   * when the returned Effect runs, and every caller calls it under the
   * controller's mutex. Claiming it inside the Effect would leave it unclaimed
   * until the fiber the caller forks took its first step — and a caller that
   * forks the close and then releases the mutex (a failed startup) would let
   * `settled` report the controller converged while that generation's partial
   * resources had not begun finalizing.
   */
  readonly closeInstance: (
    inst: LiveInstance,
    exit: Exit.Exit<unknown, unknown>
  ) => Effect.Effect<void>
  /**
   * Close a retired generation and, once ITS finalization boundary is
   * reached, drop its bookkeeping and wake the reconciler. The fiber is forked
   * uninterruptible so that controller shutdown awaits these finalizers
   * instead of abandoning them.
   */
  readonly beginStop: (inst: LiveInstance) => Effect.Effect<void>
}

export const makeFinalization = (options: {
  readonly live: LiveState
  /** Where stop fibers live: the controller's own Scope. */
  readonly rootScope: Scope.Closeable
  /** The controller's serialization mutex: bookkeeping runs under it. */
  readonly mutex: Semaphore.Semaphore
  readonly wakeUp: Effect.Effect<void>
  /**
   * Called under the mutex for each generation dropped, once its finalization
   * boundary is genuinely reached. This is the only place that boundary is
   * known, which is why the controller's `Stopped` accounting is a callback
   * from here rather than something it could observe for itself.
   */
  readonly onStopped: (inst: LiveInstance) => void
}): Finalization => {
  const { live, mutex, onStopped, rootScope, wakeUp } = options
  const serialized = mutex.withPermits(1)

  const closeInstance = (
    inst: LiveInstance,
    exit: Exit.Exit<unknown, unknown>
  ): Effect.Effect<void> => {
    if (inst.closing !== null) return Deferred.await(inst.closing)
    const done = Deferred.makeUnsafe<void>()
    inst.closing = done
    return pipe(
      Scope.close(inst.scope, exit),
      Effect.ensuring(Deferred.succeed(done, void 0)),
      Effect.asVoid
    )
  }

  /**
   * The part of the subtree whose finalization this generation's close
   * actually covers. A descendant with its own dedicated close in flight is
   * skipped: the ancestor's Scope-close does not await it, and that
   * descendant's own close fiber does its own bookkeeping.
   */
  const ownedSubtree = (inst: LiveInstance, acc: Array<LiveInstance>): Array<LiveInstance> => {
    acc.push(inst)
    for (const child of inst.children) {
      if (child.closing === null) ownedSubtree(child, acc)
    }
    return acc
  }

  const beginStop = (inst: LiveInstance): Effect.Effect<void> =>
    pipe(
      closeInstance(inst, Exit.void),
      Effect.ensuring(
        pipe(
          serialized(
            Effect.sync(() => {
              for (const stopped of ownedSubtree(inst, [])) {
                forget(live, stopped)
                onStopped(stopped)
              }
            })
          ),
          Effect.andThen(wakeUp)
        )
      ),
      // Uninterruptible as a fork *option*, not as a mask around the effect:
      // a fork does not start immediately, so masking the effect would leave a
      // window in which the fresh fiber is still plainly interruptible and a
      // root-Scope close could abandon it before it ever entered the mask.
      Effect.forkIn(rootScope, { uninterruptible: true }),
      Effect.asVoid
    )

  return { closeInstance, beginStop }
}
