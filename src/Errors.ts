import * as Data from "effect/Data"

/** A structural invariant of the Definition is violated (unknown owners,
 * unresolvable or ambiguous requirements, cross-definition handle use, ...).
 * Raised when the Definition is compiled by `Reconciler.make`. */
export class DefinitionError extends Data.TaggedError("DefinitionError")<{
  readonly reason: string
}> {}

/** The Binding does not match the Definition (missing/duplicate bindings,
 * one/many mismatch, foreign handles). Raised by `Reconciler.make`. */
export class BindingError extends Data.TaggedError("BindingError")<{
  readonly reason: string
}> {}

/** The Controller has been shut down; commits are no longer accepted. */
export class ControllerClosed extends Data.TaggedError("ControllerClosed")<{}> {}

/** A commit produced a dynamically invalid desired snapshot (duplicate keys
 * from a `many` selector, invalid selector result, ...). The previous desired
 * snapshot remains authoritative. */
export class InvalidDesiredState extends Data.TaggedError("InvalidDesiredState")<{
  readonly reason: string
}> {}

export type CommitError = ControllerClosed | InvalidDesiredState
