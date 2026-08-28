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
  /** The key this selector had in the Binding record, for diagnostics. */
  readonly label: string
  readonly handle: AnyHandle
  readonly cardinality: "one" | "many"
  readonly selector: (state: State, owner: unknown) => unknown
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
 * environment (§60); `Reconciler.make` asks the caller for exactly those.
 */
export interface Binding<in State, out RootR = never> {
  readonly source: DefinitionSource
  readonly entries: ReadonlyArray<BindingEntry<State>>
  readonly _rootRequires?: RootR
}
