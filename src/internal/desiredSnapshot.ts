import * as Equal from "effect/Equal"
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
   * The projected state this node's family declared it observes, evaluated
   * against the same immutable state the keys were. `undefined` for the
   * families — nearly all of them — that observe nothing.
   *
   * It rides on the desired node because that is what makes it *coherent*
   * with the desire it accompanies: the projection a running generation is
   * handed came from the same state value that decided the generation should
   * exist, not from whatever the application happened to be holding when the
   * pass got round to it.
   */
  readonly observed: unknown
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

/**
 * What one incremental selector produced for one owner, last time it was
 * asked.
 *
 * The `idents` are kept alongside the keys, and that is the larger half of
 * the saving. A semantic identity caches its hash on first use, so reusing
 * the identity object means the `MutableHashMap` work that follows — the
 * duplicate check, the by-identity index, every later lookup during a
 * reconcile pass — costs a cached read instead of a structural walk of the
 * key and the whole owner chain. Reusing them is sound for the same reason
 * reusing the keys is: they are immutable, and they are only reused when the
 * declared dependencies say the keys are identical.
 */
interface Memo {
  readonly deps: unknown
  readonly keys: ReadonlyArray<unknown>
  readonly idents: ReadonlyArray<Ident>
}

/**
 * Per-family, per-owner memory of the last incremental evaluation.
 *
 * Owned by the Controller and handed to every `evaluate`, because what it
 * remembers spans commits — which is the only thing that makes it useful and
 * the only thing that makes it dangerous. It is keyed by owner *identity*, so
 * an owner that goes away and comes back under the same semantic key finds
 * its entry: correct, because the selector is a pure function of state and
 * owner, and neither carries anything physical.
 */
export interface IncrementalMemory {
  readonly byFamily: Map<number, MutableHashMap.MutableHashMap<Ident, Memo>>
  /** Root families have one owner-less slot each, which no `Ident` names. */
  readonly roots: Map<number, Memo>
  /** Selector calls made so far, and calls avoided, for
   * `Controller.diagnostics`. Counted here because here is the only place
   * that knows the difference. */
  evaluated: number
  skipped: number
}

export const makeIncrementalMemory = (): IncrementalMemory => ({
  byFamily: new Map(),
  roots: new Map(),
  evaluated: 0,
  skipped: 0
})

const push = (map: Map<number, Array<DesiredNode>>, id: number, node: DesiredNode): void => {
  const list = map.get(id)
  if (list === undefined) map.set(id, [node])
  else list.push(node)
}

export const evaluate = <State>(
  compiled: Compiled,
  entries: ReadonlyMap<number, LabeledEntry<State>>,
  state: State,
  memory: IncrementalMemory
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
    // Only a family that declared `deps` participates; everything else takes
    // the same full sweep it always did, at the same cost.
    const incremental = entry.deps !== undefined
    let owned: MutableHashMap.MutableHashMap<Ident, Memo> | undefined
    if (incremental && family.ownerId !== null) {
      owned = memory.byFamily.get(family.id)
      if (owned === undefined) {
        owned = MutableHashMap.empty<Ident, Memo>()
        memory.byFamily.set(family.id, owned)
      }
    }

    let visitedOwners = 0
    for (const parent of parents) {
      visitedOwners++
      const owner = parent === null ? null : parent.ref
      let keys: ReadonlyArray<unknown>
      // Identities carried over from the previous evaluation, positionally
      // matched to `keys`; `undefined` means "build them".
      let reusedIdents: ReadonlyArray<Ident> | undefined
      let deps: unknown
      let previous: Memo | undefined
      let observed: unknown
      if (entry.observe !== undefined) {
        try {
          // Never memoized against `deps`: a projection is the thing a
          // lifetime reacts to, and skipping it because the *keys* did not
          // change would be answering a different question than the one asked.
          observed = entry.observe(state, owner)
        } catch (error) {
          return invalid(new SelectorFailed({ family: family.handle, error }))
        }
      }
      if (incremental) {
        try {
          deps = entry.deps!(state, owner)
        } catch (error) {
          return invalid(new SelectorFailed({ family: family.handle, error }))
        }
        previous = parent === null
          ? memory.roots.get(family.id)
          : Option.getOrUndefined(MutableHashMap.get(owned!, parent.ident))
      }

      if (previous !== undefined && Equal.equals(previous.deps, deps)) {
        keys = previous.keys
        reusedIdents = previous.idents
        memory.skipped++
      } else {
        memory.evaluated++
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
      }

      // Recorded only after the keys are known to be valid, and rewritten
      // even when they were reused, so the identities below can be stored
      // with them.
      const freshIdents: Array<Ident> | undefined = reusedIdents === undefined && incremental
        ? []
        : undefined

      let position = -1
      for (const key of keys) {
        position++
        const ident = reusedIdents !== undefined
          ? reusedIdents[position]!
          : new Ident(family.id, key, parent === null ? null : parent.ident)
        freshIdents?.push(ident)
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
          observed,
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

      if (incremental) {
        const memo: Memo = { deps, keys, idents: reusedIdents ?? freshIdents! }
        if (parent === null) memory.roots.set(family.id, memo)
        else MutableHashMap.set(owned!, parent.ident, memo)
      }
    }
    nodesByFamily.set(family.id, familyNodes)

    // Owners come and go, and each one that goes leaves a memo behind. At ten
    // thousand documents that is ten thousand entries per owned family, kept
    // alive by nothing anyone can see — so the memory is pruned against the
    // desire that was just built, which is the only authority on which owners
    // still exist.
    // Only when an owner actually went away. The sweep itself is O(memo) with
    // an array allocation and a probe per entry, and at ten thousand owners
    // running it on every commit costs more than the selectors the whole
    // memo exists to skip — measured, and the reason this is a condition
    // rather than an unconditional tidy-up. Every owner alive this commit was
    // visited above, so a memo larger than that count is the only way a stale
    // entry can exist.
    if (owned !== undefined && MutableHashMap.size(owned) > visitedOwners) {
      // Snapshotted first: removing while iterating the map's own key view is
      // not something it promises to survive.
      for (const ownerIdent of [...MutableHashMap.keys(owned)]) {
        if (!MutableHashMap.has(byIdent, ownerIdent)) MutableHashMap.remove(owned, ownerIdent)
      }
    }
  }

  return Result.succeed({ byIdent, topo, rootsByFamily })
}
