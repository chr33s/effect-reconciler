// @vitest-environment jsdom
/**
 * What is specific to React, and nothing else.
 *
 * The mirror's own behaviour is covered headlessly in `mirror.test.ts`; these
 * tests exist for the three things that only go wrong inside React: a status
 * that reaches the DOM, a `getSnapshot` stable enough not to loop, and
 * StrictMode's deliberate double-invocation.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Option, Scope } from "effect"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
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
import { MirrorProvider, useCommitState, useLifetimeTag, useRetry } from "./react.js"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Harness {
  readonly behaviour: Behaviour
  readonly definition: Connections
  readonly mirror: Mirror.Mirror<AppState>
  readonly settle: () => Promise<void>
  readonly container: HTMLElement
  readonly root: Root
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
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  return {
    behaviour,
    definition,
    mirror,
    settle: async () => {
      await act(async () => {
        await Effect.runPromise(
          Effect.andThen(mirror.flush, Effect.andThen(idle(controller), mirror.flush))
        )
      })
    },
    container,
    root,
    dispose: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }
}

const Connection = (props: { readonly definition: Connections; readonly host: string }) => {
  const tag = useLifetimeTag(connectionRef(props.definition, props.host))
  const retry = useRetry()
  return (
    <li>
      <span data-testid={`status-${props.host}`}>{tag}</span>
      <button
        data-testid={`retry-${props.host}`}
        onClick={() => retry(connectionRef(props.definition, props.host))}
      >
        retry
      </button>
    </li>
  )
}

const App = (props: {
  readonly definition: Connections
  readonly hosts: ReadonlyArray<string>
  readonly renders?: { count: number }
}) => {
  // The application's own state is the desired state; committing it is the
  // whole integration.
  const state = React.useMemo<AppState>(() => ({ hosts: props.hosts }), [props.hosts])
  useCommitState(state)
  if (props.renders !== undefined) props.renders.count += 1
  return (
    <ul>
      {props.hosts.map((host) => (
        <Connection key={host} definition={props.definition} host={host} />
      ))}
    </ul>
  )
}

const statusOf = (harness: Harness, host: string): string | null =>
  harness.container.querySelector(`[data-testid="status-${host}"]`)?.textContent ?? null

describe("react bindings", () => {
  it("renders a lifetime's status and follows it", async () => {
    const harness = await makeHarness()
    try {
      await act(async () => {
        harness.root.render(
          <MirrorProvider mirror={harness.mirror}>
            <App definition={harness.definition} hosts={["a.example"]} />
          </MirrorProvider>
        )
      })
      // Before the first refresh lands there is no generation to report.
      expect(statusOf(harness, "a.example")).toBe("None")

      await harness.settle()
      expect(statusOf(harness, "a.example")).toBe("Running")
      expect(harness.behaviour.opened).toEqual(["a.example"])
    } finally {
      await harness.dispose()
    }
  })

  it("does not restart lifetimes under StrictMode's double invocation", async () => {
    const harness = await makeHarness()
    try {
      const renders = { count: 0 }
      await act(async () => {
        harness.root.render(
          <React.StrictMode>
            <MirrorProvider mirror={harness.mirror}>
              <App definition={harness.definition} hosts={["a.example"]} renders={renders} />
            </MirrorProvider>
          </React.StrictMode>
        )
      })
      await harness.settle()

      // StrictMode renders twice and mounts, unmounts and remounts effects, so
      // the state is committed more than once on purpose. Committing
      // semantically equal desire is exactly zero churn, which is what makes
      // the integration safe to write the obvious way.
      expect(renders.count).toBeGreaterThan(1)
      expect(harness.behaviour.opened).toEqual(["a.example"])
      expect(harness.behaviour.closed).toEqual([])
      expect(statusOf(harness, "a.example")).toBe("Running")
    } finally {
      await harness.dispose()
    }
  })

  it("adds and removes lifetimes as the rendered state changes", async () => {
    const harness = await makeHarness()
    try {
      const render = async (hosts: ReadonlyArray<string>) => {
        await act(async () => {
          harness.root.render(
            <MirrorProvider mirror={harness.mirror}>
              <App definition={harness.definition} hosts={hosts} />
            </MirrorProvider>
          )
        })
        await harness.settle()
      }

      await render(["a.example", "b.example"])
      expect(statusOf(harness, "a.example")).toBe("Running")
      expect(statusOf(harness, "b.example")).toBe("Running")

      await render(["b.example"])
      expect(statusOf(harness, "a.example")).toBe(null)
      expect(statusOf(harness, "b.example")).toBe("Running")
      // `a` was dropped from desire; `b` was never touched.
      expect(harness.behaviour.closed).toEqual(["a.example"])
      expect(harness.behaviour.opened).toEqual(["a.example", "b.example"])
    } finally {
      await harness.dispose()
    }
  })

  it("retries a failed lifetime from a click", async () => {
    const harness = await makeHarness()
    try {
      harness.behaviour.failing.add("bad.example")
      await act(async () => {
        harness.root.render(
          <MirrorProvider mirror={harness.mirror}>
            <App definition={harness.definition} hosts={["bad.example"]} />
          </MirrorProvider>
        )
      })
      await harness.settle()
      expect(statusOf(harness, "bad.example")).toBe("Failed")

      harness.behaviour.failing.delete("bad.example")
      const button = harness.container.querySelector<HTMLButtonElement>(
        '[data-testid="retry-bad.example"]'
      )!
      await act(async () => {
        button.click()
      })
      await harness.settle()

      expect(statusOf(harness, "bad.example")).toBe("Running")
      expect(harness.behaviour.opened).toEqual(["bad.example"])
    } finally {
      await harness.dispose()
    }
  })
})
