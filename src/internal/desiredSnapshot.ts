import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type { LabeledEntry } from "../Binding.js"
import {
  DuplicateDesiredKey,
  InvalidDesiredState,
  InvalidSelectorResult,
  SelectorFailed,
  type InvalidDesiredStateReason
} from "../Errors.js"
import type { LifetimeRef } from "../LifetimeRef.js"
import type { Compiled } from "./compiledDefinition.js"
import { Ident, slotIdent } from "./identity.js"
import type { LiveInstance } from "./liveState.js"

/** One desired instance: family + semantic key, owner-relative. */
export interface DesiredNode {
  readonly familyId: number
  readonly key: unknown
  /** Structural semantic identity: family, key and owner chain. */
  readonly ident: Ident
  /**
   * Identity of the replacement slot this node competes for. A `one` family
   * has a single key-independent slot per owner; a `many` family's slot is its
   * own identity. Computed with the snapshot so a reconcile pass allocates
   * nothing per node.
   */
  readonly slot: Ident
  readonly parent: DesiredNode | null
  /** Owner chain from the root down to this node's parent, root-most first.
   * Requirements only ever name strict ancestors, so the node itself is not
   * in it — which is also what lets it be built before the node exists. */
  readonly ancestors: ReadonlyArray<DesiredNode>
  readonly childrenByFamily: ReadonlyMap<number, ReadonlyArray<DesiredNode>>
  /**
   * The pure semantic reference of this node: family handle, key and owner
   * chain. Owned selectors receive their owner's, which is what lets them
   * distinguish two identical direct owner keys under different ancestors.
   */
  readonly ref: LifetimeRef
  /**
   * The live generation currently satisfying this node, filled in by the
   * reconciler. A pass that has already matched instances to desire can then
   * skip satisfied nodes without hashing anything.
   */
  live: LiveInstance | undefined
}

/** One coherent desired snapshot produced by evaluating a Binding against a
 * single immutable state value. */
export interface DesiredSnapshot {
  readonly byIdent: MutableHashMap.MutableHashMap<Ident, DesiredNode>
  /** Owner-before-child order. */
  readonly topo: ReadonlyArray<DesiredNode>
  readonly rootsByFamily: ReadonlyMap<number, ReadonlyArray<DesiredNode>>
}

export const emptySnapshot: DesiredSnapshot = {
  byIdent: MutableHashMap.empty(),
  topo: [],
  rootsByFamily: new Map()
}

const push = (map: Map<number, Array<DesiredNode>>, id: number, node: DesiredNode): void => {
  const list = map.get(id)
  if (list === undefined) map.set(id, [node])
  else list.push(node)
}

export const evaluate = <State>(
  compiled: Compiled,
  entries: ReadonlyMap<number, LabeledEntry<State>>,
  state: State
): Result.Result<DesiredSnapshot, InvalidDesiredState> => {
  const byIdent = MutableHashMap.empty<Ident, DesiredNode>()
  const topo: Array<DesiredNode> = []
  const rootsByFamily = new Map<number, Array<DesiredNode>>()
  const nodesByFamily = new Map<number, Array<DesiredNode>>()

  const invalid = (reason: InvalidDesiredStateReason) =>
    Result.fail(new InvalidDesiredState({ reason }))

  for (const family of compiled.families) {
    const entry = entries.get(family.id)!
    const parents: ReadonlyArray<DesiredNode | null> =
      family.ownerId === null ? [null] : nodesByFamily.get(family.ownerId) ?? []
    const familyNodes: Array<DesiredNode> = []

    for (const parent of parents) {
      const owner = parent === null ? null : parent.ref
      let keys: Array<unknown>
      try {
        const result = entry.selector(state, owner)
        if (family.cardinality === "one") {
          if (!Option.isOption(result)) {
            return invalid(
              new InvalidSelectorResult({ family: family.handle, expected: "Option" })
            )
          }
          keys = Option.isSome(result) ? [result.value] : []
        } else {
          if (result == null || typeof (result as any)[Symbol.iterator] !== "function") {
            return invalid(
              new InvalidSelectorResult({ family: family.handle, expected: "Iterable" })
            )
          }
          keys = [...(result as Iterable<unknown>)]
        }
      } catch (error) {
        return invalid(new SelectorFailed({ family: family.handle, error }))
      }

      for (const key of keys) {
        const ident = new Ident(family.id, key, parent === null ? null : parent.ident)
        if (MutableHashMap.has(byIdent, ident)) {
          return invalid(new DuplicateDesiredKey({ family: family.handle, key }))
        }

        const childrenByFamily = new Map<number, Array<DesiredNode>>()
        const node: DesiredNode = {
          familyId: family.id,
          key,
          ident,
          slot: slotIdent(family.id, family.cardinality, ident),
          parent,
          ancestors: parent === null ? [] : [...parent.ancestors, parent],
          childrenByFamily,
          ref: {
            family: family.handle,
            key,
            parent: parent === null ? null : parent.ref
          },
          live: undefined
        }
        MutableHashMap.set(byIdent, ident, node)
        topo.push(node)
        familyNodes.push(node)
        if (parent === null) {
          push(rootsByFamily, family.id, node)
        } else {
          push(parent.childrenByFamily as Map<number, Array<DesiredNode>>, family.id, node)
        }
      }
    }
    nodesByFamily.set(family.id, familyNodes)
  }

  return Result.succeed({ byIdent, topo, rootsByFamily })
}
