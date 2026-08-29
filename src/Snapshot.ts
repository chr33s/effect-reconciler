import type * as Option from "effect/Option"
import type { LifetimeRef } from "./LifetimeRef.js"
import type { LifetimeStatus } from "./Status.js"

/**
 * Which physical generation an entry is.
 *
 * Semantic identity — the `LifetimeRef` — is deliberately not unique among
 * live generations, because two of them can exist at once: a `Stopping`
 * generation draining beside the `Running` one that replaced it under
 * `Replacement.overlap()`. They are one lifetime and two entries, and nothing
 * in a `LifetimeRef` tells them apart, which is precisely what a tree
 * renderer needs to do before it can place their children.
 *
 * It is opaque and comparable only with `===`. Tokens are distinct across
 * Controllers as well as within one, so a consumer holding entries from a
 * parent and from a nested child cannot confuse one generation for another.
 * It is not a generation *number*: nothing about it says which of two
 * generations came first, or how many there have been, because nothing in the
 * runtime's vocabulary should invite those questions (§9.4). It is not stable
 * across processes and is not meant to be stored.
 */
export type GenerationId = number & { readonly generation: unique symbol }

/**
 * One live lifetime, as a snapshot reports it: the same semantic pair
 * `Controller.status` answers with, plus which generation is being reported
 * and which generation owns it.
 */
export interface LifetimeEntry {
  readonly lifetime: LifetimeRef
  readonly status: LifetimeStatus
  /** This entry's physical generation. */
  readonly generation: GenerationId
  /**
   * The generation that owns this one, or `null` at a root.
   *
   * This names an *entry*, not an identity, and that is the whole point:
   * `lifetime.parent` names the owning lifetime, which may have two
   * generations in this same snapshot. Grouping children by `owner` places
   * each one under the exact generation it belongs to; grouping them by the
   * owner's `LifetimeRef` draws every child under both.
   *
   * An owner can be absent from `lifetimes` even so: a generation whose close
   * has finished is forgotten while a child with its own close in flight is
   * dropped later by its own fiber. A renderer that finds no entry for an
   * `owner` should draw the child at the root rather than lose it.
   */
  readonly owner: GenerationId | null
}

/**
 * Everything the runtime currently knows, read at one instant.
 *
 * A snapshot is `status` for the whole tree at once, and it adds almost no
 * vocabulary: every entry is the `(LifetimeRef, LifetimeStatus)` pair a single
 * `status` call produces, plus the generation tokens above, which say only
 * *that* two entries are different generations and never anything about what
 * a generation is. So nothing here is observable that was not observable
 * before (spec §9.4). What it adds is *coherence*: N separate `status` calls
 * interleave with N-1 opportunities for the runtime to move underneath them,
 * and a tree assembled from them can show a child Running beneath an owner
 * that has already stopped. A snapshot is taken under the same mutex
 * reconciliation mutates under, so it cannot.
 *
 * That is what makes it the right input for anything that renders the whole
 * tree — a DevTools panel, a health endpoint, a test assertion about the
 * shape of the world rather than about one lifetime.
 *
 * It is a value, not a view: it does not update. Holding one costs its
 * `lifetimes` array and one pointer per generation beside it — the hash index
 * behind `get` is built on the first lookup, and never at all for a snapshot
 * that is only rendered. Take another when `Controller.changes` says something
 * moved.
 */
export interface Snapshot {
  /**
   * Every generation the runtime is tracking, owners before their children,
   * so a renderer can build a tree in one pass without sorting.
   *
   * This includes generations that are `Stopping` — no longer current, not
   * yet finalized. They exist, and a view that omitted them would show a slot
   * as free while the resource in it is still draining. Where such a
   * generation coexists with its replacement, both are here, told apart by
   * `generation`.
   */
  readonly lifetimes: ReadonlyArray<LifetimeEntry>
  /**
   * The status of one lifetime as of this instant: the answer
   * `Controller.status` would have given at the moment the snapshot was
   * taken, without taking the mutex again. Like `status`, it answers for the
   * generation currently holding the identity, falling back to one that is
   * still draining.
   *
   * A reference naming a family from another Definition **throws
   * `ForeignLifetimeRef` synchronously**. `status` raises the same thing, but
   * as an Effect defect, because it is an Effect; this is a plain function, so
   * it lands in the caller's stack — a render pass, say — instead. It is
   * still the same programming error and still unrecoverable: a reference from
   * another Definition cannot name anything here, and answering `None` would
   * be indistinguishable from "not running" and quietly wrong.
   */
  readonly get: (ref: LifetimeRef) => Option.Option<LifetimeStatus>
}
