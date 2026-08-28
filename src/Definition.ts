import type * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { LifetimeRef } from "./LifetimeRef.js"
import type { ReplacementPolicy } from "./Replacement.js"

export const HandleTypeId: unique symbol = Symbol.for("effect-reconciler/Handle")
export type HandleTypeId = typeof HandleTypeId

/**
 * Opaque handle for a `define.one` lifetime family. The handle itself is the
 * authoritative nominal identity of the family; the string name is a
 * human-readable label.
 *
 * The type parameters carry the family's static contract (§28, §29):
 *
 * - `K` semantic key type, `Own` the owner reference its selector receives
 *   (`null` for root families)
 * - `P` the services this family publishes to its children and dependents
 * - `Env` the services visible to its children: every ancestor's published
 *   services plus its own
 * - `RR` the services its startup still needs from the root environment (§60);
 *   these propagate to `Reconciler.make`.
 */
export interface OneHandle<
  in out K,
  in out Own = null,
  out P = never,
  out Env = never,
  out RR = never
> {
  readonly [HandleTypeId]: "one"
  readonly name: string
  readonly _key?: K
  readonly _owner?: Own
  readonly _provides?: P
  readonly _childEnv?: Env
  readonly _rootRequires?: RR
}

/** Opaque handle for a `define.many` lifetime family. */
export interface ManyHandle<
  in out K,
  in out Own = null,
  out P = never,
  out Env = never,
  out RR = never
> {
  readonly [HandleTypeId]: "many"
  readonly name: string
  readonly _key?: K
  readonly _owner?: Own
  readonly _provides?: P
  readonly _childEnv?: Env
  readonly _rootRequires?: RR
}

export type AnyHandle =
  | OneHandle<any, any, any, any, any>
  | ManyHandle<any, any, any, any, any>

// The type extractors below must spell out every parameter with `infer`: an
// `any` in an invariant position (`K`, `OK`) makes the extends-check fail
// against handles whose owner key is `never`, silently yielding `never`.

export type KeyOf<H> = H extends OneHandle<infer K, infer _Own, infer _P, infer _E, infer _RR> ? K
  : H extends ManyHandle<infer K, infer _Own, infer _P, infer _E, infer _RR> ? K
  : never

/** The owner reference a family's own selector receives. */
export type OwnerOf<H> = H extends OneHandle<infer _K, infer Own, infer _P, infer _E, infer _RR>
  ? Own
  : H extends ManyHandle<infer _K, infer Own, infer _P, infer _E, infer _RR> ? Own
  : null

/**
 * The owner reference the children of `O` receive: `null` when `O` is absent
 * (a root family), otherwise a reference to `O` itself, which carries `O`'s
 * key and its own owner chain.
 */
export type OwnerRefFor<O> = [O] extends [never] ? null : LifetimeRef<Extract<O, AnyHandle>>

/** The services a family publishes to its children and dependents. */
export type ProvidesOf<H> = H extends OneHandle<infer _K, infer _Own, infer P, infer _E, infer _RR> ? P
  : H extends ManyHandle<infer _K, infer _Own, infer P, infer _E, infer _RR> ? P
  : never

/** The services a family's children see: every ancestor's published services. */
export type ChildEnvOf<H> = H extends OneHandle<infer _K, infer _Own, infer _P, infer Env, infer _RR>
  ? Env
  : H extends ManyHandle<infer _K, infer _Own, infer _P, infer Env, infer _RR> ? Env
  : never

/** The root-environment services a family's startup still needs. */
export type RootRequirementsOf<H> = H extends OneHandle<infer _K, infer _Own, infer _P, infer _E, infer RR>
  ? RR
  : H extends ManyHandle<infer _K, infer _Own, infer _P, infer _E, infer RR> ? RR
  : never

/**
 * The services a startup Effect publishes (§29): returning a
 * `Context.Context<S>` publishes `S`; any other result publishes nothing.
 */
export type Published<A> = A extends Context.Context<infer S> ? S : never

/**
 * The startup environment a family gets beyond the root environment (§28):
 * the services published by its ancestors and by its required providers, plus
 * its own instance Scope.
 */
export type StartEnv<O, Req> =
  | ChildEnvOf<O>
  | ProvidesOf<Req[keyof Req]>
  | Scope.Scope

export interface LifetimeOptions<
  K,
  A,
  E,
  R,
  O extends AnyHandle,
  Req extends Record<string, AnyHandle>
> {
  /** The owning family; omitted for root families. */
  readonly owner?: O
  /** Named capability requirements satisfied by other lifetime families. */
  readonly requires?: Req
  /** Defaults to `Replacement.sequential()`. */
  readonly replacement?: ReplacementPolicy | undefined
  /**
   * The startup Effect for one keyed instance. It runs with the instance
   * Scope, the root environment, all ancestor-provided capabilities and all
   * required provider capabilities in its environment. Returning a
   * `Context.Context<_>` publishes those services to children and dependents.
   *
   * The family's semantic key type is inferred from this parameter, so it must
   * be annotated — write `(_: null)` for a family whose key carries no
   * information. An un-inferable key type is rejected rather than silently
   * widening to `unknown`, which would let a Binding desire anything at all
   * for this family.
   *
   * Semantic key identity is Effect's own, `Equal.equals` with `Hash.hash`:
   * primitives, plain objects, arrays, class instances and `Data` values all
   * compare structurally, exactly as for `RcMap` and the Effect collections.
   * Two rules follow, and neither is checked at runtime:
   *
   * - **Keys must be immutable.** Identity is cached per key, so mutating a
   *   key value after it has been desired corrupts the identity it was
   *   admitted under.
   * - **Keys must compare stably.** A value compared by reference (a plain
   *   function, or anything wrapped in `Equal.byReference`) is a valid key
   *   only if the Binding yields the *same* value each commit; a freshly
   *   built one replaces the lifetime every time.
   *
   * Whatever it requires beyond `Scope`, its ancestors and its providers is a
   * root-environment requirement and surfaces on `Reconciler.make`.
   */
  readonly start: (key: K) => Effect.Effect<A, E, R>
}

/**
 * Returned in place of a handle when a family's key type could not be
 * inferred, so the mistake is reported where the handle is used.
 */
export type KeyMustBeAnnotated =
  "effect-reconciler: annotate the key parameter of `start`, for example `start: (key: string) => …`, or `start: (_: null) => …` when the key carries no information"

export interface DefineApi {
  readonly one: <
    K,
    A,
    E,
    R,
    O extends AnyHandle = never,
    Req extends Record<string, AnyHandle> = {}
  >(
    name: string,
    options: LifetimeOptions<K, A, E, R, O, Req>
  ) => [unknown] extends [K] ? KeyMustBeAnnotated
    : OneHandle<
      K,
      OwnerRefFor<O>,
      Published<A>,
      ChildEnvOf<O> | Published<A>,
      Exclude<R, StartEnv<O, Req>>
    >
  readonly many: <
    K,
    A,
    E,
    R,
    O extends AnyHandle = never,
    Req extends Record<string, AnyHandle> = {}
  >(
    name: string,
    options: LifetimeOptions<K, A, E, R, O, Req>
  ) => [unknown] extends [K] ? KeyMustBeAnnotated
    : ManyHandle<
      K,
      OwnerRefFor<O>,
      Published<A>,
      ChildEnvOf<O> | Published<A>,
      Exclude<R, StartEnv<O, Req>>
    >
}

// -----------------------------------------------------------------------------
// Internal representation (not part of the public vocabulary)
// -----------------------------------------------------------------------------

/**
 * The unforgeable identity of one Definition. A per-call object, compared by
 * reference: two duplicate installed copies of this package, or two
 * Definitions that happen to declare families in the same order, can never be
 * mistaken for each other the way module-local counters could.
 */
export type DefinitionIdentity = { readonly definition: unique symbol }

export interface InternalHandle {
  readonly [HandleTypeId]: "one" | "many"
  readonly name: string
  readonly identity: DefinitionIdentity
  /** Index of this family within its own Definition, in creation order. */
  readonly familyId: number
  readonly owner: AnyHandle | undefined
  readonly requires: Readonly<Record<string, AnyHandle>>
  readonly replacement: "sequential" | "overlap"
  readonly start: (key: any) => Effect.Effect<any, any, any>
}

export const isHandle = (u: unknown): u is InternalHandle =>
  typeof u === "object" && u !== null && HandleTypeId in u

export const asInternal = (handle: AnyHandle): InternalHandle =>
  handle as unknown as InternalHandle

/** The compiled-from source of a Definition: every family in creation order. */
export interface DefinitionSource {
  readonly identity: DefinitionIdentity
  readonly families: ReadonlyArray<InternalHandle>
}
