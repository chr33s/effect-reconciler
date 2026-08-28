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

export type DefinitionError =
  | ForeignOwner
  | OwnershipCycle
  | ForeignRequirement
  | CapabilityCycle
  | AmbiguousProvider
  | UnresolvableProvider

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

export type BindingError =
  | ForeignHandle
  | MissingBinding
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
