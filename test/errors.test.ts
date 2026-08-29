/**
 * The public error algebra (spec §10).
 *
 * Every expected failure is Effect-style tagged data carrying the family it
 * concerns, so recovery is ordinary `catchTag` / `catchTags` work and never
 * string inspection.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, type Scope } from "effect"
import type { BindingError, DefinitionError } from "../src/Errors.js"
import * as Reconciler from "../src/Reconciler.js"
import { idle } from "./util.js"

/**
 * The whole Definition/Binding algebra handled by tag in one `catchTags`.
 * That this compiles exhaustively, with each case's own fields in scope, is
 * the ergonomics claim.
 */
const explain = <A>(
  effect: Effect.Effect<A, DefinitionError | BindingError, Scope.Scope>
): Effect.Effect<string, never, Scope.Scope> =>
  effect.pipe(
    Effect.as("started"),
    Effect.catchTags({
      AmbiguousProvider: (error) =>
        Effect.succeed(
          `${error.family.name}.${error.requirement} cannot name one ${error.provider.name}`
        ),
      UnresolvableProvider: (error) =>
        Effect.succeed(`${error.family.name}.${error.requirement} cannot reach ${error.provider.name}`),
      ForeignOwner: (error) => Effect.succeed(`foreign owner of ${error.family.name}`),
      ForeignRequirement: (error) =>
        Effect.succeed(`foreign requirement ${error.family.name}.${error.requirement}`),
      OwnershipCycle: (error) => Effect.succeed(`ownership cycle at ${error.family.name}`),
      CapabilityCycle: (error) => Effect.succeed(`capability cycle at ${error.family.name}`),
      ForeignHandle: (error) => Effect.succeed(`foreign handle bound as ${error.label}`),
      MissingBinding: (error) => Effect.succeed(`missing binding for ${error.family.name}`),
      MissingObservation: (error) =>
        Effect.succeed(`no projection for ${error.family.name}, which observes state`),
      UnexpectedObservation: (error) =>
        Effect.succeed(`${error.family.name} observes nothing, so it needs no projection`),
      DuplicateBinding: (error) => Effect.succeed(`duplicate binding for ${error.family.name}`),
      CardinalityMismatch: (error) =>
        Effect.succeed(`${error.family.name} is ${error.declared}, bound as ${error.used}`)
    })
  )

describe("error algebra", () => {
  it.live("a definition error is recovered by tag, with the family in hand", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => {
        const Provider = define.many("Provider", { start: (_k: string) => Effect.void })
        const Dependent = define.one("Dependent", {
          requires: { provider: Provider },
          start: (_: null) => Effect.void
        })
        return { Provider, Dependent }
      })
      const bound = Def.bind<{}>((bind) => ({
        provider: bind.many(Def.Provider, () => []),
        dependent: bind.one(Def.Dependent, () => Option.some(null))
      }))

      expect(yield* explain(Reconciler.make(bound))).toBe(
        "Dependent.provider cannot name one Provider"
      )
    }))

  it.live("a binding error names the selector the application wrote", () =>
    Effect.gen(function* () {
      const A = Reconciler.define((define) => ({
        Thing: define.one("Thing", { start: (_k: string) => Effect.void })
      }))
      const B = Reconciler.define((define) => ({
        Other: define.one("Other", { start: (_k: string) => Effect.void })
      }))

      const label = yield* explain(
        Reconciler.make(A.bind<{}>((bind) => ({ misnamed: bind.one(B.Other, () => Option.none()) })))
      )

      expect(label).toBe("foreign handle bound as misnamed")
    }))

  it.live("a missing binding names the family that has no selector", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => ({
        First: define.one("First", { start: (_k: string) => Effect.void }),
        Second: define.one("Second", { start: (_k: string) => Effect.void })
      }))

      const missing = yield* explain(
        // `Second` is never bound.
        Reconciler.make(Def.bind<{}>((bind) => ({ first: bind.one(Def.First, () => Option.none()) })))
      )

      expect(missing).toBe("missing binding for Second")
    }))

  it.live("commit errors discriminate their reason", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Doc: define.many("Doc", {
          start: (uri: string) => Effect.sync(() => log.push(uri))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly docs: ReadonlyArray<string> }>((bind) => ({
          docs: bind.many(Def.Doc, (s) => s.docs)
        }))
      )

      const duplicate = yield* controller.commit({ docs: ["a", "a"] }).pipe(
        Effect.as("committed"),
        Effect.catchTags({
          InvalidDesiredState: (error) =>
            Effect.succeed(
              error.reason._tag === "DuplicateDesiredKey"
                ? `duplicate ${error.reason.family.name}:${String(error.reason.key)}`
                : error.reason._tag
            ),
          ControllerClosed: () => Effect.succeed("closed")
        })
      )
      expect(duplicate).toBe("duplicate Doc:a")

      // The previous desire stayed authoritative, so the controller is fine.
      yield* controller.commit({ docs: ["a"] })
      yield* idle(controller)
      expect(log).toEqual(["a"])

      yield* controller.shutdown
      const closed = yield* controller.commit({ docs: ["b"] }).pipe(
        Effect.as("committed"),
        Effect.catchTags({
          ControllerClosed: () => Effect.succeed("closed"),
          InvalidDesiredState: () => Effect.succeed("invalid")
        })
      )
      expect(closed).toBe("closed")
    }))
})
