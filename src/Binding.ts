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
  /**
   * Optional: what this selector reads. When present, the runtime evaluates
   * the selector for a given owner only when this value differs — by
   * `Equal.equals` — from what it was at the previous commit for that same
   * owner. See `IncrementalOptions.deps`.
   */
  readonly deps?: ((state: State, owner: unknown) => unknown) | undefined
  /**
   * Required for a family that declared `observes`: how to project the shape
   * it needs out of this Binding's state. Evaluated per owner on every
   * commit, exactly like a selector, and compared with `Equal.equals` so an
   * unchanged projection is not republished.
   */
  readonly observe?: ((state: State, owner: unknown) => unknown) | undefined
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

/**
 * Opt-in incrementality for one selector.
 *
 * Binding evaluation is O(N) per commit by default, and deliberately: a full
 * sweep is simple and provably correct, and at the scales this runtime is
 * built for it costs under a millisecond (spec §15). It stops being free when
 * a family is owned by a `many` family, because then its selector runs once
 * per live owner — ten thousand documents means ten thousand calls, on every
 * commit, most of which return exactly what they returned last time.
 *
 * `deps` is how a Binding says what a selector actually reads, so the runtime
 * can tell those commits apart from the ones that matter.
 */
export interface IncrementalOptions<in State, in Own> {
  /**
   * The part of the state this selector depends on, for this owner.
   *
   * Compared with `Equal.equals` against the previous commit's value for the
   * same owner identity; equal means the selector is not called and its
   * previous keys are reused. So the contract is a real one, and it is the
   * caller's to keep:
   *
   * > If `deps` is unchanged, the selector must return the same keys.
   *
   * Break it and the runtime will not notice — it will keep the stale keys,
   * and a lifetime will not start or stop when it should. That is why this is
   * opt-in and why the default sweep re-reads everything: correctness never
   * depends on a cache the runtime cannot check (spec §15).
   *
   * Returning a value built fresh each commit (`{ a, b }`, `[x, y]`) is fine
   * — `Equal.equals` is structural — but returning something compared by
   * reference that is rebuilt every time simply disables the optimization
   * rather than breaking it.
   */
  readonly deps: (state: State, owner: Own) => unknown
}

/**
 * How this Binding projects the state a family declared it observes. Present
 * — and required — only for such a family, so a Definition that asks for
 * projected state cannot be bound by a Binding that forgot to supply it.
 */
export type ObservationOptions<State, Own, S> = [S] extends [never]
  // A family that observes nothing has nothing to project, and saying so
  // means a stray `observe` is caught rather than silently ignored.
  ? { readonly observe?: never }
  // `S` is `any` when the family did not declare `observes` and inference had
  // no site to resolve it from. Requiring a projection there would demand one
  // from every ordinary family, so this stays permissive and the case is
  // caught where it is always caught anyway: `MissingObservation`, raised at
  // `Reconciler.make` for a family that declared `observes` and was bound
  // without a projection.
  : 0 extends (1 & S) ? { readonly observe?: (state: State, owner: Own) => unknown }
  : { readonly observe: (state: State, owner: Own) => S }

/**
 * The optional third argument to `bind.one` / `bind.many`: incrementality,
 * observation, or both.
 *
 * `observe` is typed as required for a family that declared `observes`, so
 * supplying the options object at all forces the projection to be there and
 * to have the right shape. Omitting the object entirely is caught at
 * `Reconciler.make` instead, as a `MissingObservation` binding error, for the
 * same reason a missing selector is: it is a structural fact about a Binding,
 * and this package reports those together, once, where the Binding is
 * compiled (spec §4.3).
 */
export type SelectorOptions<State, Own, S> =
  & Partial<IncrementalOptions<State, Own>>
  & ObservationOptions<State, Own, S>

export interface BindApi<in out State> {
  /** Bind a `one` family: `None` means absent, `Some(k)` means desired. */
  readonly one: <K, Own, S>(
    handle: OneHandle<K, Own, any, any, any, S>,
    selector: (state: State, owner: Own) => Option.Option<K>,
    // `NoInfer` so the handle alone decides `S`. Left inferring, an options
    // object that says nothing about observation still contributes a
    // candidate, and `S` lands on `any` — which then demands an `observe` for
    // a family that observes nothing.
    options?: SelectorOptions<State, Own, NoInfer<S>>
  ) => BindingEntry<State>
  /** Bind a `many` family: each returned key is desired independently. */
  readonly many: <K, Own, S>(
    handle: ManyHandle<K, Own, any, any, any, S>,
    selector: (state: State, owner: Own) => Iterable<K>,
    options?: SelectorOptions<State, Own, NoInfer<S>>
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
