import type * as Cause from "effect/Cause"
import type { Owner } from "./Owner.js"

/**
 * A desired lifetime whose startup failed.
 *
 * This is the narrow observation a control plane needs to surface states such
 * as "language server failed" or "connection failed" in its own model. It is
 * purely semantic: the failing family, its semantic key, its owner chain and
 * the failure cause. It exposes no physical generation, Scope, Fiber, Context
 * or reconciliation internals, so an application cannot come to depend on the
 * runtime's internal identity.
 *
 * Only failures of lifetimes whose desire is still current are reported: a
 * generation that was already superseded or obsoleted when it failed is not an
 * application-visible failure.
 */
export interface LifetimeFailure {
  /** The failing family's human-readable name. */
  readonly family: string
  /** The failing instance's semantic key. */
  readonly key: unknown
  /** Its owner chain up to the root, or `null` for a root family. */
  readonly owner: Owner<unknown, unknown> | null
  /** Why startup failed. */
  readonly cause: Cause.Cause<unknown>
}
