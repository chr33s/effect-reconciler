/**
 * The same feature after migrating its resource lifetime to
 * `effect-reconciler`.
 *
 * The Model no longer models the engine's lifecycle. `engineWanted` is what
 * the user asked for; whether an engine currently exists, and why not, is the
 * runtime's business and is read back through `controller.status`.
 */
import { Cause, Context, Effect, Layer, Number, Option, Schema as S, Stream } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Reconciler from "../../../src/Reconciler.js"
import { ComputeEngineService, engineLayer, type ComputeEngine } from "../engine.js"
import * as Driver from "../../foldkit/driver.js"

/**
 * @integration The reconciler owns the engine's lifetime, but a Command runs
 * outside every lifetime, so the application keeps its own handle on the
 * current instance. The lifetime fills it in and clears it on teardown.
 */
export class EngineHolder extends Context.Service<EngineHolder, {
  readonly current: () => Option.Option<ComputeEngine>
  readonly set: (engine: Option.Option<ComputeEngine>) => Effect.Effect<void>
}>()("app/EngineHolder") {}

export const makeEngineHolder = (): typeof EngineHolder.Service => {
  let current: Option.Option<ComputeEngine> = Option.none()
  return {
    current: () => current,
    set: (engine) =>
      Effect.sync(() => {
        current = engine
      })
  }
}

// MODEL

export interface Model {
  readonly engineWanted: boolean
  readonly computeCount: number
  readonly maybeSquareResult: Option.Option<number>
  readonly maybeEngineFailure: Option.Option<string>
}

export const init: Model = {
  engineWanted: false,
  computeCount: 0,
  maybeSquareResult: Option.none(),
  maybeEngineFailure: Option.none()
}

// MESSAGE

export const Message = defineMessageUnion({
  ClickedStartEngine: {},
  ClickedStopEngine: {},
  ClickedCompute: {},
  CompletedCompute: { result: S.Finite },
  SkippedCompute: {},
  /** @integration A lifetime the Model asked for could not start. */
  LifetimeFailed: { reason: S.String }
})

export type Message = typeof Message.Type

// COMMAND

export const Compute = Command.define("Compute", {
  args: { value: S.Finite },
  messages: [Message.CompletedCompute, Message.SkippedCompute],
  execute: ({ value }) =>
    Effect.gen(function* () {
      const holder = yield* EngineHolder
      return Option.match(holder.current(), {
        onNone: () => Message.SkippedCompute(),
        onSome: (engine) => Message.CompletedCompute({ result: engine.square(value) })
      })
    })
})

// UPDATE

/**
 * @integration Upstream, clicking Start after a failure re-acquired the
 * resource because the Model's `EngineState` went `Failed -> Booting`, which
 * changed the Managed Resource's requirements. Here the desire never changed —
 * the engine was wanted before and is wanted still — so asking for another
 * attempt is what it always was, and is now said out loud.
 */
export interface Retry {
  readonly engine: Update.Commands<Message, EngineHolder>
}

export const makeUpdate = (retry: Retry) =>
(model: Model, message: Message): Update.Return<Model, Message, EngineHolder> =>
  Message.match(message, {
    ClickedStartEngine: () => ({
      model: { ...model, engineWanted: true, maybeEngineFailure: Option.none() },
      commands: Option.isSome(model.maybeEngineFailure) ? retry.engine : []
    }),

    ClickedStopEngine: () => ({ model: { ...model, engineWanted: false } }),

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

    SkippedCompute: () => ({ model }),

    LifetimeFailed: ({ reason }) => ({
      model: { ...model, maybeEngineFailure: Option.some(reason) }
    })
  })

// LIFETIMES

export const Engines = Reconciler.define((define) => ({
  Engine: define.one("Engine", {
    start: (_: null) =>
      Effect.gen(function* () {
        const holder = yield* EngineHolder
        // The Layer is built into this lifetime's Scope, so its teardown is
        // the lifetime's teardown.
        const context = yield* Layer.build(engineLayer)
        yield* holder.set(Option.some(Context.get(context, ComputeEngineService)))
        yield* Effect.addFinalizer(() => holder.set(Option.none()))
        return context
      })
  })
}))

export const binding = Engines.bind<Model>((bind) => ({
  engine: bind.one(Engines.Engine, (model) =>
    model.engineWanted ? Option.some(null) : Option.none()
  )
}))

/** The engine lifetime, named semantically. */
export const engineRef = Reconciler.ref(Engines.Engine, null, null)

// INTEGRATION

/** @integration */
export const start = (holder: typeof EngineHolder.Service) =>
  Effect.gen(function* () {
    const controller = yield* Reconciler.make(binding).pipe(
      Effect.provideService(EngineHolder, holder),
      Effect.orDie
    )
    const session = yield* Driver.start<Model, Message, EngineHolder>({
      init,
      update: makeUpdate({
        engine: [
          {
            name: "RetryEngine",
            effect: Effect.as(controller.retry(engineRef), Message.SkippedCompute()).pipe(
              Effect.orElseSucceed(() => Message.SkippedCompute())
            )
          }
        ]
      }),
      onCommitted: (model) => Effect.ignore(controller.commit(model))
    }).pipe(Effect.provideService(EngineHolder, holder))

    yield* Effect.forkScoped(
      Stream.runForEach(controller.failures, (failure) =>
        session.dispatch(Message.LifetimeFailed({ reason: String(Cause.squash(failure.cause)) }))
      )
    )

    return { session, controller } as const
  })

// END
