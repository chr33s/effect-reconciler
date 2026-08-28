import * as Result from "effect/Result"
import type * as Effect from "effect/Effect"
import type { BindingEntry } from "../Binding.js"
import type { Binding } from "../Binding.js"
import {
  asInternal,
  HandleTypeId,
  isHandle,
  type DefinitionSource
} from "../Definition.js"
import { BindingError, DefinitionError } from "../Errors.js"
import type { Key } from "../Key.js"

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
  readonly cardinality: "one" | "many"
  readonly key: Key<any>
  readonly ownerId: number | null
  /** Family ids from root family to this family (inclusive). */
  readonly chain: ReadonlyArray<number>
  readonly requires: ReadonlyArray<CompiledRequirement>
  readonly replacement: "sequential" | "overlap"
  readonly start: (key: any) => Effect.Effect<any, any, any>
}

/** Compiled static architecture: ownership tree + capability resolution
 * metadata. Family ids double as topological order (owners precede children,
 * providers precede dependents). */
export interface Compiled {
  readonly families: ReadonlyArray<CompiledFamily>
}

const isPrefix = (prefix: ReadonlyArray<number>, full: ReadonlyArray<number>): boolean =>
  prefix.length <= full.length && prefix.every((v, i) => full[i] === v)

export const compileDefinition = (
  source: DefinitionSource
): Result.Result<Compiled, DefinitionError> => {
  const families: Array<CompiledFamily> = []
  for (const handle of source.families) {
    let ownerId: number | null = null
    let chain: Array<number>
    if (handle.owner !== undefined) {
      if (!isHandle(handle.owner) || asInternal(handle.owner).builderId !== source.builderId) {
        return Result.fail(
          new DefinitionError({
            reason: `owner of "${handle.name}" is not a lifetime handle from this definition`
          })
        )
      }
      const owner = asInternal(handle.owner)
      if (owner.familyId >= handle.familyId) {
        return Result.fail(
          new DefinitionError({ reason: `ownership cycle involving "${handle.name}"` })
        )
      }
      ownerId = owner.familyId
      chain = [...families[ownerId]!.chain, handle.familyId]
    } else {
      chain = [handle.familyId]
    }

    const ownerChain = chain.slice(0, -1)
    const requires: Array<CompiledRequirement> = []
    for (const [name, requirement] of Object.entries(handle.requires)) {
      if (!isHandle(requirement) || asInternal(requirement).builderId !== source.builderId) {
        return Result.fail(
          new DefinitionError({
            reason: `requirement "${name}" of "${handle.name}" is not a lifetime handle from this definition`
          })
        )
      }
      const provider = asInternal(requirement)
      if (provider.familyId === handle.familyId) {
        return Result.fail(
          new DefinitionError({ reason: `"${handle.name}" cannot require itself` })
        )
      }
      if (provider.familyId > handle.familyId) {
        return Result.fail(
          new DefinitionError({
            reason: `capability cycle: "${handle.name}" requires "${provider.name}" which was defined later`
          })
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
            new DefinitionError({
              reason:
                `requirement "${name}" of "${handle.name}" cannot be resolved: ` +
                `provider "${providerFamily.name}" is not owned by an ancestor of "${handle.name}"`
            })
          )
        }
        if (providerFamily.cardinality !== "one") {
          return Result.fail(
            new DefinitionError({
              reason:
                `requirement "${name}" of "${handle.name}" is ambiguous: ` +
                `provider "${providerFamily.name}" has many cardinality`
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
      cardinality: handle[HandleTypeId],
      key: handle.key,
      ownerId,
      chain,
      requires,
      replacement: handle.replacement,
      start: handle.start
    })
  }
  return Result.succeed({ families })
}

export const compileBinding = <State>(
  compiled: Compiled,
  binding: Binding<State, any>
): Result.Result<ReadonlyMap<number, BindingEntry<State>>, BindingError> => {
  const entries = new Map<number, BindingEntry<State>>()
  for (const entry of binding.entries) {
    if (!isHandle(entry.handle) || asInternal(entry.handle).builderId !== binding.source.builderId) {
      return Result.fail(
        new BindingError({
          reason: "binding references a lifetime handle that does not belong to this definition"
        })
      )
    }
    const internal = asInternal(entry.handle)
    if (internal[HandleTypeId] !== entry.cardinality) {
      return Result.fail(
        new BindingError({
          reason: `"${internal.name}": bind.${entry.cardinality} used with a "${internal[HandleTypeId]}" definition`
        })
      )
    }
    if (entries.has(internal.familyId)) {
      return Result.fail(
        new BindingError({ reason: `duplicate binding for "${internal.name}"` })
      )
    }
    entries.set(internal.familyId, entry)
  }
  for (const family of compiled.families) {
    if (!entries.has(family.id)) {
      return Result.fail(new BindingError({ reason: `missing binding for "${family.name}"` }))
    }
  }
  return Result.succeed(entries)
}
