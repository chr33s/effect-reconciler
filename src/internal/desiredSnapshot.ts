import * as Result from "effect/Result"
import * as Option from "effect/Option"
import type { BindingEntry } from "../Binding.js"
import { InvalidDesiredState } from "../Errors.js"
import type { Owner } from "../Owner.js"
import type { Compiled } from "./compiledDefinition.js"

/** One desired instance: family + semantic key, owner-relative. */
export interface DesiredNode {
  readonly familyId: number
  readonly key: unknown
  readonly keyStr: string
  /** Semantic path: `/<familyId>:<key>` segments from the root. */
  readonly path: string
  readonly parent: DesiredNode | null
  /** Desired instance chain from root to this node (inclusive). */
  readonly chain: ReadonlyArray<DesiredNode>
  readonly childrenByFamily: ReadonlyMap<number, ReadonlyArray<DesiredNode>>
  /**
   * The pure semantic reference handed to the selectors of this node's owned
   * families: this node's family name and key, linked to its own owner. The
   * chain is what lets an owned selector distinguish two identical direct
   * owner keys under different ancestors.
   */
  readonly ownerRef: Owner<unknown, unknown>
}

/** One coherent desired snapshot produced by evaluating a Binding against a
 * single immutable state value. */
export interface DesiredSnapshot {
  readonly byPath: ReadonlyMap<string, DesiredNode>
  /** Owner-before-child order. */
  readonly topo: ReadonlyArray<DesiredNode>
  readonly rootsByFamily: ReadonlyMap<number, ReadonlyArray<DesiredNode>>
}

export const emptySnapshot: DesiredSnapshot = {
  byPath: new Map(),
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
  entries: ReadonlyMap<number, BindingEntry<State>>,
  state: State
): Result.Result<DesiredSnapshot, InvalidDesiredState> => {
  const byPath = new Map<string, DesiredNode>()
  const topo: Array<DesiredNode> = []
  const rootsByFamily = new Map<number, Array<DesiredNode>>()
  const nodesByFamily = new Map<number, Array<DesiredNode>>()

  const invalid = (reason: string) => Result.fail(new InvalidDesiredState({ reason }))

  for (const family of compiled.families) {
    const entry = entries.get(family.id)!
    const parents: ReadonlyArray<DesiredNode | null> =
      family.ownerId === null ? [null] : nodesByFamily.get(family.ownerId) ?? []
    const familyNodes: Array<DesiredNode> = []

    for (const parent of parents) {
      const owner = parent === null ? null : parent.ownerRef
      let keys: Array<unknown>
      try {
        const result = entry.selector(state, owner)
        if (family.cardinality === "one") {
          if (!Option.isOption(result)) {
            return invalid(`selector for "${family.name}" must return an Option`)
          }
          keys = Option.isSome(result) ? [result.value] : []
        } else {
          if (
            result == null ||
            typeof (result as any)[Symbol.iterator] !== "function"
          ) {
            return invalid(`selector for "${family.name}" must return an Iterable`)
          }
          keys = [...(result as Iterable<unknown>)]
        }
      } catch (error) {
        return invalid(`selector for "${family.name}" threw: ${String(error)}`)
      }

      const seen = new Set<string>()
      for (const key of keys) {
        let keyStr: string
        try {
          // Escaped so that arbitrary Key encodings can never collide with
          // the '/', ':' and '|' delimiters of internal path/slot ids.
          keyStr = encodeURIComponent(family.key.encode(key))
        } catch (error) {
          return invalid(`key encoding for "${family.name}" failed: ${String(error)}`)
        }
        if (seen.has(keyStr)) {
          return invalid(`duplicate semantic key ${keyStr} for "${family.name}"`)
        }
        seen.add(keyStr)
        const path = (parent === null ? "" : parent.path) + "/" + family.id + ":" + keyStr
        const childrenByFamily = new Map<number, Array<DesiredNode>>()
        const node: DesiredNode = {
          familyId: family.id,
          key,
          keyStr,
          path,
          parent,
          chain: [],
          childrenByFamily,
          ownerRef: {
            family: family.name,
            key,
            parent: parent === null ? null : parent.ownerRef
          }
        }
        ;(node as { chain: ReadonlyArray<DesiredNode> }).chain =
          parent === null ? [node] : [...parent.chain, node]
        byPath.set(path, node)
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

  return Result.succeed({ byPath, topo, rootsByFamily })
}
