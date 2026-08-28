import * as Effect from "effect/Effect"
import type * as PubSub from "effect/PubSub"
import type * as Scope from "effect/Scope"
import type { BindApi, Binding, BindingEntry } from "./Binding.js"
import {
  HandleTypeId,
  type AnyHandle,
  type DefineApi,
  type DefinitionIdentity,
  type DefinitionSource,
  type InternalHandle,
  type KeyOf,
  type OwnerOf,
  type RootRequirementsOf
} from "./Definition.js"
import type { BindingError, CommitError, ControllerClosed, DefinitionError } from "./Errors.js"
import type { LifetimeFailure } from "./Failure.js"
import type { LifetimeRef } from "./LifetimeRef.js"
import type { LifetimeStatus } from "./Status.js"
import { compileBinding, compileDefinition } from "./internal/compiledDefinition.js"
import { makeController } from "./internal/controller.js"

/**
 * A Definition with its lifetime handles: the handles returned by the builder
 * plus `bind`, which maps an arbitrary control-state type into desired
 * instances. The Definition is independent of any particular state type and
 * may be bound any number of times.
 */
export type Defined<H extends Record<string, AnyHandle>> = H & {
  readonly bind: <State>(
    f: (bind: BindApi<State>) => Record<string, BindingEntry<State>>
  ) => Binding<State, RootRequirementsOf<H[keyof H]>>
}

/**
 * Define a static family architecture of keyed Effect lifetimes: cardinality,
 * semantic key equality, ownership, capability requirements, startup and
 * replacement policy. Structural invariants are validated when a Controller
 * is created with `Reconciler.make`.
 */
export const define = <H extends Record<string, AnyHandle>>(
  f: (define: DefineApi) => H
): Defined<H> => {
  // Unforgeable Definition identity: a fresh object per call, compared by
  // reference, so handles from another Definition — including one from a
  // duplicate installed copy of this package — can never pass as ours.
  const identity = {} as DefinitionIdentity
  const families: Array<InternalHandle> = []

  const makeHandle =
    (cardinality: "one" | "many") =>
    (name: string, options: any): any => {
      const handle: InternalHandle = {
        [HandleTypeId]: cardinality,
        name,
        identity,
        familyId: families.length,
        key: options.key,
        owner: options.owner,
        requires: options.requires ?? {},
        replacement:
          options.replacement !== undefined && options.replacement._tag === "Overlap"
            ? "overlap"
            : "sequential",
        start: options.start
      }
      families.push(handle)
      return handle
    }

  const handles = f({
    one: makeHandle("one") as DefineApi["one"],
    many: makeHandle("many") as DefineApi["many"]
  })

  const source: DefinitionSource = { identity, families }

  const bind = <State>(
    bf: (bind: BindApi<State>) => Record<string, BindingEntry<State>>
  ): Binding<State, never> => {
    const api: BindApi<State> = {
      one: (handle, selector) => ({
        handle: handle as AnyHandle,
        cardinality: "one",
        selector: selector as (state: State, owner: unknown) => unknown
      }),
      many: (handle, selector) => ({
        handle: handle as AnyHandle,
        cardinality: "many",
        selector: selector as (state: State, owner: unknown) => unknown
      })
    }
    return { source, entries: Object.values(bf(api)) }
  }

  return { ...handles, bind } as Defined<H>
}

/**
 * A semantic reference to one keyed lifetime: the family handle, its key, and
 * the reference of its owner (`null` for a root family). The ownership chain
 * is type-checked, so a reference cannot name a lifetime the Definition could
 * not produce.
 */
export const ref = <H extends AnyHandle>(
  family: H,
  key: KeyOf<H>,
  parent: OwnerOf<H>
): LifetimeRef<H> => ({ family, key, parent })

/**
 * The stable mutation boundary of a running Reconciler.
 *
 * `commit(state)` evaluates the Binding against `state` and atomically
 * replaces the authoritative desired snapshot; the runtime converges
 * asynchronously. It never awaits resource startup, shutdown or convergence.
 *
 * `failures` subscribes to the startup failures of lifetimes whose desire is
 * still current, so a control plane can surface them in its own model. Each
 * subscription is owned by the surrounding Scope and only receives failures
 * published while it is attached.
 *
 * `status` answers authoritatively what the runtime currently knows about one
 * semantic lifetime; unlike a failure notification it cannot be missed.
 *
 * `retry(ref)` retires a Failed generation so a fresh one may be admitted
 * under the same semantic key, without the application inventing a retry
 * nonce or withdrawing and restoring desire.
 *
 * `shutdown` is idempotent: it stops accepting commits, invalidates all
 * desire, closes the root Scope and awaits structured finalization.
 */
export interface Controller<in State> {
  readonly commit: (state: State) => Effect.Effect<void, CommitError>
  readonly failures: Effect.Effect<PubSub.Subscription<LifetimeFailure>, never, Scope.Scope>
  readonly status: (ref: LifetimeRef) => Effect.Effect<LifetimeStatus>
  readonly retry: (ref: LifetimeRef) => Effect.Effect<void, ControllerClosed>
  readonly shutdown: Effect.Effect<void>
}

/**
 * Compile and validate a Definition + Binding and start a Controller. The
 * Controller's root Scope is owned by the surrounding Scope; the current
 * environment at `make` becomes the root environment of every lifetime, so
 * whatever the Definition's startup Effects require beyond their Scope, their
 * ancestors and their providers is required here (§60).
 */
export const make = <State, RootR = never>(
  binding: Binding<State, RootR>
): Effect.Effect<
  Controller<State>,
  DefinitionError | BindingError,
  Scope.Scope | RootR
> =>
  Effect.gen(function* () {
    const rootContext = yield* Effect.context<RootR>()
    const compiled = yield* Effect.fromResult(compileDefinition(binding.source))
    const entries = yield* Effect.fromResult(compileBinding(compiled, binding))
    return yield* makeController<State>(compiled, entries, rootContext)
  })
