import type { AnyHandle, KeyOf, OwnerOf } from "./Definition.js"

/**
 * A pure semantic reference to one keyed lifetime.
 *
 * Semantic identity is `family + semantic key + semantic owner path`, so a
 * reference carries all three: the opaque family handle (the authoritative
 * identity — the string name is only a label, and two families may share one),
 * the semantic key, and the chain of owner references up to the root.
 *
 * This is the vocabulary every semantic API speaks: owned selectors receive
 * one for their owner, failures name the lifetime that failed, and `retry` and
 * `status` take one. It deliberately exposes no Scope, Fiber, Context,
 * physical generation, reconcile revision or live slot, so applications cannot
 * come to depend on runtime internals.
 *
 * The owner link is named `parent` rather than `owner` because selectors
 * receive the reference *as* their owner: `owner.parent.key` reads as the
 * ownership chain it is, where `owner.owner.key` would not.
 */
export interface LifetimeRef<H extends AnyHandle = AnyHandle> {
  /** The family handle: the authoritative identity, with `name` for display. */
  readonly family: H
  /** The semantic key of this instance. */
  readonly key: KeyOf<H>
  /** The owning instance's reference, or `null` at the root of the tree. */
  readonly parent: OwnerOf<H>
}
