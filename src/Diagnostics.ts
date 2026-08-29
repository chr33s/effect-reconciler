import type * as Cause from "effect/Cause"
import type { LifetimeRef } from "./LifetimeRef.js"

/**
 * Why a generation lost authority. Every retirement has exactly one of these
 * causes, and knowing which is the difference between "my language server
 * restarted" and "my language server restarted *because* the settings
 * lifetime it depends on was replaced".
 */
export type RetirementReason =
  /** Its semantic key is no longer desired by the committed state. */
  | "desire"
  /** Its owner was retired, so it was too — structurally, not by a rule the
   * application wrote (spec §11, ownership closure). */
  | "owner"
  /** A provider instance it captured at admission was retired. */
  | "provider"
  /** `Controller.retry`, or a supervision policy, retired a failed
   * generation so a fresh one could take its place. */
  | "retry"
  /** The Controller is shutting down. */
  | "shutdown"

/**
 * One thing the reconciler did.
 *
 * **This is a diagnostic channel and nothing else.** It is lossy under
 * overflow, retains nothing without a subscriber, and — unlike `status` — can
 * be missed. Deriving application state from it recreates exactly the second
 * source of truth that `failures` is deliberately not allowed to be
 * (spec §13.9). Read it to *understand* the runtime: in a DevTools panel, in
 * a log, in a test that asserts why something restarted. Do not read it to
 * *drive* anything.
 *
 * Events are only produced once someone is subscribed. A Controller nobody is
 * watching allocates nothing for this.
 */
export type ReconcileEvent =
  /** A commit published a new desired snapshot. */
  | { readonly _tag: "Committed"; readonly desired: number }
  /** A generation was admitted and its startup Effect began. */
  | { readonly _tag: "Admitted"; readonly lifetime: LifetimeRef }
  /** Startup completed; the generation is Running and its capabilities are
   * published. */
  | { readonly _tag: "Started"; readonly lifetime: LifetimeRef }
  /** Startup failed. The same cause `status` reports and, when desire is
   * still current, the same one `failures` delivers. */
  | {
    readonly _tag: "StartupFailed"
    readonly lifetime: LifetimeRef
    readonly cause: Cause.Cause<unknown>
  }
  /** A generation lost authority and began stopping. */
  | {
    readonly _tag: "Retired"
    readonly lifetime: LifetimeRef
    readonly reason: RetirementReason
  }
  /** A retired generation reached its finalization boundary and was dropped. */
  | { readonly _tag: "Stopped"; readonly lifetime: LifetimeRef }
  /** A reconcile pass ended. `admitted` and `retired` are what this pass did;
   * `settled` is whether the runtime has now converged on the published
   * desire. */
  | {
    readonly _tag: "PassCompleted"
    readonly admitted: number
    readonly retired: number
    readonly settled: boolean
  }

/** How many generations are in each lifecycle state right now. */
export interface LifetimeCounts {
  readonly starting: number
  readonly running: number
  readonly failed: number
  readonly stopping: number
  readonly total: number
}

/**
 * Everything that has happened since the Controller started, as counters.
 *
 * Counters, unlike events, are always maintained: they are integer
 * increments on paths the reconciler already walks, and they are what a
 * health endpoint, a benchmark or the "reconsider when" trigger in spec §15
 * actually wants. They are cumulative and monotone, so two readings subtract
 * to give a rate.
 */
export interface Diagnostics {
  readonly lifetimes: LifetimeCounts
  /** Commits that were published. A commit rejected as invalid is not one. */
  readonly commits: number
  /** Reconcile passes that ran. Many passes may serve one commit, and one
   * pass may serve many: neither is a bug, and the ratio is worth watching
   * only if it is large and growing. */
  readonly passes: number
  /** Selector evaluations across all commits — the cost spec §15 says to
   * watch, and the one incremental binding exists to reduce. */
  readonly selectorEvaluations: number
  /** Selector evaluations avoided because a binding declared `deps` and they
   * were unchanged. Zero unless incremental bindings are used. */
  readonly selectorEvaluationsSkipped: number
  readonly admitted: number
  readonly started: number
  readonly startupFailures: number
  readonly retired: number
  readonly stopped: number
  /** Retirements performed by `Controller.retry` or a supervision policy. */
  readonly retries: number
  /** Whether the runtime has converged on the published desire: no pass is
   * owed and nothing is starting or finalizing. */
  readonly settled: boolean
}
