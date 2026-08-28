/**
 * Lit bindings over the mirror.
 *
 * Lit gives an adapter two places to stand, and both are here because they
 * answer different questions:
 *
 * - A **reactive controller** attaches to an element and asks it to re-render
 *   when a lifetime's status changes. That is the right shape when the element
 *   *branches* on status — showing a retry button, disabling a control.
 * - An **async directive** subscribes from inside one binding in a template
 *   and writes to it alone. That is the right shape when the status is just a
 *   value on screen: nothing else in the element re-renders.
 *
 * Neither needs a context, because a controller is constructed by the element
 * and can simply be handed the mirror. The React side needs `MirrorProvider`
 * only because a hook cannot take a constructor argument.
 *
 * Two hazards shape everything below, neither of which exists in the React or
 * Solid adapters:
 *
 * 1. **Disconnection is not disposal.** Moving an element in the DOM
 *    disconnects and reconnects it, and Lit calls `hostDisconnected` then
 *    `hostConnected` (`disconnected` / `reconnected` for a directive). A
 *    subscription dropped on the way out has to be re-established on the way
 *    back in, or the element renders a status that stopped updating.
 * 2. **A render must not have side effects.** Watching happens in
 *    `hostConnected` / `hostUpdate`, committing in `hostUpdated` — before and
 *    after `render`, never inside it. This is the same rule as React's "commit
 *    from an effect, never during render", for the same reason.
 *
 * A reference is built inline wherever it is needed rather than cached, which
 * is only reasonable because `LifetimeRef` is a cheap, `Equal`-comparable hash
 * key — the same property the React and Solid adapters lean on.
 */
import { Equal, Option } from "effect"
import type { ReactiveController, ReactiveControllerHost } from "lit"
import { AsyncDirective } from "lit/async-directive.js"
import { directive } from "lit/directive.js"
import type { LifetimeRef } from "../../src/LifetimeRef.js"
import type { LifetimeStatus } from "../../src/Status.js"
import type { Mirror, StatusMirror } from "./mirror.js"

/** The status tag as a plain string, for anything that only branches on it. */
export type StatusTag = LifetimeStatus["_tag"] | "None"

const tagOf = (status: Option.Option<LifetimeStatus>): StatusTag =>
  Option.isNone(status) ? "None" : status.value._tag

/**
 * Watch one lifetime and re-render the host when its status changes.
 *
 * The reference is a function rather than a value so the element can follow a
 * *changing* lifetime — `() => connectionRef(definition, this.host)` — without
 * the controller being rebuilt when the property changes. It is re-read before
 * every render, which is when the element's own properties are settled.
 */
export class LifetimeStatusController implements ReactiveController {
  readonly #host: ReactiveControllerHost
  readonly #mirror: StatusMirror
  readonly #ref: () => LifetimeRef
  /** The reference currently watched, or `undefined` when not watching. */
  #watched: LifetimeRef | undefined
  #unwatch: (() => void) | undefined

  constructor(host: ReactiveControllerHost, mirror: StatusMirror, ref: () => LifetimeRef) {
    this.#host = host
    this.#mirror = mirror
    this.#ref = ref
    host.addController(this)
  }

  /**
   * The runtime's current answer. `None` means no physical generation exists —
   * not desired, not yet admitted, or superseded — and is also what a lifetime
   * reads for the first tick after it comes on screen.
   */
  get status(): Option.Option<LifetimeStatus> {
    return this.#mirror.statusOf(this.#ref())
  }

  get tag(): StatusTag {
    return tagOf(this.status)
  }

  /** Retire a Failed generation so a fresh one may start. */
  retry(): void {
    this.#mirror.retry(this.#ref())
  }

  hostConnected(): void {
    this.#sync()
  }

  /** Before render, so `render` reads the status of the reference it is
   * about to draw rather than the one the previous render drew. */
  hostUpdate(): void {
    this.#sync()
  }

  hostDisconnected(): void {
    this.#unwatch?.()
    this.#unwatch = undefined
    this.#watched = undefined
  }

  /** Watch what the element now points at, if that is not what is watched. */
  #sync(): void {
    const next = this.#ref()
    if (this.#unwatch !== undefined && Equal.equals(this.#watched, next)) return
    this.#unwatch?.()
    this.#watched = next
    this.#unwatch = this.#mirror.watch(next, () => this.#host.requestUpdate())
  }
}

/**
 * Publish the host's state as the desired state after every render.
 *
 * After, not during: committing is the one thing here that changes the world,
 * and a render that changes the world is a render that cannot be repeated.
 * Rendering more often than the state changes costs nothing — committing
 * semantically equal state is exactly zero churn, and commits coalesce.
 */
export class CommitStateController<State> implements ReactiveController {
  readonly #mirror: Mirror<State>
  readonly #state: () => State

  constructor(host: ReactiveControllerHost, mirror: Mirror<State>, state: () => State) {
    this.#mirror = mirror
    this.#state = state
    host.addController(this)
  }

  hostUpdated(): void {
    this.#mirror.commit(this.#state())
  }
}

/**
 * A status tag bound to one expression in a template.
 *
 * The directive owns its own subscription and writes through `setValue`, so a
 * status change updates that binding and nothing else — the element's `render`
 * is not called at all. Reach for it when the status is a value on screen; use
 * the controller when the element has to branch on it.
 */
class LifetimeTagDirective extends AsyncDirective {
  #mirror: StatusMirror | undefined
  #ref: LifetimeRef | undefined
  #unwatch: (() => void) | undefined

  render(mirror: StatusMirror, ref: LifetimeRef): StatusTag {
    if (this.#mirror !== mirror || !Equal.equals(this.#ref, ref)) {
      this.#unwatch?.()
      this.#unwatch = undefined
      this.#mirror = mirror
      this.#ref = ref
      // A directive can render while disconnected (its part is being
      // prepared); `reconnected` is what starts watching in that case.
      if (this.isConnected) this.#watch()
    }
    return tagOf(mirror.statusOf(ref))
  }

  protected override disconnected(): void {
    this.#unwatch?.()
    this.#unwatch = undefined
  }

  protected override reconnected(): void {
    this.#watch()
  }

  #watch(): void {
    const mirror = this.#mirror
    const ref = this.#ref
    if (mirror === undefined || ref === undefined) return
    this.#unwatch = mirror.watch(ref, () => {
      // Straight into the binding: the host element's `render` is not called.
      this.setValue(tagOf(mirror.statusOf(ref)))
    })
  }
}

/** `${lifetimeTag(mirror, connectionRef(definition, host))}` */
export const lifetimeTag = directive(LifetimeTagDirective)
