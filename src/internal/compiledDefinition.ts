import * as Result from "effect/Result"
import type * as Effect from "effect/Effect"
import type { LabeledEntry } from "../Binding.js"
import type { SupervisionPolicy } from "../Supervision.js"
import type { Binding } from "../Binding.js"
import {
  asInternal,
  HandleTypeId,
  isHandle,
  type AnyHandle,
  type DefinitionIdentity,
  type DefinitionSource
} from "../Definition.js"
import {
  AmbiguousProvider,
  CapabilityCycle,
  CardinalityMismatch,
  DuplicateBinding,
  ForeignHandle,
  ForeignOwner,
  ForeignRequirement,
  MissingBinding,
  MissingObservation,
  OwnershipCycle,
  UnexpectedObservation,
  UnresolvableProvider,
  type BindingError,
  type DefinitionError
} from "../Errors.js"

/**
 * How a named requirement resolves for a desired/live instance:
 *
 * - `ancestor`: the provider family is an ancestor of the dependent in the
 *   ownership tree; the provider instance is the dependent's ancestor at
 *   `depth` (1-based instance depth from the root).
 * - `collateral`: the provider family's owner is an ancestor of (or root for)
 *   the dependent; the provider instance is the unique `one` instance of the
 *   provider family under the dependent's ancestor at owner-depth `depth`
 *   (0 meaning root).
 */
export interface CompiledRequirement {
  readonly name: string
  readonly familyId: number
  readonly kind: "ancestor" | "collateral"
  readonly depth: number
}

export interface CompiledFamily {
  readonly id: number
  readonly name: string
  /** The public handle: the family's authoritative semantic identity. */
  readonly handle: AnyHandle
  readonly cardinality: "one" | "many"
  readonly ownerId: number | null
  /** Family ids from root family to this family (inclusive). */
  readonly chain: ReadonlyArray<number>
  readonly requires: ReadonlyArray<CompiledRequirement>
  readonly replacement: "sequential" | "overlap"
  readonly supervision: SupervisionPolicy
  /** Whether this family observes projected state, so a Binding must project
   * it and a running generation must be handed it. */
  readonly observes: boolean
  readonly start: (key: any, observed: any) => Effect.Effect<any, any, any>
}

/** Compiled static architecture: ownership tree + capability resolution
 * metadata. Family ids double as topological order (owners precede children,
 * providers precede dependents). */
export interface Compiled {
  /** The Definition these families came from, for foreign-handle checks. */
  readonly identity: DefinitionIdentity
  readonly families: ReadonlyArray<CompiledFamily>
}

const isPrefix = (prefix: ReadonlyArray<number>, full: ReadonlyArray<number>): boolean =>
  prefix.length <= full.length && prefix.every((v, i) => full[i] === v)

export const compileDefinition = (
  source: DefinitionSource
): Result.Result<Compiled, DefinitionError> => {
  const families: Array<CompiledFamily> = []
  for (const handle of source.families) {
    // The same object under its public type: the internal shape is what this
    // function reads, the public handle is what errors and `Compiled` carry.
    const family = handle as unknown as AnyHandle
    let ownerId: number | null = null
    let chain: Array<number>
    if (handle.owner !== undefined) {
      if (!isHandle(handle.owner) || asInternal(handle.owner).identity !== source.identity) {
        return Result.fail(new ForeignOwner({ family }))
      }
      const owner = asInternal(handle.owner)
      if (owner.familyId >= handle.familyId) {
        return Result.fail(new OwnershipCycle({ family }))
      }
      ownerId = owner.familyId
      chain = [...families[ownerId]!.chain, handle.familyId]
    } else {
      chain = [handle.familyId]
    }

    const ownerChain = chain.slice(0, -1)
    const requires: Array<CompiledRequirement> = []
    for (const [name, requirement] of Object.entries(handle.requires)) {
      if (!isHandle(requirement) || asInternal(requirement).identity !== source.identity) {
        return Result.fail(new ForeignRequirement({ family, requirement: name }))
      }
      const provider = asInternal(requirement)
      if (provider.familyId === handle.familyId) {
        return Result.fail(
          new CapabilityCycle({ family, requirement: name, provider: family })
        )
      }
      if (provider.familyId > handle.familyId) {
        return Result.fail(
          new CapabilityCycle({ family, requirement: name, provider: requirement as AnyHandle })
        )
      }
      const providerFamily = families[provider.familyId]!
      if (isPrefix(providerFamily.chain, ownerChain)) {
        // Provider is a strict ancestor of the dependent.
        requires.push({
          name,
          familyId: provider.familyId,
          kind: "ancestor",
          depth: providerFamily.chain.length
        })
      } else {
        const providerOwnerChain = providerFamily.chain.slice(0, -1)
        if (!isPrefix(providerOwnerChain, ownerChain)) {
          return Result.fail(
            new UnresolvableProvider({
              family,
              requirement: name,
              provider: providerFamily.handle
            })
          )
        }
        if (providerFamily.cardinality !== "one") {
          return Result.fail(
            new AmbiguousProvider({
              family,
              requirement: name,
              provider: providerFamily.handle
            })
          )
        }
        requires.push({
          name,
          familyId: provider.familyId,
          kind: "collateral",
          depth: providerOwnerChain.length
        })
      }
    }

    families.push({
      id: handle.familyId,
      name: handle.name,
      handle: family,
      cardinality: handle[HandleTypeId],
      ownerId,
      chain,
      requires,
      replacement: handle.replacement,
      supervision: handle.supervision,
      observes: handle.observes,
      start: handle.start
    })
  }
  return Result.succeed({ identity: source.identity, families })
}

export const compileBinding = <State>(
  compiled: Compiled,
  binding: Binding<State, any>
): Result.Result<ReadonlyMap<number, LabeledEntry<State>>, BindingError> => {
  const entries = new Map<number, LabeledEntry<State>>()
  for (const entry of binding.entries) {
    if (!isHandle(entry.handle) || asInternal(entry.handle).identity !== binding.source.identity) {
      return Result.fail(new ForeignHandle({ label: entry.label }))
    }
    const internal = asInternal(entry.handle)
    if (internal[HandleTypeId] !== entry.cardinality) {
      return Result.fail(
        new CardinalityMismatch({
          family: entry.handle,
          declared: internal[HandleTypeId],
          used: entry.cardinality
        })
      )
    }
    if (entries.has(internal.familyId)) {
      return Result.fail(new DuplicateBinding({ family: entry.handle }))
    }
    entries.set(internal.familyId, entry)
  }
  for (const family of compiled.families) {
    const entry = entries.get(family.id)
    if (entry === undefined) {
      return Result.fail(new MissingBinding({ family: family.handle }))
    }
    if (family.observes && entry.observe === undefined) {
      return Result.fail(new MissingObservation({ family: family.handle }))
    }
    if (!family.observes && entry.observe !== undefined) {
      return Result.fail(new UnexpectedObservation({ family: family.handle }))
    }
  }
  return Result.succeed(entries)
}
