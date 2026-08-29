/**
 * The migration check: the same user story against the upstream Foldkit app
 * and its migrated version, judged on what each did to the engine.
 *
 * The engine's own log — boot and teardown, in order — is the observable both
 * versions share. Their Models deliberately do not match: replacing the
 * lifecycle half of the Model is the point of the migration.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, type Scope } from "effect"
import * as Driver from "../foldkit/driver.js"
import * as After from "./after/main.js"
import * as Before from "./before/main.js"
import { engineLog, failNextBoot, resetEngines } from "./engine.js"

/** Both versions converge asynchronously; wait the way an application would. */
const quiet = Effect.suspend(() => Effect.sleep(30))

interface Subject {
  readonly name: string
  readonly start: () => Effect.Effect<
    {
      readonly startEngine: Effect.Effect<void>
      readonly stopEngine: Effect.Effect<void>
      readonly compute: Effect.Effect<void>
      readonly squareResult: () => Option.Option<number>
      readonly engineId: () => Option.Option<string>
      readonly failure: () => Option.Option<string>
    },
    never,
    Scope.Scope
  >
}

const before: Subject = {
  name: "before (upstream Foldkit example)",
  start: () =>
    Effect.gen(function* () {
      const session = yield* Driver.start({
        init: Before.init,
        update: Before.update,
        managedResources: Before.managedResources
      })
      const send = (message: Before.Message) =>
        Effect.andThen(Effect.andThen(session.dispatch(message), session.settled), quiet)
      return {
        startEngine: send(Before.Message.ClickedStartEngine()),
        stopEngine: send(Before.Message.ClickedStopEngine()),
        compute: send(Before.Message.ClickedCompute()),
        squareResult: () => session.model().maybeSquareResult,
        engineId: () => {
          const engine = session.model().engine
          return engine._tag === "Ready" ? Option.some(engine.engineId) : Option.none()
        },
        failure: () => {
          const engine = session.model().engine
          return engine._tag === "Failed" ? Option.some(engine.reason) : Option.none()
        }
      }
    })
}

const after: Subject = {
  name: "after (reconciler-coordinated)",
  start: () =>
    Effect.gen(function* () {
      const holder = After.makeEngineHolder()
      const { session } = yield* After.start(holder)
      const send = (message: After.Message) =>
        Effect.andThen(Effect.andThen(session.dispatch(message), session.settled), quiet)
      return {
        startEngine: send(After.Message.ClickedStartEngine()),
        stopEngine: send(After.Message.ClickedStopEngine()),
        compute: send(After.Message.ClickedCompute()),
        squareResult: () => session.model().maybeSquareResult,
        // The engine's id lives in the engine, not in the Model.
        engineId: () => Option.map(holder.current(), (engine) => engine.engineId),
        failure: () => session.model().maybeEngineFailure
      }
    })
}

describe("managed-resource-layer migration", () => {
  for (const subject of [before, after]) {
    describe(subject.name, () => {
      it.live("boots on demand, computes against it, and tears down", () =>
        Effect.gen(function* () {
          resetEngines()
          const app = yield* subject.start()

          // Nothing exists until the user asks for it, and a compute before
          // that is skipped rather than failing.
          yield* app.compute
          expect(engineLog).toEqual([])
          expect(Option.getOrNull(app.squareResult())).toBe(null)

          yield* app.startEngine
          expect(engineLog).toEqual(["boot:engine-1"])
          expect(Option.getOrNull(app.engineId())).toBe("engine-1")

          yield* app.compute
          expect(Option.getOrNull(app.squareResult())).toBe(4)

          yield* app.stopEngine
          expect(engineLog).toEqual(["boot:engine-1", "teardown:engine-1"])
          expect(Option.getOrNull(app.engineId())).toBe(null)

          // ...and starting again is a new engine, not a resurrection.
          yield* app.startEngine
          expect(engineLog).toEqual([
            "boot:engine-1",
            "teardown:engine-1",
            "boot:engine-2"
          ])
        }))

      it.live("tears down a live engine when the session Scope closes", () =>
        Effect.gen(function* () {
          resetEngines()
          yield* Effect.scoped(
            Effect.gen(function* () {
              const app = yield* subject.start()
              yield* app.startEngine
              expect(engineLog).toEqual(["boot:engine-1"])
            })
          )
          expect(engineLog).toEqual(["boot:engine-1", "teardown:engine-1"])
        }))

      it.live("surfaces a boot failure and recovers from it", () =>
        Effect.gen(function* () {
          resetEngines()
          const app = yield* subject.start()

          failNextBoot()
          yield* app.startEngine
          expect(engineLog).toEqual(["boot:failed"])
          expect(Option.isSome(app.failure())).toBe(true)

          // A compute while it is down is skipped, not an error.
          yield* app.compute
          expect(Option.getOrNull(app.squareResult())).toBe(null)

          // Asking again, with the environment healthy, boots it.
          yield* app.startEngine
          expect(engineLog).toEqual(["boot:failed", "boot:engine-1"])
          expect(Option.getOrNull(app.failure())).toBe(null)
          yield* app.compute
          expect(Option.getOrNull(app.squareResult())).toBe(4)
        }))
    })
  }
})
