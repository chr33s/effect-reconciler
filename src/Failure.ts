import type * as Cause from "effect/Cause"
import type { LifetimeRef } from "./LifetimeRef.js"

/**
 * A desired lifetime whose startup failed.
 *
 * This is the narrow observation a control plane needs to surface states such
 * as "language server failed" or "connection failed" in its own model. It
 * names the lifetime semantically — family handle, key and owner path — and
 * exposes no physical generation, Scope, Fiber, Context or reconciliation
 * internals, so an application cannot come to depend on runtime identity. The
 * same reference is what `Controller.retry` and `Controller.status` take.
 *
 * Only failures of lifetimes whose desire is still current are reported: a
 * generation that was already superseded or obsoleted when it failed is not an
 * application-visible failure.
 *
 * **Delivery is best effort.** The stream is live-only and bounded: with no
 * subscriber attached nothing is retained, and a subscriber that falls far
 * enough behind loses the oldest events rather than blocking reconciliation.
 * `Controller.status` is the authoritative answer to "is this lifetime
 * Failed?", so application state that depends on failure stays discoverable
 * even when a notification is missed.
 */
export interface LifetimeFailure {
  /** Which semantic lifetime failed to start. */
  readonly lifetime: LifetimeRef
  /** Why startup failed. */
  readonly cause: Cause.Cause<unknown>
}
