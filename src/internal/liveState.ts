import type * as Cause from "effect/Cause"
import type * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Equal from "effect/Equal"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import type * as SubscriptionRef from "effect/SubscriptionRef"
import type { DesiredNode } from "./desiredSnapshot.js"
import type { Ident } from "./identity.js"

/**
 * Where one physical generation stands in its own lifecycle. This is the only
 * encoding of that fact: `stopping` *is* obsolescence, so a generation can
 * never be half-retired the way a separate boolean allowed.
 */
export type Lifecycle = "starting" | "running" | "stopping" | "failed"

/** One physical generation of a keyed lifetime. Semantic identity is the
 * path; physical identity is the object itself. */
export interface LiveInstance {
  /**
   * Physical identity as a value. The object itself is already the physical
   * identity, but nothing outside this process can be handed an object — so
   * anything that has to tell two generations of one semantic lifetime apart
   * (a snapshot's consumers, above all) is given this instead.
   */
  readonly generation: number
  readonly familyId: number
  readonly key: unknown
  /** Structural semantic identity: family, key and owner chain. */
  readonly ident: Ident
  /** Identity of the replacement slot this generation occupies. */
  readonly slot: Ident
  readonly owner: LiveInstance | null
  /** Exact physical provider instances captured at admission. Never rebound. */
  readonly providers: ReadonlyMap<string, LiveInstance>
  readonly scope: Scope.Closeable
  readonly children: Set<LiveInstance>
  /**
   * Instances that captured this one as a provider. The reverse of
   * `providers`, maintained by `track`/`forget` so obsolescence can propagate
   * along the edges it actually travels instead of being rediscovered by
   * repeated sweeps over every instance.
   */
  readonly dependents: Set<LiveInstance>
  status: Lifecycle
  /** Cache of "is this still desired?" for one published snapshot: many
   * reconcile passes run against the same desire. */
  desiredRevision: number
  desiredNode: DesiredNode | undefined
  /** What this generation publishes to its children and dependents. */
  providedContext: Context.Context<never>
  /**
   * The startup environment this generation's children inherit: the root
   * environment, every ancestor's published services and its own. Folded once
   * when the generation starts running, so admitting a child never re-walks
   * the ancestor chain.
   */
  childContext: Context.Context<never>
  /** Why startup failed, for `status`. Set only in the `failed` state. */
  failure: Cause.Cause<unknown> | null
  /**
   * The projected state this generation observes, for families that declared
   * `observes`; `null` for every other family, which is nearly all of them.
   * Held so a pass can tell an unchanged projection from a changed one
   * without asking the ref what it currently contains.
   */
  observed: { ref: SubscriptionRef.SubscriptionRef<unknown>; value: unknown } | null
  /**
   * Set when a dedicated close of this instance's Scope is initiated
   * (obsolescence or startup failure) and completed only when that close has
   * fully run its finalizers. `Scope.close` on an already-closing scope
   * returns immediately, so THIS deferred — not close-call completion — is
   * the finalization boundary the bookkeeping relies on.
   */
  closing: Deferred.Deferred<void> | null
}

export interface Slot {
  current: LiveInstance | undefined
  /** Obsolete generations still finalizing. Sequential replacement waits for
   * this set to drain before admitting the latest desired replacement. */
  readonly retiring: Set<LiveInstance>
}

/**
 * Every generation the controller knows about, indexed the three ways a
 * reconcile pass asks about them: by replacement slot, by semantic identity,
 * and as a whole.
 *
 * These indexes are only ever moved by `track`, `retire` and `forget` below,
 * and lifecycle state only ever changes through those three and
 * `concludeStartup`. Keeping the indexes consistent — and `version` honest
 * about them — is the invariant of this module and of nothing else.
 */
export interface LiveState {
  readonly slots: MutableHashMap.MutableHashMap<Ident, Slot>
  readonly currentByIdent: MutableHashMap.MutableHashMap<Ident, LiveInstance>
  readonly all: Set<LiveInstance>
  /**
   * Counts the transitions that can change what `Controller.status` answers
   * for some semantic identity: a generation tracked, retired, forgotten, or
   * moved between lifecycle states. It is not a revision of anything the
   * application named — only a witness that re-reading `status` could now say
   * something different, which is exactly what `Controller.changes` reports.
   */
  version: number
}

export const makeLiveState = (): LiveState => ({
  slots: MutableHashMap.empty(),
  currentByIdent: MutableHashMap.empty(),
  all: new Set(),
  version: 0
})

/** A generation that has lost authority and is on its way out. */
export const isObsolete = (inst: LiveInstance): boolean => inst.status === "stopping"

/** The generation currently answering for a semantic identity, if any. */
export const currentInstance = (live: LiveState, ident: Ident): LiveInstance | undefined =>
  Option.getOrUndefined(MutableHashMap.get(live.currentByIdent, ident))

/** The replacement slot an instance would compete for, if it exists yet. A
 * slot with no generation in it has nothing to say, so it is never created
 * just to be asked about. */
export const slotOf = (live: LiveState, id: Ident): Slot | undefined =>
  Option.getOrUndefined(MutableHashMap.get(live.slots, id))

const slotFor = (live: LiveState, id: Ident): Slot => {
  const existing = slotOf(live, id)
  if (existing !== undefined) return existing
  const slot: Slot = { current: undefined, retiring: new Set() }
  MutableHashMap.set(live.slots, id, slot)
  return slot
}

/**
 * A generation for `ident` that no longer holds its slot but has not reached
 * its finalization boundary. Found through the slot rather than by scanning
 * every instance: retiring generations leave `currentByIdent`, but they never
 * leave the slot they are draining out of.
 */
export const retiringInstance = (
  live: LiveState,
  slotIdent: Ident,
  ident: Ident
): LiveInstance | undefined => {
  const slot = slotOf(live, slotIdent)
  if (slot === undefined) return undefined
  for (const inst of slot.retiring) {
    if (Equal.equals(inst.ident, ident)) return inst
  }
  return undefined
}

/** Record a freshly admitted generation as the one answering for its identity. */
export const track = (live: LiveState, inst: LiveInstance): void => {
  live.version++
  slotFor(live, inst.slot).current = inst
  MutableHashMap.set(live.currentByIdent, inst.ident, inst)
  live.all.add(inst)
  inst.owner?.children.add(inst)
  for (const provider of inst.providers.values()) provider.dependents.add(inst)
}

/**
 * Take authority away from a generation: it stops satisfying its identity and
 * stops holding its slot, but its finalizers have not run yet. The single
 * retirement transition — obsolescence and `Controller.retry` both go through
 * here, so the replacement policy governs them identically.
 */
export const retire = (live: LiveState, inst: LiveInstance): void => {
  live.version++
  inst.status = "stopping"
  const slot = slotFor(live, inst.slot)
  if (slot.current === inst) slot.current = undefined
  slot.retiring.add(inst)
  if (currentInstance(live, inst.ident) === inst) {
    MutableHashMap.remove(live.currentByIdent, inst.ident)
  }
}

/**
 * The lifecycle transitions a startup completion decides. They move no index
 * — the generation already answers for its identity — but they change what
 * `status` reports about it, so they belong to this module for the same
 * reason the index moves do: it is the only place the observable version is
 * kept honest. Retirement has its own transition above.
 */
export const concludeStartup = (
  live: LiveState,
  inst: LiveInstance,
  status: "running" | "failed"
): void => {
  live.version++
  inst.status = status
}

/** Drop every trace of a generation that has reached its finalization
 * boundary. The inverse of `track` and `retire` together. */
export const forget = (live: LiveState, inst: LiveInstance): void => {
  live.version++
  live.all.delete(inst)
  const slot = slotOf(live, inst.slot)
  if (slot !== undefined) {
    slot.retiring.delete(inst)
    if (slot.current === inst) slot.current = undefined
    if (slot.current === undefined && slot.retiring.size === 0) {
      MutableHashMap.remove(live.slots, inst.slot)
    }
  }
  if (currentInstance(live, inst.ident) === inst) {
    MutableHashMap.remove(live.currentByIdent, inst.ident)
  }
  inst.owner?.children.delete(inst)
  for (const provider of inst.providers.values()) provider.dependents.delete(inst)
}

/**
 * True when no generation is mid-transition: nothing starting, nothing
 * retiring, and no dedicated close still short of its finalization boundary.
 */
export const settled = (live: LiveState): boolean => {
  for (const inst of live.all) {
    if (inst.status === "starting" || inst.status === "stopping") return false
    // A failed generation keeps its `closing` deferred forever; only a close
    // that has not reached its finalization boundary is unsettled.
    if (inst.closing !== null && !Deferred.isDoneUnsafe(inst.closing)) return false
  }
  for (const slot of MutableHashMap.values(live.slots)) {
    if (slot.retiring.size > 0) return false
  }
  return true
}
