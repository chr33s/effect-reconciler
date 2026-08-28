// @vitest-environment jsdom
/**
 * What is specific to Lit.
 *
 * The mirror is already tested; what is left is what only goes wrong inside a
 * custom element. Chiefly that **disconnection is not disposal** — an element
 * that is moved is disconnected and reconnected, and a subscription dropped on
 * the way out has to come back on the way in — and that the two ways to bind a
 * status, a controller and a directive, each hold that up on their own.
 *
 * The two are deliberately exercised by *separate* elements. Put both in one
 * element and they mask each other: the mirror tracks a lifetime as long as
 * anything watches it, so a controller that forgot to re-watch still reads the
 * right status through the directive's subscription, and a directive that
 * forgot to re-watch is still refreshed by the controller's re-render.
 */
import { describe, expect, it } from "vitest"
import { Deferred, Effect, Exit, Option, Scope } from "effect"
import { LitElement, html } from "lit"
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
import { CommitStateController, LifetimeStatusController, lifetimeTag } from "./lit.js"

interface Harness {
  readonly behaviour: Behaviour
  readonly definition: Connections
  readonly mirror: Mirror.Mirror<AppState>
  /** Converge the runtime, then let every pending element update land. */
  readonly settle: (...elements: ReadonlyArray<LitElement>) => Promise<void>
  /**
   * A real-time window instead of a convergence barrier. `idle` never
   * completes while a startup is deliberately wedged, so a test that wants to
   * observe `Starting` has no barrier available to it.
   */
  readonly quiesce: (...elements: ReadonlyArray<LitElement>) => Promise<void>
  readonly dispose: () => Promise<void>
}

/** A notification schedules an update rather than performing one, and an
 * update may schedule another; drain until every element is quiet. */
const quiet = async (elements: ReadonlyArray<LitElement>): Promise<void> => {
  for (const element of elements) {
    while (!(await element.updateComplete)) { /* another update was queued */ }
  }
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
    settle: async (...elements) => {
      // The elements' own updates have to land first: watching happens in
      // `hostUpdate` and committing in `hostUpdated`, so before that there is
      // nothing for the controller to converge.
      await quiet(elements)
      await Effect.runPromise(
        Effect.andThen(mirror.flush, Effect.andThen(idle(controller), mirror.flush))
      )
      await quiet(elements)
    },
    quiesce: async (...elements) => {
      await quiet(elements)
      await Effect.runPromise(Effect.andThen(Effect.sleep(80), mirror.flush))
      await quiet(elements)
    },
    dispose: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }
}

/**
 * The controller half: an element that commits the hosts it wants, branches on
 * one connection's status, and offers the retry that `Failed` calls for.
 */
class ConnectionPanel extends LitElement {
  static properties = {
    hostName: {},
    hosts: { attribute: false }
  }

  declare hostName: string
  declare hosts: ReadonlyArray<string>
  /** Set before the element is connected; not reactive, never changes. */
  mirror!: Mirror.Mirror<AppState>
  definition!: Connections
  renders = 0

  #status: LifetimeStatusController | undefined

  get status(): LifetimeStatusController {
    if (this.#status === undefined) throw new Error("not connected yet")
    return this.#status
  }

  constructor() {
    super()
    this.hostName = ""
    this.hosts = []
  }

  override connectedCallback(): void {
    // Controllers are created once, before the first update — and *not* in
    // `render`, which would attach a fresh subscription on every render.
    if (this.#status === undefined) {
      this.#status = new LifetimeStatusController(this, this.mirror, () =>
        connectionRef(this.definition, this.hostName))
      new CommitStateController(this, this.mirror, () => ({ hosts: this.hosts }) as AppState)
    }
    super.connectedCallback()
  }

  override render() {
    this.renders++
    const tag = this.status.tag
    return html`
      <span id="tag">${tag}</span>
      ${tag === "Failed"
        ? html`<button id="retry" @click=${() => this.status.retry()}>retry</button>`
        : null}
    `
  }
}
customElements.define("connection-panel", ConnectionPanel)

/**
 * The directive half, alone in an element so a render count means something.
 * It only reads: committing is somebody else's job, which is the point — a
 * status can be shown anywhere without that place owning the state.
 */
class LifetimeTagOnly extends LitElement {
  static properties = { hostName: {} }

  declare hostName: string
  mirror!: Mirror.StatusMirror
  definition!: Connections
  renders = 0

  constructor() {
    super()
    this.hostName = ""
  }

  override render() {
    this.renders++
    return html`<span id="tag">${
      lifetimeTag(this.mirror, connectionRef(this.definition, this.hostName))
    }</span>`
  }
}
customElements.define("lifetime-tag-only", LifetimeTagOnly)

const mountPanel = (harness: Harness, hostName: string): ConnectionPanel => {
  const element = new ConnectionPanel()
  element.mirror = harness.mirror
  element.definition = harness.definition
  element.hostName = hostName
  element.hosts = [hostName]
  document.body.append(element)
  return element
}

const mountTag = (harness: Harness, hostName: string): LifetimeTagOnly => {
  const element = new LifetimeTagOnly()
  element.mirror = harness.mirror
  element.definition = harness.definition
  element.hostName = hostName
  document.body.append(element)
  return element
}

const textOf = (element: LitElement, id: string): string =>
  element.shadowRoot?.querySelector(`#${id}`)?.textContent?.trim() ?? "unrendered"

const trackedTag = (harness: Harness, host: string): string =>
  Option.getOrNull(harness.mirror.statusOf(connectionRef(harness.definition, host)))?._tag ?? "None"

describe("lit bindings", () => {
  it("commits state and renders a lifetime's status", async () => {
    const harness = await makeHarness()
    const element = mountPanel(harness, "a.example")
    try {
      // The first render happens before anything has converged, and a lifetime
      // nothing has watched yet reads `None` rather than guessing.
      await element.updateComplete
      expect(textOf(element, "tag")).toBe("None")

      await harness.settle(element)
      expect(textOf(element, "tag")).toBe("Running")
      expect(harness.behaviour.opened).toEqual(["a.example"])
    } finally {
      element.remove()
      await harness.dispose()
    }
  })

  it("follows a changing property to a different lifetime", async () => {
    const harness = await makeHarness()
    const element = mountPanel(harness, "a.example")
    try {
      await harness.settle(element)
      expect(textOf(element, "tag")).toBe("Running")

      element.hostName = "b.example"
      element.hosts = ["b.example"]
      await harness.settle(element)

      // The element reports the *new* lifetime, and the old one is gone: the
      // controller re-watched in `hostUpdate`, before the render that read it.
      expect(textOf(element, "tag")).toBe("Running")
      expect(trackedTag(harness, "b.example")).toBe("Running")
      expect(trackedTag(harness, "a.example")).toBe("None")
      expect(harness.behaviour.opened).toEqual(["a.example", "b.example"])
      expect(harness.behaviour.closed).toEqual(["a.example"])
    } finally {
      element.remove()
      await harness.dispose()
    }
  })

  it("surfaces a failure and retries from a click", async () => {
    const harness = await makeHarness()
    harness.behaviour.failing.add("bad.example")
    const element = mountPanel(harness, "bad.example")
    try {
      await harness.settle(element)
      expect(textOf(element, "tag")).toBe("Failed")

      harness.behaviour.failing.delete("bad.example")
      // The retry button only exists in the Failed branch, so clicking it is
      // itself an assertion that the element rendered that branch.
      element.shadowRoot?.querySelector<HTMLButtonElement>("#retry")?.click()
      await harness.settle(element)
      expect(textOf(element, "tag")).toBe("Running")
    } finally {
      element.remove()
      await harness.dispose()
    }
  })

  it("stops watching on disconnect and resumes on reconnect", async () => {
    const harness = await makeHarness()
    const element = mountPanel(harness, "a.example")
    try {
      await harness.settle(element)
      expect(trackedTag(harness, "a.example")).toBe("Running")

      element.remove()
      // Nothing renders this lifetime, so the mirror stops tracking it — the
      // resource itself is untouched, which is the whole point of the split.
      expect(trackedTag(harness, "a.example")).toBe("None")
      expect(harness.behaviour.closed).toEqual([])

      // A move is a disconnect followed by a connect, and Lit does not
      // re-render on reconnect — so `hostConnected` is the only thing that can
      // put the subscription back. The rendered DOM cannot tell you whether it
      // did: it still says "Running" either way. The mirror can.
      document.body.append(element)
      await harness.settle(element)
      expect(trackedTag(harness, "a.example")).toBe("Running")
      expect(element.status.tag).toBe("Running")
      expect(harness.behaviour.opened).toEqual(["a.example"])
    } finally {
      element.remove()
      await harness.dispose()
    }
  })

  it("updates the directive's binding without re-rendering the element", async () => {
    const harness = await makeHarness()
    // A host whose startup blocks, so the status is observed to *change* with
    // no property write anywhere near the element.
    const gate = await Effect.runPromise(Deferred.make<void>())
    harness.behaviour.blocking.set("slow.example", Deferred.await(gate))
    harness.mirror.commit({ hosts: ["slow.example"] })

    const element = mountTag(harness, "slow.example")
    try {
      await harness.quiesce(element)
      expect(textOf(element, "tag")).toBe("Starting")
      const renders = element.renders

      await Effect.runPromise(Deferred.succeed(gate, void 0))
      await harness.settle(element)

      // The directive wrote its own binding. Nothing asked the element to
      // render, and it did not.
      expect(textOf(element, "tag")).toBe("Running")
      expect(element.renders).toBe(renders)
    } finally {
      element.remove()
      await harness.dispose()
    }
  })

  it("keeps the directive's subscription across a disconnect", async () => {
    const harness = await makeHarness()
    harness.mirror.commit({ hosts: ["a.example"] })
    const element = mountTag(harness, "a.example")
    try {
      await harness.settle(element)
      expect(textOf(element, "tag")).toBe("Running")

      element.remove()
      expect(trackedTag(harness, "a.example")).toBe("None")

      // `reconnected` is the directive's only chance: the element is not
      // re-rendered, so `render` will not run and re-subscribe for it.
      document.body.append(element)
      await harness.settle(element)
      expect(trackedTag(harness, "a.example")).toBe("Running")
    } finally {
      element.remove()
      await harness.dispose()
    }
  })
})
