import type * as Option from "effect/Option"
import type { LifetimeRef } from "./LifetimeRef.js"
import type { LifetimeStatus } from "./Status.js"

/**
 * One live lifetime, as a snapshot reports it: the same semantic pair
 * `Controller.status` answers with, for one identity.
 */
export interface LifetimeEntry {
  readonly lifetime: LifetimeRef
  readonly status: LifetimeStatus
}

/**
 * Everything the runtime currently knows, read at one instant.
 *
 * A snapshot is `status` for the whole tree at once, and it is exactly that —
 * it adds no vocabulary. Every entry is a `(LifetimeRef, LifetimeStatus)`
 * pair, the same two things a single `status` call produces, so nothing here
 * is observable that was not observable before (spec §9.4). What it adds is
 * *coherence*: N separate `status` calls interleave with N-1 opportunities
 * for the runtime to move underneath them, and a tree assembled from them can
 * show a child Running beneath an owner that has already stopped. A snapshot
 * is taken under the same mutex reconciliation mutates under, so it cannot.
 *
 * That is what makes it the right input for anything that renders the whole
 * tree — a DevTools panel, a health endpoint, a test assertion about the
 * shape of the world rather than about one lifetime.
 *
 * It is a value, not a view: it does not update, and holding one costs one
 * array of small records. Take another when `Controller.changes` says
 * something moved.
 */
export interface Snapshot {
  /**
   * Every generation the runtime is tracking, owners before their children,
   * so a renderer can build a tree in one pass without sorting.
   *
   * This includes generations that are `Stopping` — no longer current, not
   * yet finalized. They exist, and a view that omitted them would show a slot
   * as free while the resource in it is still draining.
   */
  readonly lifetimes: ReadonlyArray<LifetimeEntry>
  /**
   * The status of one lifetime as of this instant. Equivalent to
   * `Controller.status` at the moment the snapshot was taken, without taking
   * the mutex again.
   */
  readonly get: (ref: LifetimeRef) => Option.Option<LifetimeStatus>
}
