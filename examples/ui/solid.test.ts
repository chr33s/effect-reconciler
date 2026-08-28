// @vitest-environment jsdom
/**
 * What is specific to Solid.
 *
 * Most of this needs no DOM: the point is that a status change re-runs the
 * computation that read it, that watching is tied to the owner, and that
 * disposing the root stops the mirror tracking what the UI no longer shows.
 * The last test does touch the DOM, to show that the signal drives a real
 * node — which is all a compiled Solid component does with it.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Option, Scope } from "effect"
import { createEffect, createRoot, createSignal, flush, type Accessor } from "solid-js"
import * as Reconciler from "../../src/Reconciler.js"
import { idle } from "../../test/util.js"
import {
  bindConnections,
  connectionRef,
  defineConnections,
  makeBehaviour,
  type AppState,
  type Behaviour,
  type Connections
} from "./connections.js"
import * as Mirror from "./mirror.js"
import { commitState, createLifetimeTag } from "./solid.js"

interface Harness {
  readonly behaviour: Behaviour
  readonly definition: Connections
  readonly mirror: Mirror.Mirror<AppState>
  readonly settle: () => Promise<void>
  readonly dispose: () => Promise<void>
}

const makeHarness = async (): Promise<Harness> => {
  const scope = await Effect.runPromise(Scope.make())
  const behaviour = makeBehaviour()
  const definition = defineConnections(behaviour)
  const { controller, mirror } = await Effect.runPromise(
    Effect.provideService(
      Effect.gen(function* () {
        const controller = yield* Reconciler.make(bindConnections(definition))
        const mirror = yield* Mirror.make<AppState>(controller)
        return { controller, mirror }
      }),
      Scope.Scope,
      scope
    )
  )
  return {
    behaviour,
    definition,
    mirror,
    settle: async () => {
      // Solid 2.0 queues effects rather than running them at creation, so the
      // first flush is what registers the watches and commits the state the
      // controller is about to be asked to converge.
      flush()
      await Effect.runPromise(
        Effect.andThen(mirror.flush, Effect.andThen(idle(controller), mirror.flush))
      )
      // The mirror's listeners wrote signals; a write is visible to a read
      // only once the queue drains.
      flush()
    },
    dispose: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }
}

describe("solid bindings", () => {
  it("tracks a lifetime's status in a signal", async () => {
    const harness = await makeHarness()
    let dispose = () => {}
    try {
      let tag: Accessor<string> = () => "unread"
      createRoot((d) => {
        dispose = d
        const [hosts, setHosts] = createSignal<ReadonlyArray<string>>(["a.example"])
        commitState(harness.mirror, () => ({ hosts: hosts() }) as AppState)
        tag = createLifetimeTag(harness.mirror, () => connectionRef(harness.definition, "a.example"))
        void setHosts
      })

      expect(tag()).toBe("None")
      await harness.settle()
      expect(tag()).toBe("Running")
      expect(harness.behaviour.opened).toEqual(["a.example"])
    } finally {
      dispose()
      await harness.dispose()
    }
  })

  it("follows a changing reference and commits changing state", async () => {
    const harness = await makeHarness()
    let dispose = () => {}
    try {
      let tag: Accessor<string> = () => "unread"
      let setHost: (host: string) => void = () => {}
      createRoot((d) => {
        dispose = d
        const [host, set] = createSignal("a.example")
        setHost = (next) => set(next)
        commitState(harness.mirror, () => ({ hosts: [host()] }) as AppState)
        tag = createLifetimeTag(harness.mirror, () => connectionRef(harness.definition, host()))
      })

      await harness.settle()
      expect(tag()).toBe("Running")

      setHost("b.example")
      await harness.settle()
      // The signal now reports the *new* lifetime, and the old one is gone.
      expect(tag()).toBe("Running")
      expect(harness.behaviour.opened).toEqual(["a.example", "b.example"])
      expect(harness.behaviour.closed).toEqual(["a.example"])
    } finally {
      dispose()
      await harness.dispose()
    }
  })

  it("surfaces a failure and retries from the UI", async () => {
    const harness = await makeHarness()
    let dispose = () => {}
    try {
      harness.behaviour.failing.add("bad.example")
      let tag: Accessor<string> = () => "unread"
      createRoot((d) => {
        dispose = d
        commitState(harness.mirror, () => ({ hosts: ["bad.example"] }) as AppState)
        tag = createLifetimeTag(harness.mirror, () =>
          connectionRef(harness.definition, "bad.example"))
      })

      await harness.settle()
      expect(tag()).toBe("Failed")

      harness.behaviour.failing.delete("bad.example")
      harness.mirror.retry(connectionRef(harness.definition, "bad.example"))
      await harness.settle()
      expect(tag()).toBe("Running")
    } finally {
      dispose()
      await harness.dispose()
    }
  })

  it("drives a real DOM node from the status signal", async () => {
    const harness = await makeHarness()
    let dispose = () => {}
    const node = document.createElement("span")
    try {
      createRoot((d) => {
        dispose = d
        commitState(harness.mirror, () => ({ hosts: ["a.example"] }) as AppState)
        const tag = createLifetimeTag(harness.mirror, () =>
          connectionRef(harness.definition, "a.example"))
        // The same compute/apply split Solid's compiled JSX generates for an
        // interpolated value, minus the render-queue scheduling.
        createEffect(tag, (current) => {
          node.textContent = current
        })
      })

      await harness.settle()
      expect(node.textContent).toBe("Running")
    } finally {
      dispose()
      await harness.dispose()
    }
  })

  it("stops tracking once the owning root is disposed", async () => {
    const harness = await makeHarness()
    let dispose = () => {}
    try {
      createRoot((d) => {
        dispose = d
        commitState(harness.mirror, () => ({ hosts: ["a.example"] }) as AppState)
        createLifetimeTag(harness.mirror, () => connectionRef(harness.definition, "a.example"))
      })
      await harness.settle()
      const ref = connectionRef(harness.definition, "a.example")
      expect(Option.getOrNull(harness.mirror.statusOf(ref))?._tag).toBe("Running")

      dispose()
      dispose = () => {}
      // Disposal unwatches, so the mirror stops tracking a lifetime nothing
      // is rendering — the resource itself is unaffected.
      expect(harness.mirror.statusOf(ref)._tag).toBe("None")
      expect(harness.behaviour.closed).toEqual([])
    } finally {
      dispose()
      await harness.dispose()
    }
  })
})
