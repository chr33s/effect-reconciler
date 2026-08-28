import type * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { Key } from "./Key.js"
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
 * - `K` semantic key type, `OK` the owner family's semantic key type
 *   (`never` for root families)
 * - `P` the services this family publishes to its children and dependents
 * - `Env` the services visible to its children: every ancestor's published
 *   services plus its own
 * - `RR` the services its startup still needs from the root environment (§60);
 *   these propagate to `Reconciler.make`.
 */
export interface OneHandle<
  in out K,
  in out OK = never,
  out P = never,
  out Env = never,
  out RR = never
> {
  readonly [HandleTypeId]: "one"
  readonly name: string
  readonly _key?: K
  readonly _ownerKey?: OK
  readonly _provides?: P
  readonly _childEnv?: Env
  readonly _rootRequires?: RR
}

/** Opaque handle for a `define.many` lifetime family. */
export interface ManyHandle<
  in out K,
  in out OK = never,
  out P = never,
  out Env = never,
  out RR = never
> {
  readonly [HandleTypeId]: "many"
  readonly name: string
  readonly _key?: K
  readonly _ownerKey?: OK
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

export type KeyOf<H> = H extends OneHandle<infer K, infer _OK, infer _P, infer _E, infer _RR> ? K
  : H extends ManyHandle<infer K, infer _OK, infer _P, infer _E, infer _RR> ? K
  : never

/** The services a family publishes to its children and dependents. */
export type ProvidesOf<H> = H extends OneHandle<infer _K, infer _OK, infer P, infer _E, infer _RR> ? P
  : H extends ManyHandle<infer _K, infer _OK, infer P, infer _E, infer _RR> ? P
  : never

/** The services a family's children see: every ancestor's published services. */
export type ChildEnvOf<H> = H extends OneHandle<infer _K, infer _OK, infer _P, infer Env, infer _RR>
  ? Env
  : H extends ManyHandle<infer _K, infer _OK, infer _P, infer Env, infer _RR> ? Env
  : never

/** The root-environment services a family's startup still needs. */
export type RootRequirementsOf<H> = H extends OneHandle<infer _K, infer _OK, infer _P, infer _E, infer RR>
  ? RR
  : H extends ManyHandle<infer _K, infer _OK, infer _P, infer _E, infer RR> ? RR
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
  readonly key: Key<K>
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
   * Whatever it requires beyond `Scope`, its ancestors and its providers is a
   * root-environment requirement and surfaces on `Reconciler.make`.
   */
  readonly start: (key: K) => Effect.Effect<A, E, R>
}

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
  ) => OneHandle<
    K,
    KeyOf<O>,
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
  ) => ManyHandle<
    K,
    KeyOf<O>,
    Published<A>,
    ChildEnvOf<O> | Published<A>,
    Exclude<R, StartEnv<O, Req>>
  >
}

// -----------------------------------------------------------------------------
// Internal representation (not part of the public vocabulary)
// -----------------------------------------------------------------------------

export interface InternalHandle {
  readonly [HandleTypeId]: "one" | "many"
  readonly name: string
  readonly builderId: number
  readonly familyId: number
  readonly key: Key<any>
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
  readonly builderId: number
  readonly families: ReadonlyArray<InternalHandle>
}
