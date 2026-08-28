import type * as Option from "effect/Option"
import type { AnyHandle, DefinitionSource, ManyHandle, OneHandle } from "./Definition.js"

/**
 * One bound selector: a pure mapping from control state (and, for owned
 * families, the semantic reference of the desired owner) to the desired
 * key(s) of one family.
 *
 * Selectors describe desire. They must not perform Effects, read mutable
 * runtime state, or inspect live physical generations.
 */
export interface BindingEntry<in State> {
  readonly handle: AnyHandle
  readonly cardinality: "one" | "many"
  readonly selector: (state: State, owner: unknown) => unknown
}

/**
 * A bound selector together with the name the application wrote it under in
 * the Binding record — the only name a foreign handle can be reported by.
 * The label belongs to the record, not to the entry, so it is attached where
 * the record is walked rather than left blank at construction.
 */
export interface LabeledEntry<in State> extends BindingEntry<State> {
  readonly label: string
}

export interface BindApi<in out State> {
  /** Bind a `one` family: `None` means absent, `Some(k)` means desired. */
  readonly one: <K, Own>(
    handle: OneHandle<K, Own, any, any, any>,
    selector: (state: State, owner: Own) => Option.Option<K>
  ) => BindingEntry<State>
  /** Bind a `many` family: each returned key is desired independently. */
  readonly many: <K, Own>(
    handle: ManyHandle<K, Own, any, any, any>,
    selector: (state: State, owner: Own) => Iterable<K>
  ) => BindingEntry<State>
}

/**
 * A Binding maps one control-state type into desired instances of a
 * Definition. The same Definition may be bound to any number of state types.
 *
 * `RootR` collects what the Definition's startup Effects require from the root
 * environment (spec §6.2); `Reconciler.make` asks the caller for exactly those.
 */
export interface Binding<in State, out RootR = never> {
  readonly source: DefinitionSource
  readonly entries: ReadonlyArray<LabeledEntry<State>>
  readonly _rootRequires?: RootR
}
