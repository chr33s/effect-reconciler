import type * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type * as SubscriptionRef from "effect/SubscriptionRef"
import type { LifetimeRef } from "./LifetimeRef.js"
import type { ReplacementPolicy } from "./Replacement.js"
import type { SupervisionPolicy } from "./Supervision.js"

export const HandleTypeId: unique symbol = Symbol.for("effect-reconciler/Handle")
export type HandleTypeId = typeof HandleTypeId

/**
 * The static contract every lifetime handle carries. The handle itself is the
 * authoritative nominal identity of the family; the string name is a
 * human-readable label.
 *
 * The type parameters carry that contract (spec §6.2, §6.3):
 *
 * - `K` semantic key type, `Own` the owner reference its selector receives
 *   (`null` for root families)
 * - `P` the services this family publishes to its children and dependents
 * - `Env` the services visible to its children: every ancestor's published
 *   services plus its own
 * - `RR` the services its startup still needs from the root environment (spec §6.2);
 *   these propagate to `Reconciler.make`.
 * - `S` the projected state its startup observes, when it declared one by
 *   taking a second `start` parameter; `never` otherwise. A Binding for this
 *   family must then supply the projection, which is how a state-independent
 *   Definition can still say what shape of state it needs (spec §4.4).
 */
export interface HandleContract<
  in out K,
  in out Own = null,
  out P = never,
  out Env = never,
  out RR = never,
  in out S = never
> {
  readonly name: string
  // Phantom carriers, never present at runtime: a handle is only ever
  // produced by this package, through a cast. They are required rather than
  // optional so that inferring against this shape yields the parameter
  // itself, not `T | undefined`.
  readonly _key: K
  readonly _owner: Own
  readonly _provides: P
  readonly _childEnv: Env
  readonly _rootRequires: RR
  readonly _observes: S
}

/**
 * Opaque handle for a `define.one` lifetime family. Cardinality is the only
 * thing that separates the two handle types, so it is the only thing they add
 * to the shared contract — and the extractors below match that one shape
 * instead of both of them.
 */
export interface OneHandle<
  in out K,
  in out Own = null,
  out P = never,
  out Env = never,
  out RR = never,
  in out S = never
> extends HandleContract<K, Own, P, Env, RR, S> {
  readonly [HandleTypeId]: "one"
}

/** Opaque handle for a `define.many` lifetime family. */
export interface ManyHandle<
  in out K,
  in out Own = null,
  out P = never,
  out Env = never,
  out RR = never,
  in out S = never
> extends HandleContract<K, Own, P, Env, RR, S> {
  readonly [HandleTypeId]: "many"
}

export type AnyHandle =
  | OneHandle<any, any, any, any, any, any>
  | ManyHandle<any, any, any, any, any, any>

// The type extractors below must spell out every parameter with `infer`: an
// `any` in an invariant position (`K`, `OK`) makes the extends-check fail
// against handles whose owner key is `never`, silently yielding `never`.

export type KeyOf<H> = H extends
  HandleContract<infer K, infer _Own, infer _P, infer _E, infer _RR, infer _S> ? K
  : never

/** The owner reference a family's own selector receives. */
export type OwnerOf<H> = H extends
  HandleContract<infer _K, infer Own, infer _P, infer _E, infer _RR, infer _S> ? Own
  : null

/**
 * The owner reference the children of `O` receive: `null` when `O` is absent
 * (a root family), otherwise a reference to `O` itself, which carries `O`'s
 * key and its own owner chain.
 */
export type OwnerRefFor<O> = [O] extends [never] ? null : LifetimeRef<Extract<O, AnyHandle>>

/** The services a family publishes to its children and dependents. */
export type ProvidesOf<H> = H extends
  HandleContract<infer _K, infer _Own, infer P, infer _E, infer _RR, infer _S> ? P
  : never

/** The services a family's children see: every ancestor's published services. */
export type ChildEnvOf<H> = H extends
  HandleContract<infer _K, infer _Own, infer _P, infer Env, infer _RR, infer _S> ? Env
  : never

/** The root-environment services a family's startup still needs. */
export type RootRequirementsOf<H> = H extends
  HandleContract<infer _K, infer _Own, infer _P, infer _E, infer RR, infer _S> ? RR
  : never

/** The projected state a family's startup observes, or `never`. */
export type ObservedOf<H> = H extends
  HandleContract<infer _K, infer _Own, infer _P, infer _E, infer _RR, infer S> ? S
  : never

/**
 * The services a startup Effect publishes (spec §6.3): returning a
 * `Context.Context<S>` publishes `S`; any other result publishes nothing.
 */
export type Published<A> = A extends Context.Context<infer S> ? S : never

/**
 * The startup environment a family gets beyond the root environment (spec §6.2):
 * the services published by its ancestors and by its required providers, plus
 * its own instance Scope.
 */
export type StartEnv<O, Req> =
  | ChildEnvOf<O>
  | ProvidesOf<Req[keyof Req]>
  | Scope.Scope

export interface LifetimeOptions<
  K,
  S,
  A,
  E,
  R,
  O extends AnyHandle,
  Req extends Record<string, AnyHandle>
> {
  /**
   * Declare that this lifetime **observes projected state**, and of what
   * shape: `observes: Reconciler.observed<SubModel>()`.
   *
   * A Definition is state-independent (spec §4.4), so it cannot name the
   * application's state type — but it can name the shape it needs. Every
   * Binding must then say how to project that shape out of its own state, and
   * the running generation is handed a `SubscriptionRef` of it as `start`'s
   * second argument: seeded at admission, updated on every commit that
   * changes it, for as long as that generation is the current one.
   *
   * This is the only channel by which a *running* lifetime sees state change
   * rather than being replaced by it, and it is narrow on purpose. A key
   * change still replaces the lifetime. Observation is for the case where
   * replacing it would be precisely the wrong answer — because the lifetime
   * is itself reconciling something (`Reconciler.nested`), or otherwise
   * maintaining a live thing that must survive the state it reacts to.
   *
   * It cannot start or stop anything: desire is still, and only, the keys the
   * selectors produce.
   */
  readonly observes?: Observed<S>
  /** The owning family; omitted for root families. */
  readonly owner?: O
  /** Named capability requirements satisfied by other lifetime families. */
  readonly requires?: Req
  /** Defaults to `Replacement.sequential()`. */
  readonly replacement?: ReplacementPolicy | undefined
  /**
   * What happens when this family's startup fails. Defaults to
   * `Supervision.manual()`: the failed generation holds its slot until desire
   * changes or `Controller.retry` retires it.
   */
  readonly supervision?: SupervisionPolicy | undefined
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
   *
   * When the family declares `observes`, `start` receives a second argument:
   * a `SubscriptionRef` of the projected state, seeded at admission and
   * updated on every commit that changes it.
   */
  readonly start: (
    key: K,
    // A conditional type, so this parameter contributes no inference
    // candidate for `S` and `observes` is its single source. Left plainly
    // inferring, an absent second argument still produces a candidate and a
    // family that observes nothing ends up with `S = any` — which would then
    // match every Binding, including the ones that forgot to project. The
    // conditional also gives the right answer for such a family: `never`, so
    // writing a second parameter it could never receive is an error.
    observed: [S] extends [never] ? never : SubscriptionRef.SubscriptionRef<S>
  ) => Effect.Effect<A, E, R>
}

/**
 * A witness for the shape of projected state a family observes. Carries
 * nothing at runtime: it exists so `S` has exactly one inference site, which
 * is what makes "this family observes nothing" mean `never` rather than
 * whatever an unmatched parameter position happens to widen to.
 */
export interface Observed<in out S> {
  readonly _observed: (_: S) => S
}


/** Declare the shape of state a family observes: `observes: observed<T>()`. */
export const observed = <S>(): Observed<S> => ({ _observed: (_) => _ })

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
    Req extends Record<string, AnyHandle> = {},
    S = never
  >(
    name: string,
    options: LifetimeOptions<K, S, A, E, R, O, Req>
  ) => [unknown] extends [K] ? KeyMustBeAnnotated
    : OneHandle<
      K,
      OwnerRefFor<O>,
      Published<A>,
      ChildEnvOf<O> | Published<A>,
      Exclude<R, StartEnv<O, Req>>,
      S
    >
  readonly many: <
    K,
    A,
    E,
    R,
    O extends AnyHandle = never,
    Req extends Record<string, AnyHandle> = {},
    S = never
  >(
    name: string,
    options: LifetimeOptions<K, S, A, E, R, O, Req>
  ) => [unknown] extends [K] ? KeyMustBeAnnotated
    : ManyHandle<
      K,
      OwnerRefFor<O>,
      Published<A>,
      ChildEnvOf<O> | Published<A>,
      Exclude<R, StartEnv<O, Req>>,
      S
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
  readonly supervision: SupervisionPolicy
  /** Whether this family declared `observes`. */
  readonly observes: boolean
  readonly start: (key: any, observed: any) => Effect.Effect<any, any, any>
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
