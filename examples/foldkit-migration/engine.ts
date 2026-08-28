/**
 * The compute engine from the upstream Foldkit example, unchanged except that
 * its id comes from a counter instead of `Crypto.randomUUIDv4`, so the
 * headless comparison is deterministic and needs no browser platform layer.
 *
 * Source: foldkit/examples/managed-resource-layer/src/main.ts (MIT).
 */
import { Context, Effect, Layer } from "effect"

export interface ComputeEngine {
  readonly engineId: string
  readonly square: (value: number) => number
}

export class ComputeEngineService extends Context.Service<
  ComputeEngineService,
  ComputeEngine
>()("ComputeEngineService") {}

/** Lifecycle events the tests assert against, in order. */
export const engineLog: Array<string> = []

let nextEngine = 1
let failNext = false

/** Make the next acquisition fail, as a real environment would. */
export const failNextBoot = (): void => {
  failNext = true
}

export const resetEngines = (): void => {
  engineLog.length = 0
  nextEngine = 1
  failNext = false
}

export class EngineUnavailable extends Error {
  readonly _tag = "EngineUnavailable"
  constructor() {
    super("engine unavailable")
  }
}

export const engineLayer: Layer.Layer<ComputeEngineService, EngineUnavailable> = Layer.effect(
  ComputeEngineService,
  Effect.acquireRelease(
    Effect.gen(function* () {
      if (failNext) {
        failNext = false
        engineLog.push("boot:failed")
        return yield* Effect.fail(new EngineUnavailable())
      }
      const engineId = `engine-${nextEngine++}`
      engineLog.push(`boot:${engineId}`)
      return { engineId, square: (value: number) => value * value }
    }),
    ({ engineId }) => Effect.sync(() => engineLog.push(`teardown:${engineId}`))
  )
)
