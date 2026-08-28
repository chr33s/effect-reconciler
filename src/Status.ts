import type * as Cause from "effect/Cause"

/**
 * What the runtime can say about one semantic lifetime, in the application's
 * own vocabulary.
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
  /** The current desired snapshot does not ask for this lifetime. */
  | { readonly _tag: "NotDesired" }
  /**
   * Desired, but not admitted: its owner or a required provider is not
   * Running yet, or a superseded generation in its slot has not finished
   * finalizing.
   */
  | { readonly _tag: "Pending" }
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
