import type * as Schedule from "effect/Schedule"

/**
 * What the runtime does about a lifetime whose **startup failed**.
 *
 * The narrowness is deliberate. A lifetime *is* its Scope: once `start`
 * returns, the lifetime is Running, and whatever fibers it forked inside its
 * own Scope are its own business — supervising those is what `Effect.retry`,
 * `Schedule` and the rest of Effect are already for, inside `start`, where
 * the code that knows what failed lives. The one thing the application cannot
 * express for itself is the *other* case: a startup that never completed, in
 * a slot the runtime owns, under a semantic key the runtime assigned. That is
 * the only thing a policy here decides.
 *
 * A policy never changes semantic identity. It does exactly what
 * `Controller.retry` does — retire the failed generation so a fresh one may
 * be admitted under the same key when owner and provider conditions permit —
 * on a schedule instead of on a call.
 */
export type SupervisionPolicy =
  | { readonly _tag: "Manual" }
  | { readonly _tag: "Restart"; readonly schedule: Schedule.Schedule<unknown, unknown> }

/**
 * A failed generation holds its slot until desire changes or
 * `Controller.retry` retires it. **This is the default**, and it stays the
 * default: a runtime that retries by itself turns a configuration error into
 * an infinite loop of connection attempts that nobody asked for, and the
 * application that wants that should have to say so.
 */
export const manual = (): SupervisionPolicy => ({ _tag: "Manual" })

/**
 * Retire a failed generation and let a fresh one be admitted, on `schedule`.
 *
 * The schedule is driven per semantic identity, and its state resets whenever
 * the question it is answering changes:
 *
 * - the lifetime reaches Running — the next failure starts a fresh backoff,
 *   not wherever the last one left off;
 * - its desire is withdrawn, or its owner or a provider replaces it — the
 *   generation that failed is gone, and so is the count of how often it did;
 * - `Controller.retry` is called for it — a person or a control plane just
 *   said "try now", which is a decision the backoff must not then ignore.
 *
 * When the schedule is exhausted the runtime stops, and the generation stays
 * Failed. That is a state, not a dead end: `status` reports it, `retry` still
 * works, and changing desire still replaces it.
 *
 * ```ts
 * import { Schedule } from "effect"
 * import { Supervision } from "effect-reconciler"
 *
 * // Back off exponentially, and give up after five attempts.
 * supervision: Supervision.restart(
 *   Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 5 }))
 * )
 * ```
 *
 * The schedule may require no services and may not fail: a policy is
 * declarative configuration attached to a Definition, and a Definition is
 * state- and environment-independent (spec §4.4). Every schedule Effect ships
 * — `exponential`, `spaced`, `fibonacci`, `recurs` and their combinators —
 * satisfies that.
 */
export const restart = <Output>(
  schedule: Schedule.Schedule<Output, unknown, never, never>
): SupervisionPolicy => ({
  _tag: "Restart",
  schedule: schedule as unknown as Schedule.Schedule<unknown, unknown>
})
