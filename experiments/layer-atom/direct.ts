import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

/**
 * The no-helper baseline: a model Atom directly selects a Layer for an
 * AtomRuntime. This is intentionally tiny. Characterization tests record the
 * lifecycle semantics it actually provides before the experiment adds any
 * reconciliation machinery.
 */
export class DirectSession extends Context.Service<DirectSession, {
  readonly key: string
}>()("experiment/layer-atom/DirectSession") {}

export interface DirectProbe {
  readonly events: Array<string>
  readonly stopGates: Map<string, Deferred.Deferred<void>>
}

export const makeDirectProbe = (): DirectProbe => ({ events: [], stopGates: new Map() })

export interface DirectBaseline {
  readonly model: Atom.Writable<string>
  readonly runtime: Atom.AtomRuntime<DirectSession>
  readonly registry: AtomRegistry.AtomRegistry
  readonly set: (key: string) => void
  readonly mount: () => () => void
}

export const makeDirectBaseline = (
  probe: DirectProbe = makeDirectProbe()
): DirectBaseline => {
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      task()
      return () => {}
    }
  })
  const model = Atom.make("A")
  const runtime = Atom.context()((get) => {
    const key = get(model)
    return Layer.effect(
      DirectSession,
      Effect.gen(function* () {
        probe.events.push(`start:${key}`)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            probe.events.push(`stopping:${key}`)
            const gate = probe.stopGates.get(key)
            if (gate !== undefined) yield* Deferred.await(gate)
            probe.events.push(`stop:${key}`)
          }))
        return { key }
      })
    )
  })
  return {
    model,
    runtime,
    registry,
    set: (key) => registry.set(model, key),
    mount: () => registry.mount(runtime)
  }
}
