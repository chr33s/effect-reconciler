import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { BindApi, Binding, BindingEntry } from "./Binding.js"
import {
  HandleTypeId,
  type AnyHandle,
  type DefineApi,
  type DefinitionSource,
  type InternalHandle,
  type RootRequirementsOf
} from "./Definition.js"
import type { BindingError, CommitError, DefinitionError } from "./Errors.js"
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

let nextBuilderId = 1

/**
 * Define a static family architecture of keyed Effect lifetimes: cardinality,
 * semantic key equality, ownership, capability requirements, startup and
 * replacement policy. Structural invariants are validated when a Controller
 * is created with `Reconciler.make`.
 */
export const define = <H extends Record<string, AnyHandle>>(
  f: (define: DefineApi) => H
): Defined<H> => {
  const builderId = nextBuilderId++
  const families: Array<InternalHandle> = []

  const makeHandle =
    (cardinality: "one" | "many") =>
    (name: string, options: any): any => {
      const handle: InternalHandle = {
        [HandleTypeId]: cardinality,
        name,
        builderId,
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

  const source: DefinitionSource = { builderId, families }

  const bind = <State>(
    bf: (bind: BindApi<State>) => Record<string, BindingEntry<State>>
  ): Binding<State, never> => {
    const api: BindApi<State> = {
      one: (handle, selector) => ({
        handle: handle as AnyHandle,
        cardinality: "one",
        selector: selector as (state: State, ownerKey: unknown) => unknown
      }),
      many: (handle, selector) => ({
        handle: handle as AnyHandle,
        cardinality: "many",
        selector: selector as (state: State, ownerKey: unknown) => unknown
      })
    }
    return { source, entries: Object.values(bf(api)) }
  }

  return { ...handles, bind } as Defined<H>
}

/**
 * The stable mutation boundary of a running Reconciler.
 *
 * `commit(state)` evaluates the Binding against `state` and atomically
 * replaces the authoritative desired snapshot; the runtime converges
 * asynchronously. It never awaits resource startup, shutdown or convergence.
 *
 * `shutdown` is idempotent: it stops accepting commits, invalidates all
 * desire, closes the root Scope and awaits structured finalization.
 */
export interface Controller<in State> {
  readonly commit: (state: State) => Effect.Effect<void, CommitError>
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
