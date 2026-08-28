import type * as Cause from "effect/Cause"

/**
 * What the runtime can say about one semantic lifetime, in the application's
 * own vocabulary.
 *
 * `Controller.status` returns this inside an `Option`: `None` means no
 * physical generation exists for that semantic identity — either it is not
 * desired, or it is desired and not yet admitted because its owner or a
 * provider is not Running, or a superseded generation still holds its slot.
 * What the application asked for is in the application's own state; the
 * runtime reports what exists.
 *
 * This is the authoritative answer to "why is this desired resource
 * unavailable?", "which semantic lifetime is Failed?" and "is this lifetime
 * Running?". Failure *notifications* are a live convenience and may be missed;
 * this query cannot be, so application state that depends on failure stays
 * discoverable.
 *
 * It deliberately says nothing about physical generation numbers, Fibers,
 * Scopes, Contexts, desired revisions, reconcile ordering or slot state.
 */
export type LifetimeStatus =
  /** Admitted; its startup Effect is running. */
  | { readonly _tag: "Starting" }
  /** Startup completed; it provides its capabilities and may own children. */
  | { readonly _tag: "Running" }
  /**
   * Startup failed. The generation keeps its slot until desire changes or
   * `Controller.retry` retires it.
   */
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> }
  /** No longer desired, and still finalizing. */
  | { readonly _tag: "Stopping" }
