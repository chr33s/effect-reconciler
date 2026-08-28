/**
 * Upstream Foldkit example, as written before `effect-reconciler` existed.
 *
 * Source: foldkit/examples/managed-resource-layer/src/main.ts (MIT), taken
 * verbatim apart from three mechanical changes, all noted in the README:
 *
 * - the view, its `@foldkit/ui` imports and the `Runtime.makeElement` entry
 *   are dropped, because the comparison measures coordination, not rendering;
 *   `init` becomes a plain Model;
 * - the engine layer moves to `../engine.js`, where its id comes from a
 *   counter rather than browser crypto;
 * - `evo` from `foldkit/struct` is spelled as an object spread, to avoid
 *   pulling the helper in for three call sites.
 *
 * Everything about how the resource's lifetime is coordinated is untouched.
 */
import { Context, Effect, Layer, Match as M, Number, Option, Schema as S } from "effect"
import { Command, ManagedResource, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { ComputeEngineService, engineLayer, type ComputeEngine } from "../engine.js"

const Engine = ManagedResource.tag<ComputeEngine>()("ComputeEngine")
type EngineService = ManagedResource.ServiceOf<typeof Engine>

// MODEL

export const EngineState = defineTaggedUnion({
  Off: {},
  Booting: {},
  Ready: { engineId: S.String },
  Failed: { reason: S.String }
})
export type EngineState = typeof EngineState.Type

export interface Model {
  readonly engine: EngineState
  readonly computeCount: number
  readonly maybeSquareResult: Option.Option<number>
}

// MESSAGE

export const Message = defineMessageUnion({
  ClickedStartEngine: {},
  ClickedStopEngine: {},
  StartedEngine: { engineId: S.String },
  StoppedEngine: {},
  FailedStartEngine: { reason: S.String },
  ClickedCompute: {},
  CompletedCompute: { result: S.Finite },
  SkippedCompute: {}
})

export type Message = typeof Message.Type

// COMMAND

export const Compute = Command.define("Compute", {
  args: { value: S.Finite },
  messages: [Message.CompletedCompute, Message.SkippedCompute],
  execute: ({ value }) =>
    Effect.gen(function* () {
      const engine = yield* Engine.get
      return Message.CompletedCompute({ result: engine.square(value) })
    }).pipe(
      Effect.catchTag("ResourceNotAvailable", () => Effect.succeed(Message.SkippedCompute()))
    )
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, EngineService>>(message, {
    ClickedStartEngine: () => ({
      model: { ...model, engine: EngineState.Booting() }
    }),

    ClickedStopEngine: () => ({
      model: { ...model, engine: EngineState.Off() }
    }),

    StartedEngine: ({ engineId }) => ({
      model: { ...model, engine: EngineState.Ready({ engineId }) }
    }),

    StoppedEngine: () => ({ model }),

    FailedStartEngine: ({ reason }) => ({
      model: { ...model, engine: EngineState.Failed({ reason }) }
    }),

    ClickedCompute: () => {
      const nextComputeCount = Number.increment(model.computeCount)
      return {
        model: { ...model, computeCount: nextComputeCount },
        commands: [Compute({ value: nextComputeCount })]
      }
    },

    CompletedCompute: ({ result }) => ({
      model: { ...model, maybeSquareResult: Option.some(result) }
    }),

    SkippedCompute: () => ({ model })
  })

// INIT

export const init: Model = {
  engine: EngineState.Off(),
  computeCount: 0,
  maybeSquareResult: Option.none()
}

// MANAGED RESOURCE

export const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
  engine: entry(S.Option(S.Null), {
    resource: Engine,
    modelToMaybeRequirements: (model) =>
      M.value(model.engine).pipe(
        M.tag("Booting", "Ready", () => Option.some(null)),
        M.tag("Off", "Failed", () => Option.none()),
        M.exhaustive
      ),
    acquire: () =>
      Layer.build(engineLayer).pipe(
        Effect.map((context) => Context.get(context, ComputeEngineService))
      ),
    release: () => Effect.void,
    onAcquired: ({ engineId }) => Message.StartedEngine({ engineId }),
    onReleased: () => Message.StoppedEngine(),
    onAcquireError: (error) => Message.FailedStartEngine({ reason: String(error) })
  })
}))
