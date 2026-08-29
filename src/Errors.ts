import * as Data from "effect/Data"
import type { AnyHandle } from "./Definition.js"

/**
 * Expected failures are Effect-style tagged data, so recovery is ordinary
 * `Effect.catchTag` / `catchTags` work rather than string inspection. Message
 * formatting is presentation; these values carry structure.
 *
 * Impossible states caused by a bug in this package are defects, not errors in
 * these unions.
 */

// -----------------------------------------------------------------------------
// Definition errors — the static architecture is not well formed
// -----------------------------------------------------------------------------

/** `owner` is not a lifetime handle from this Definition. */
export class ForeignOwner extends Data.TaggedError("ForeignOwner")<{
  readonly family: AnyHandle
}> {}

/** A family's owner chain refers back to the family itself. */
export class OwnershipCycle extends Data.TaggedError("OwnershipCycle")<{
  readonly family: AnyHandle
}> {}

/** A named requirement is not a lifetime handle from this Definition. */
export class ForeignRequirement extends Data.TaggedError("ForeignRequirement")<{
  readonly family: AnyHandle
  readonly requirement: string
}> {}

/** A family requires itself, or a family defined after it. */
export class CapabilityCycle extends Data.TaggedError("CapabilityCycle")<{
  readonly family: AnyHandle
  readonly requirement: string
  readonly provider: AnyHandle
}> {}

/** The provider family has `many` cardinality, so "which one" has no answer. */
export class AmbiguousProvider extends Data.TaggedError("AmbiguousProvider")<{
  readonly family: AnyHandle
  readonly requirement: string
  readonly provider: AnyHandle
}> {}

/** The provider is neither an ancestor nor owned by an ancestor or the root. */
export class UnresolvableProvider extends Data.TaggedError("UnresolvableProvider")<{
  readonly family: AnyHandle
  readonly requirement: string
  readonly provider: AnyHandle
}> {}

/**
 * A family's `start` declared that it reads projected state, but the family
 * did not declare `observes`, so there would be nothing to hand it.
 *
 * The declaration is `Reconciler.requiresObservation`, and it has to be a
 * declaration because nothing else decides it. The type system cannot: with
 * no `observes` there is nothing for the observed type to be inferred from,
 * the parameter's type collapses to `never`, and `never` satisfies every
 * annotation a `start` could give it. Nor can the function's arity: a `start`
 * is free to declare a second parameter it ignores — a two-parameter helper
 * reused as `start` is a perfectly good family — and arity is blind to rest
 * and defaulted parameters in the other direction. Settling it here, on what
 * the function's own author said, is what keeps the mistake from surfacing as
 * a `TypeError` inside a startup Effect that names neither the family nor the
 * declaration it is missing.
 *
 * `Reconciler.nested` is the common way to reach it: it marks its own `start`,
 * so a nested Reconciler always needs `observes: Reconciler.observed<SubState>()`
 * beside it.
 */
export class ObservationRequired extends Data.TaggedError("ObservationRequired")<{
  readonly family: AnyHandle
}> {}

export type DefinitionError =
  | ForeignOwner
  | OwnershipCycle
  | ForeignRequirement
  | CapabilityCycle
  | AmbiguousProvider
  | UnresolvableProvider
  | ObservationRequired

// -----------------------------------------------------------------------------
// Binding errors — the Binding does not match the Definition
// -----------------------------------------------------------------------------

/** A bound handle does not belong to the Definition being bound. */
export class ForeignHandle extends Data.TaggedError("ForeignHandle")<{
  readonly label: string
}> {}

/** A family of the Definition has no selector. */
export class MissingBinding extends Data.TaggedError("MissingBinding")<{
  readonly family: AnyHandle
}> {}

/** Two selectors bind the same family. */
export class DuplicateBinding extends Data.TaggedError("DuplicateBinding")<{
  readonly family: AnyHandle
}> {}

/** `bind.one` used for a `many` family, or the reverse. */
export class CardinalityMismatch extends Data.TaggedError("CardinalityMismatch")<{
  readonly family: AnyHandle
  readonly declared: "one" | "many"
  readonly used: "one" | "many"
}> {}

/**
 * A family declared `observes`, so it needs projected state, and its selector
 * did not say how to project it. Reported here rather than left to produce a
 * `SubscriptionRef` of `undefined` at runtime: it is a structural fact about
 * the Binding, and structural facts are settled once, at `Reconciler.make`.
 */
export class MissingObservation extends Data.TaggedError("MissingObservation")<{
  readonly family: AnyHandle
}> {}

/**
 * A selector supplied a projection for a family that does not observe
 * anything, so nothing would ever have read it.
 *
 * The sibling of `MissingObservation`, and reported for the same reason: the
 * type system can require a projection where one is declared, but it cannot
 * reliably forbid one where none is — a family that declares no `observes`
 * leaves nothing for the type of `observe` to be inferred from. Rather than
 * let the mistake pass silently, the Binding compiler settles it.
 */
export class UnexpectedObservation extends Data.TaggedError("UnexpectedObservation")<{
  readonly family: AnyHandle
}> {}

export type BindingError =
  | ForeignHandle
  | MissingBinding
  | MissingObservation
  | UnexpectedObservation
  | DuplicateBinding
  | CardinalityMismatch

// -----------------------------------------------------------------------------
// Commit errors — this state cannot become desire
// -----------------------------------------------------------------------------

/** The Controller has been shut down; commits are no longer accepted. */
export class ControllerClosed extends Data.TaggedError("ControllerClosed")<{}> {}

/** A `many` selector produced the same semantic key twice. */
export class DuplicateDesiredKey extends Data.TaggedError("DuplicateDesiredKey")<{
  readonly family: AnyHandle
  readonly key: unknown
}> {}

/** A selector returned something other than the shape its cardinality requires. */
export class InvalidSelectorResult extends Data.TaggedError("InvalidSelectorResult")<{
  readonly family: AnyHandle
  readonly expected: "Option" | "Iterable"
}> {}

/** A selector threw. Selectors are pure functions of state; this is a bug in
 * the application, surfaced rather than swallowed. */
export class SelectorFailed extends Data.TaggedError("SelectorFailed")<{
  readonly family: AnyHandle
  readonly error: unknown
}> {}

export type InvalidDesiredStateReason =
  | DuplicateDesiredKey
  | InvalidSelectorResult
  | SelectorFailed

/**
 * A commit produced a dynamically invalid desired snapshot. The previous
 * desired snapshot remains authoritative.
 */
export class InvalidDesiredState extends Data.TaggedError("InvalidDesiredState")<{
  readonly reason: InvalidDesiredStateReason
}> {}

export type CommitError = ControllerClosed | InvalidDesiredState

// -----------------------------------------------------------------------------
// Defects — programming errors, raised rather than returned
// -----------------------------------------------------------------------------

/**
 * A `LifetimeRef` handed to `status` or `retry` names a family from a different
 * Definition, so it cannot name anything in this Controller.
 *
 * This is raised as a *defect*, not returned in an error channel: no Controller
 * can act on it and no caller can recover from it. It is tagged data rather
 * than a bare `Error` so that a test — or a defect handler — can identify it
 * without matching on a message string.
 */
export class ForeignLifetimeRef extends Data.TaggedError("ForeignLifetimeRef")<{
  readonly family: unknown
}> {}
