/**
 * Definition identity (spec.2 §9).
 *
 * A family's identity is the handle object, and a Definition's identity is a
 * per-call object compared by reference. Neither is a name or a number, so
 * neither can collide across Definitions that happen to declare families in
 * the same order, nor across two duplicate installed copies of this package
 * whose module-local counters would both start at one.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { HandleTypeId, type OneHandle } from "../src/Definition.js"
import * as Key from "../src/Key.js"
import * as Reconciler from "../src/Reconciler.js"

/** A handle-shaped value carrying the global brand but a foreign identity:
 * what a second installed copy of this package would hand you. */
const foreignHandle = (): OneHandle<string> =>
  ({
    [HandleTypeId]: "one",
    name: "Thing",
    identity: {},
    familyId: 0,
    key: Key.string,
    owner: undefined,
    requires: {},
    replacement: "sequential",
    start: () => Effect.void
  }) as unknown as OneHandle<string>

describe("definition identity", () => {
  it.live("rejects a foreign handle with the same name and family index", () =>
    Effect.gen(function* () {
      // Both Definitions declare one family named "Thing", so both handles
      // have family index 0 and the same label.
      const A = Reconciler.define((define) => ({
        Thing: define.one("Thing", { key: Key.string, start: () => Effect.void })
      }))
      const B = Reconciler.define((define) => ({
        Thing: define.one("Thing", { key: Key.string, start: () => Effect.void })
      }))

      expect(A.Thing.name).toBe(B.Thing.name)
      expect(A.Thing).not.toBe(B.Thing)

      const result = yield* Effect.result(
        Reconciler.make(A.bind<{}>((bind) => ({ thing: bind.one(B.Thing, () => Option.none()) })))
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("BindingError")
      }
    }))

  it.live("rejects a handle from another installed copy of the package", () =>
    Effect.gen(function* () {
      const foreign = foreignHandle()

      // As a binding target.
      const Def = Reconciler.define((define) => ({
        Thing: define.one("Thing", { key: Key.string, start: () => Effect.void })
      }))
      const bound = yield* Effect.result(
        Reconciler.make(Def.bind<{}>((bind) => ({ thing: bind.one(foreign, () => Option.none()) })))
      )
      expect(bound._tag).toBe("Failure")
      if (bound._tag === "Failure") {
        expect(bound.failure._tag).toBe("BindingError")
      }

      // As an owner.
      const Owned = Reconciler.define((define) => ({
        Child: define.one("Child", {
          key: Key.string,
          owner: foreign,
          start: () => Effect.void
        })
      }))
      const owned = yield* Effect.result(
        Reconciler.make(Owned.bind<{}>((bind) => ({ child: bind.one(Owned.Child, () => Option.none()) })))
      )
      expect(owned._tag).toBe("Failure")
      if (owned._tag === "Failure") {
        expect(owned.failure._tag).toBe("DefinitionError")
      }

      // As a capability requirement.
      const Requiring = Reconciler.define((define) => ({
        Dependent: define.one("Dependent", {
          key: Key.string,
          requires: { provider: foreign },
          start: () => Effect.void
        })
      }))
      const requiring = yield* Effect.result(
        Reconciler.make(
          Requiring.bind<{}>((bind) => ({
            dependent: bind.one(Requiring.Dependent, () => Option.none())
          }))
        )
      )
      expect(requiring._tag).toBe("Failure")
      if (requiring._tag === "Failure") {
        expect(requiring.failure._tag).toBe("DefinitionError")
      }
    }))

  it.live("a semantic reference names a family, not a family index", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      // Two families with the same key type; the second has family index 1.
      const Def = Reconciler.define((define) => ({
        First: define.one("First", {
          key: Key.string,
          start: (k: string) => Effect.sync(() => log.push(`first:${k}`))
        }),
        Second: define.one("Second", {
          key: Key.string,
          start: (k: string) => Effect.sync(() => log.push(`second:${k}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({
          first: bind.one(Def.First, () => Option.some("x")),
          second: bind.one(Def.Second, () => Option.none())
        }))
      )

      // Same key, different family: the references are not interchangeable.
      expect((yield* controller.status(Reconciler.ref(Def.First, "x", null)))._tag).toBe(
        "NotDesired"
      )
      yield* controller.commit({})
      yield* Effect.sleep(20)

      expect((yield* controller.status(Reconciler.ref(Def.First, "x", null)))._tag).toBe("Running")
      expect((yield* controller.status(Reconciler.ref(Def.Second, "x", null)))._tag).toBe(
        "NotDesired"
      )
      expect(log).toEqual(["first:x"])
    }))
})
