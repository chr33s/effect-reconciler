/**
 * A synchronous mirror of Controller status, for UI frameworks.
 *
 * Every framework here needs a *synchronous* read of "what is the status of
 * this lifetime" — `useSyncExternalStore` calls `getSnapshot` during render, a
 * Solid signal is read the same way, and a Lit `render` returns a value rather
 * than awaiting one. `Controller.status` is an Effect that takes the
 * controller's mutex, so it cannot answer during a render. The mirror keeps
 * the answer cached and refreshes it in the background.
 *
 * Two properties make the whole thing work, and both are load-bearing:
 *
 * 1. **`LifetimeRef` is already a valid Effect key.** Two independently built
 *    references to the same lifetime are `Equal` and hash identically, and the
 *    hash is cached on the object (~19 ns). So the cache is an ordinary
 *    `MutableHashMap` keyed by the reference itself — a component can build
 *    the reference inline on every render without memoizing it, and no
 *    UI-specific identity type is needed.
 *
 * 2. **A status read returns the same object while nothing has changed.**
 *    `Option.some({ _tag: "Running" })` allocates a fresh value every time; a
 *    `getSnapshot` that never settles makes React re-render forever. The
 *    mirror replaces a cached status only when `Equal.equals` says it differs.
 *
 * The mirror never calls `Effect.runFork`. Every interaction with the
 * Controller happens on the one fiber it owns; a UI event handler only writes
 * a cell and opens a latch, which is synchronous and safe to call from
 * anywhere. That also means the mirror imposes no runtime of its own on the
 * host application.
 *
 * **Commits coalesce.** A UI can produce state faster than resources can
 * converge, so `commit` records the latest state rather than queueing every
 * one. Committing A then B is indistinguishable from committing B alone:
 * desire is a function of the latest state, which is the same reason the
 * runtime coalesces reconcile passes.
 */
import { Effect, Equal, Latch, MutableHashMap, Option, Semaphore, Stream } from "effect"
import type { CommitError } from "../../src/Errors.js"
import type { LifetimeRef } from "../../src/LifetimeRef.js"
import type { Controller } from "../../src/Reconciler.js"
import type { LifetimeStatus } from "../../src/Status.js"

export interface MirrorOptions {
  /** How often to re-read while something is still converging. */
  readonly activeIntervalMillis?: number
  /** How often to re-read once nothing watched is in transition. */
  readonly idleIntervalMillis?: number
  /**
   * A commit that fails means a selector threw or produced a duplicate key —
   * a bug in the application, not a runtime condition. It is reported here
   * rather than swallowed; the default rethrows on a fresh task so it reaches
   * the host's error reporting instead of dying inside a fiber.
   */
  readonly onCommitError?: (error: CommitError) => void
}

/**
 * The half of a mirror that does not depend on the application's state type.
 * Reading a lifetime's status is state-independent — which is precisely why a
 * component deep in a tree can render one without knowing what the app commits.
 */
export interface StatusMirror {
  /**
   * Watch one lifetime and be told when its status may have changed. Returns
   * the unwatch function, which is exactly the shape `useSyncExternalStore`
   * wants, and what a Solid effect and a Lit controller each return from their
   * own teardown. Only watched lifetimes are polled, so the work is bounded by
   * what is on screen.
   */
  readonly watch: (ref: LifetimeRef, listener: () => void) => () => void
  /** The cached status. Pure: it registers nothing and notifies no one. */
  readonly statusOf: (ref: LifetimeRef) => Option.Option<LifetimeStatus>
  /** Retire a Failed generation so a fresh one may start. Synchronous. */
  readonly retry: (ref: LifetimeRef) => void
  /**
   * Apply everything pending and re-read every watched lifetime. Tests use
   * this instead of sleeping; the background loops call exactly the same
   * effect.
   */
  readonly flush: Effect.Effect<void>
}

export interface Mirror<State> extends StatusMirror {
  /** Record the latest desired state. Synchronous; never awaits convergence. */
  readonly commit: (state: State) => void
}

interface Entry {
  status: Option.Option<LifetimeStatus>
  readonly listeners: Set<() => void>
}

const isTransitional = (status: Option.Option<LifetimeStatus>): boolean =>
  Option.isSome(status) && (status.value._tag === "Starting" || status.value._tag === "Stopping")

export const make = <State>(
  controller: Controller<State>,
  options: MirrorOptions = {}
): Effect.Effect<Mirror<State>, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const activeInterval = options.activeIntervalMillis ?? 25
    const idleInterval = options.idleIntervalMillis ?? 250
    const onCommitError = options.onCommitError ??
      ((error: CommitError) => {
        setTimeout(() => {
          throw error
        })
      })

    const entries = MutableHashMap.empty<LifetimeRef, Entry>()
    // Written by UI handlers, drained by the work loop.
    let pendingState: Option.Option<State> = Option.none()
    let pendingRetries: Array<LifetimeRef> = []
    // True while a commit may still be converging, so polling stays fast even
    // when nothing watched has reached a transitional state yet.
    let settling = false

    const work = yield* Latch.make(false)
    // One refresh at a time: the work loop, the poll loop and the failure
    // stream all drive the same read.
    const exclusive = (yield* Semaphore.make(1)).withPermits(1)

    const requestWork = (): void => {
      Latch.openUnsafe(work)
    }

    const notify = (entry: Entry): void => {
      for (const listener of entry.listeners) listener()
    }

    /** Apply anything a UI handler left behind, then re-read what is watched. */
    const flushOnce: Effect.Effect<void> = Effect.gen(function* () {
      const state = pendingState
      const retries = pendingRetries
      pendingState = Option.none()
      pendingRetries = []

      if (Option.isSome(state)) {
        settling = true
        const committed = yield* Effect.result(controller.commit(state.value))
        if (committed._tag === "Failure") onCommitError(committed.failure)
      }
      for (const ref of retries) {
        settling = true
        yield* Effect.ignore(controller.retry(ref))
      }

      let changed = false
      let transitional = false
      // Snapshot the keys: a component may unwatch while this pass is reading,
      // and refreshing a lifetime nobody watches any more is merely wasted.
      for (const ref of [...MutableHashMap.keys(entries)]) {
        const entry = Option.getOrUndefined(MutableHashMap.get(entries, ref))
        if (entry === undefined) continue
        const next = yield* controller.status(ref)
        transitional = transitional || isTransitional(next)
        if (Equal.equals(entry.status, next)) continue
        entry.status = next
        changed = true
        notify(entry)
      }
      // Quiet: a whole pass with nothing changing and nothing in transition.
      if (settling && !changed && !transitional) settling = false
    })

    const flush = exclusive(flushOnce)

    // The work loop. A UI handler opens the latch; this fiber does the talking.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(work.await, Effect.andThen(work.close, flush))
      )
    )

    // Polling is the v0 change signal: `Controller.failures` reports failures
    // only, and there is no notification for `Starting → Running`. A
    // `Controller.changes` stream would replace this loop entirely.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(
          Effect.suspend(() =>
            Effect.sleep(settling || MutableHashMap.size(entries) === 0 ? activeInterval : idleInterval)
          ),
          flush
        )
      )
    )

    // Failures are taken as a signal, not as a payload: the delivery contract
    // makes `status` authoritative and the stream best-effort, so the mirror
    // re-reads rather than trusting what it was handed.
    yield* Effect.forkScoped(Stream.runForEach(controller.failures, () => flush))

    const statusOf = (ref: LifetimeRef): Option.Option<LifetimeStatus> =>
      Option.match(MutableHashMap.get(entries, ref), {
        onNone: () => Option.none<LifetimeStatus>(),
        onSome: (entry) => entry.status
      })

    const watch = (ref: LifetimeRef, listener: () => void): (() => void) => {
      const existing = MutableHashMap.get(entries, ref)
      const entry = Option.getOrUndefined(existing) ??
        { status: Option.none<LifetimeStatus>(), listeners: new Set<() => void>() }
      if (Option.isNone(existing)) {
        MutableHashMap.set(entries, ref, entry)
        // A newly watched lifetime reads `None` until the first refresh lands,
        // so ask for one now rather than at the next poll.
        requestWork()
      }
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0) MutableHashMap.remove(entries, ref)
      }
    }

    return {
      commit: (state) => {
        pendingState = Option.some(state)
        requestWork()
      },
      watch,
      statusOf,
      retry: (ref) => {
        pendingRetries.push(ref)
        requestWork()
      },
      flush
    }
  })
