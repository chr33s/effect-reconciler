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
 * **Nothing here polls.** The mirror re-reads when `Controller.changes` says
 * reconciliation moved something and at no other time, so an idle screen
 * costs nothing and a transition is reflected as soon as the pass that caused
 * it ends. Because a fresh subscription is prompted once, the mirror cannot
 * be left holding a reading taken before a transition it did not see.
 *
 * **Commits coalesce.** A UI can produce state faster than resources can
 * converge, so `commit` records the latest state rather than queueing every
 * one. Committing A then B is indistinguishable from committing B alone:
 * desire is a function of the latest state, which is the same reason the
 * runtime coalesces reconcile passes.
 */
import { Cause, Effect, Equal, Exit, Latch, MutableHashMap, Option, Semaphore, Stream } from "effect"
import type { CommitError } from "../../src/Errors.js"
import type { LifetimeRef } from "../../src/LifetimeRef.js"
import type { Controller } from "../../src/Reconciler.js"
import type { Snapshot } from "../../src/Snapshot.js"
import type { LifetimeStatus } from "../../src/Status.js"

export interface MirrorOptions {
  /**
   * A commit that fails means a selector threw or produced a duplicate key —
   * a bug in the application, not a runtime condition. It is reported here
   * rather than swallowed; the default rethrows on a fresh task so it reaches
   * the host's error reporting instead of dying inside a fiber.
   */
  readonly onCommitError?: (error: CommitError) => void
  /**
   * A defect raised while reading the Controller — in practice a
   * `ForeignLifetimeRef`, from a component holding a reference built against
   * a different Definition. It is a programming error, not a runtime
   * condition, but it must not take the mirror's work loop with it: one bad
   * reference would otherwise freeze every lifetime on screen at its last
   * reading, silently. The default rethrows on a fresh task, so it reaches
   * the host's error reporting.
   */
  readonly onDefect?: (cause: Cause.Cause<unknown>) => void
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
   * own teardown. Only watched lifetimes are re-read, so a change signal costs
   * what is on screen and nothing more.
   */
  readonly watch: (ref: LifetimeRef, listener: () => void) => () => void
  /** The cached status. Pure: it registers nothing and notifies no one. */
  readonly statusOf: (ref: LifetimeRef) => Option.Option<LifetimeStatus>
  /** Retire a Failed generation so a fresh one may start. Synchronous. */
  readonly retry: (ref: LifetimeRef) => void
  /**
   * Apply everything pending and re-read every watched lifetime. Tests use
   * this instead of sleeping; both background fibers call exactly the same
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

/**
 * One entry's reading, or `undefined` if the reference could not name
 * anything here.
 *
 * `Snapshot.get` throws `ForeignLifetimeRef` synchronously for a reference
 * built against another Definition — it is a plain function, so the defect
 * lands in the caller's stack rather than an Effect's error channel. Caught
 * per entry rather than per flush, so one component's bad reference costs
 * that component its reading and no other component theirs.
 */
const readStatus = (
  snapshot: Snapshot,
  ref: LifetimeRef,
  onDefect: (cause: Cause.Cause<unknown>) => void
): { readonly status: Option.Option<LifetimeStatus> } | undefined => {
  try {
    return { status: snapshot.get(ref) }
  } catch (error) {
    onDefect(Cause.die(error))
    return undefined
  }
}

export const make = <State>(
  controller: Controller<State>,
  options: MirrorOptions = {}
): Effect.Effect<Mirror<State>, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const onCommitError = options.onCommitError ??
      ((error: CommitError) => {
        setTimeout(() => {
          throw error
        })
      })
    const onDefect = options.onDefect ??
      ((cause: Cause.Cause<unknown>) => {
        setTimeout(() => {
          throw Cause.squash(cause)
        })
      })

    const entries = MutableHashMap.empty<LifetimeRef, Entry>()
    // Written by UI handlers, drained by the work loop.
    let pendingState: Option.Option<State> = Option.none()
    let pendingRetries: Array<LifetimeRef> = []

    const work = yield* Latch.make(false)
    // One refresh at a time: the work loop and the change stream drive the
    // same read.
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
        const committed = yield* Effect.result(controller.commit(state.value))
        if (committed._tag === "Failure") onCommitError(committed.failure)
      }
      for (const ref of retries) {
        // `exit`, not `ignore`. A reference built from a handle belonging to
        // another Definition raises `ForeignLifetimeRef` as a *defect*, which
        // `Effect.ignore` does not catch — it would kill this fiber, and every
        // lifetime on screen would freeze at its last reading with nothing to
        // say why. A bad reference is one component's bug; it must not be the
        // whole mirror's.
        const outcome = yield* Effect.exit(controller.retry(ref))
        if (Exit.isFailure(outcome) && Cause.hasDies(outcome.cause)) onDefect(outcome.cause)
        // A `ControllerClosed` failure is teardown, not a fault, and is the
        // one thing `Effect.ignore` was right to swallow.
      }

      // One coherent reading of the whole tree, not N separate `status` calls.
      // The runtime can move between any two of those, so a mirror built on
      // them can hand a component a child that is Running under an owner that
      // has already stopped — which is the incoherence `Controller.snapshot`
      // exists to rule out. It is also one acquisition of the controller's
      // mutex per flush instead of one per watched lifetime.
      const outcome = yield* Effect.exit(controller.snapshot)
      if (Exit.isFailure(outcome)) {
        if (Cause.hasDies(outcome.cause)) onDefect(outcome.cause)
        return
      }
      const snapshot = outcome.value

      // Snapshot the keys: a component may unwatch while this pass is reading,
      // and refreshing a lifetime nobody watches any more is merely wasted.
      for (const ref of [...MutableHashMap.keys(entries)]) {
        const entry = Option.getOrUndefined(MutableHashMap.get(entries, ref))
        if (entry === undefined) continue
        // `get` throws synchronously for a reference from another Definition,
        // for the same reason `status` raises a defect for one. Caught per
        // entry, so one component's bad reference costs that component its
        // reading and no one else theirs.
        const read = readStatus(snapshot, ref, onDefect)
        if (read === undefined) continue
        const next = read.status
        if (Equal.equals(entry.status, next)) continue
        entry.status = next
        notify(entry)
      }
    })

    const flush = exclusive(flushOnce)

    // The work loop. A UI handler opens the latch; this fiber does the talking.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(work.await, Effect.andThen(work.close, flush))
      )
    )

    // The only reason the mirror ever re-reads. The signal carries nothing, so
    // there is no question of trusting what it was handed: it re-reads
    // `status`, which is the authority, exactly when something moved.
    //
    // This subscription also replaces the one the mirror used to keep on
    // `Controller.failures` — a failed startup is a transition like any other
    // and is signalled here, so watching both would only mean flushing twice
    // for one event.
    yield* Effect.forkScoped(Stream.runForEach(controller.changes, () => flush))

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
        // A newly watched lifetime reads `None` until the first refresh
        // lands, and no change signal is owed for a lifetime that did not
        // change — so ask for one now.
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
