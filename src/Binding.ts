import type * as Option from "effect/Option"
import type { AnyHandle, DefinitionSource, ManyHandle, OneHandle } from "./Definition.js"

/**
 * One bound selector: a pure mapping from control state (and, for owned
 * families, the desired owner key) to the desired key(s) of one family.
 *
 * Selectors describe desire. They must not perform Effects, read mutable
 * runtime state, or inspect live physical generations.
 */
export interface BindingEntry<in State> {
  readonly handle: AnyHandle
  readonly cardinality: "one" | "many"
  readonly selector: (state: State, ownerKey: unknown) => unknown
}

export interface BindApi<in out State> {
  /** Bind a `one` family: `None` means absent, `Some(k)` means desired. */
  readonly one: <K, OK>(
    handle: OneHandle<K, OK, any, any, any>,
    selector: (state: State, ownerKey: OK) => Option.Option<K>
  ) => BindingEntry<State>
  /** Bind a `many` family: each returned key is desired independently. */
  readonly many: <K, OK>(
    handle: ManyHandle<K, OK, any, any, any>,
    selector: (state: State, ownerKey: OK) => Iterable<K>
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
