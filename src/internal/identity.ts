import * as Equal from "effect/Equal"
import * as Hash from "effect/Hash"

/**
 * The internal semantic identity of one keyed lifetime: family, key and owner
 * chain, compared with Effect's own `Equal` and `Hash` conventions.
 *
 * There is deliberately no serialization step. An earlier design required
 * every family to supply an injective string encoding of its key and spliced
 * those encodings into path strings, which made escaping and collision safety
 * the user's problem. Here the key is an ordinary Effect value and identity is
 * whatever `Equal.equals` says it is, exactly as `RcMap` and the Effect
 * collections do.
 *
 * The hash is computed once per identity: identities are created per desired
 * node per commit and then looked up repeatedly during a reconcile pass.
 */
export class Ident implements Equal.Equal {
  private hashCode: number | undefined

  constructor(
    readonly familyId: number,
    readonly key: unknown,
    readonly parent: Ident | null
  ) {}

  [Hash.symbol](): number {
    if (this.hashCode === undefined) {
      this.hashCode = Hash.combine(
        Hash.combine(Hash.number(this.familyId), this.parent === null ? 0 : Hash.hash(this.parent)),
        Hash.hash(this.key)
      )
    }
    return this.hashCode
  }

  [Equal.symbol](that: unknown): boolean {
    if (this === that) return true
    if (!(that instanceof Ident)) return false
    if (this.familyId !== that.familyId) return false
    // Hashes are cached, so an inequality is decided without walking the key
    // or the owner chain at all — the common case in a reconcile pass.
    if (this[Hash.symbol]() !== that[Hash.symbol]()) return false
    if (this.parent === null) {
      if (that.parent !== null) return false
    } else if (that.parent === null || !Equal.equals(this.parent, that.parent)) {
      return false
    }
    return Equal.equals(this.key, that.key)
  }
}

/**
 * Stands in for the key of a `one` family's replacement slot, which is
 * key-independent: `Session` under one owner has a single slot no matter which
 * user is desired. A symbol can never equal a user key value.
 */
export const oneSlot: unique symbol = Symbol.for("effect-reconciler/oneSlot")
