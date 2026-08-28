/**
 * Solid bindings over the mirror.
 *
 * Materially simpler than the React side, and for reasons worth naming: Solid
 * has no StrictMode double-invocation, no concurrent rendering and so no
 * tearing, and its reactive graph is fine-grained — a status change re-runs
 * the one computation that read it rather than a component body. What remains
 * is the same three operations: commit state, read a status, retry.
 *
 * The reference argument is an accessor so a component can follow a changing
 * lifetime (`() => connectionRef(host())`) without rebuilding the primitive.
 *
 * Written against Solid 2.0, whose reactivity differs from 1.x in three ways
 * that matter to an adapter like this one:
 *
 * 1. **`createEffect` is a compute/apply split.** The compute phase tracks and
 *    names the dependency; the apply phase is untracked and does the side
 *    effect. That is precisely what `on(dep, fn)` expressed in 1.x, so the
 *    `on` helper is gone and its job is now the first argument.
 * 2. **The apply phase returns its own cleanup**, run before the next apply
 *    and on disposal — so unwatching no longer needs `onCleanup`, which 2.0
 *    reserves for cleanup tied to a reactive run inside a computation.
 * 3. **Writes from inside an owned scope are refused** unless the signal opts
 *    in. A signal a primitive both owns and writes is exactly the narrow case
 *    `{ ownedWrite: true }` exists for.
 *
 * One 2.0 behaviour a *caller* has to know: a write is visible to reads only
 * after the queue flushes (the next microtask, or `flush()`). Nothing here
 * flushes on the caller's behalf; a component never notices, and a test does.
 */
import { Equal } from "effect"
import type { Option } from "effect"
import { createEffect, createSignal, untrack, type Accessor } from "solid-js"
import type { LifetimeRef } from "../../src/LifetimeRef.js"
import type { LifetimeStatus } from "../../src/Status.js"
import type { Mirror, StatusMirror } from "./mirror.js"

/**
 * The runtime's current answer for one lifetime, as a signal. Watching is tied
 * to the owning computation, so a component that stops rendering a lifetime
 * stops the mirror re-reading it.
 *
 * The signal keeps 2.0's default reference equality, which is only correct
 * because the mirror returns the *same* status object while nothing has
 * changed — the same property the React side depends on for `getSnapshot`.
 */
export const createLifetimeStatus = (
  mirror: StatusMirror,
  ref: Accessor<LifetimeRef>
): Accessor<Option.Option<LifetimeStatus>> => {
  // `untrack` because the seed is a read, not a subscription: the effect below
  // owns the dependency on `ref`, and 2.0 objects to a bare reactive read here.
  const [status, setStatus] = createSignal<Option.Option<LifetimeStatus>>(
    untrack(() => mirror.statusOf(ref())),
    { ownedWrite: true }
  )

  createEffect(ref, (current) => {
    const read = () => setStatus(() => mirror.statusOf(current))
    read()
    // Unwatch on the next reference and on disposal, in one return.
    return mirror.watch(current, read)
  })

  return status
}

/** The status tag as a plain string, for components that only branch on it. */
export const createLifetimeTag = (
  mirror: StatusMirror,
  ref: Accessor<LifetimeRef>
): Accessor<LifetimeStatus["_tag"] | "None"> => {
  const status = createLifetimeStatus(mirror, ref)
  return () => {
    const current = status()
    return current._tag === "None" ? "None" : current.value._tag
  }
}

/**
 * Publish this state as the desired state whenever it changes. The compute
 * phase is the dependency and the apply phase is the commit, which is the
 * whole of what this adapter has to say about scheduling.
 */
export const commitState = <State>(mirror: Mirror<State>, state: Accessor<State>): void => {
  createEffect(state, (current) => mirror.commit(current))
}

/** Kept for symmetry with the React side; Solid components can call the
 * mirror directly, and `Equal` is what makes an inline reference cheap. */
export const sameLifetime = (a: LifetimeRef, b: LifetimeRef): boolean => Equal.equals(a, b)
