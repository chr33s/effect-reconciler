/**
 * A DevTools panel for a running Reconciler.
 *
 * There is a version of "DevTools" that is a browser extension, and this is
 * not it. What a panel actually needs from a runtime is three things, and all
 * three are now on the Controller: a coherent picture of every lifetime
 * (`snapshot`), a reason for each thing that happened (`events`), and totals
 * (`diagnostics`). Everything below is assembly — a view model kept up to
 * date, and a renderer that turns it into text.
 *
 * Keeping it that way is the point. The panel holds no state the runtime does
 * not already hold, so it cannot drift from it; it renders into a string, so
 * it can be asserted on in a test and printed in a terminal without a DOM;
 * and a real panel in React, Lit or a browser extension is the same view
 * model with a different `render`. Nothing here is privileged: an application
 * could have written all of it.
 *
 * The one rule it follows is the one the observation contract sets. **The
 * tree comes from `snapshot`; the reasons come from `events`.** Events are
 * lossy and may be missed, so they are never the source of what exists — only
 * of why it came to. A panel that built its tree from events would slowly
 * lie, and would have no way of finding out.
 */
import { Effect, Equal, Stream } from "effect"
import type { Diagnostics, ReconcileEvent } from "../../src/Diagnostics.js"
import type { Controller } from "../../src/Reconciler.js"
import type { LifetimeEntry, Snapshot } from "../../src/Snapshot.js"

/** How many recent events the panel keeps. A window, not a log. */
const HISTORY = 40

export interface PanelModel {
  readonly snapshot: Snapshot
  readonly diagnostics: Diagnostics
  /** Most recent last. Bounded, because a panel is a window on a running
   * system and not an audit trail of one. */
  readonly recent: ReadonlyArray<ReconcileEvent>
}

export interface Panel {
  /** The current view model. Synchronous, so a render can read it. */
  readonly model: () => PanelModel
  /** Render the current model as text. */
  readonly render: () => string
  /** Re-read the runtime now. The background fibers call exactly this. */
  readonly refresh: Effect.Effect<void>
}

const label = (entry: LifetimeEntry["lifetime"]): string =>
  `${entry.family.name}:${String(entry.key)}`

/** `Failed(cause)` is the one status with something to say; the rest are a
 * word. A panel that printed the whole cause inline would be unreadable, and
 * one that dropped it would be useless for the only status that matters. */
const statusText = (entry: LifetimeEntry): string => {
  if (entry.status._tag !== "Failed") return entry.status._tag
  const [first] = String(entry.status.cause).split("\n")
  return `Failed — ${first ?? "unknown"}`
}

const eventText = (event: ReconcileEvent): string => {
  switch (event._tag) {
    case "Committed":
      return `commit · ${event.desired} desired`
    case "Admitted":
      return `admit  · ${label(event.lifetime)}`
    case "Started":
      return `start  · ${label(event.lifetime)}`
    case "StartupFailed":
      return `FAIL   · ${label(event.lifetime)}`
    case "Retired":
      // The reason is the whole value of the event stream: it is the one
      // thing `status` cannot tell you, and the usual first question.
      return `retire · ${label(event.lifetime)} (${event.reason})`
    case "Stopped":
      return `stop   · ${label(event.lifetime)}`
    case "PassCompleted":
      return `pass   · +${event.admitted} -${event.retired}${event.settled ? " settled" : ""}`
  }
}

/**
 * The tree, drawn from the snapshot alone.
 *
 * The snapshot promises owners before children, so one pass over it builds
 * the whole thing: every entry's owner has already been placed.
 */
const tree = (snapshot: Snapshot): ReadonlyArray<string> => {
  const children = new Map<string, Array<LifetimeEntry>>()
  const roots: Array<LifetimeEntry> = []
  for (const entry of snapshot.lifetimes) {
    const parent = entry.lifetime.parent
    if (parent === null) {
      roots.push(entry)
      continue
    }
    const key = label(parent)
    const list = children.get(key)
    if (list === undefined) children.set(key, [entry])
    else list.push(entry)
  }

  const lines: Array<string> = []
  const draw = (entry: LifetimeEntry, prefix: string, last: boolean): void => {
    lines.push(`${prefix}${prefix === "" ? "" : last ? "└─ " : "├─ "}${label(entry.lifetime)}  ${statusText(entry)}`)
    const kids = children.get(label(entry.lifetime)) ?? []
    const nextPrefix = prefix === "" ? "  " : `${prefix}${last ? "   " : "│  "}`
    kids.forEach((kid, index) => draw(kid, nextPrefix, index === kids.length - 1))
  }
  roots.forEach((root, index) => draw(root, "", index === roots.length - 1))
  return lines
}

export const render = (model: PanelModel): string => {
  const { diagnostics: d, recent, snapshot } = model
  const counts = d.lifetimes
  const skipped = d.selectorEvaluationsSkipped > 0
    ? `  (${d.selectorEvaluationsSkipped} skipped)`
    : ""
  return [
    `lifetimes  ${counts.total} total · ${counts.running} running · ${counts.starting} starting · ${counts.failed} failed · ${counts.stopping} stopping`,
    `totals     ${d.commits} commits · ${d.passes} passes · ${d.admitted} admitted · ${d.started} started · ${d.startupFailures} failed · ${d.stopped} stopped · ${d.retries} retries`,
    `selectors  ${d.selectorEvaluations} evaluated${skipped}`,
    `state      ${d.settled ? "settled" : "converging"}`,
    "",
    ...(snapshot.lifetimes.length === 0 ? ["(nothing running)"] : tree(snapshot)),
    "",
    "recent",
    ...(recent.length === 0 ? ["  (nothing yet)"] : recent.map((e) => `  ${eventText(e)}`))
  ].join("\n")
}

/**
 * Attach a panel to a Controller.
 *
 * Two subscriptions, for the two different things they are good for.
 * `changes` says when the tree may have moved, so the panel re-reads it — no
 * polling, and no work at all while nothing is happening. `events` fills the
 * reason column, and is allowed to miss things, which is why it is never
 * consulted for what exists.
 */
export const make = <State>(
  controller: Controller<State>
): Effect.Effect<Panel, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    let recent: Array<ReconcileEvent> = []
    let current: PanelModel = {
      snapshot: yield* controller.snapshot,
      diagnostics: yield* controller.diagnostics,
      recent
    }

    const refresh: Effect.Effect<void> = Effect.gen(function* () {
      const snapshot = yield* controller.snapshot
      const diagnostics = yield* controller.diagnostics
      current = { snapshot, diagnostics, recent }
    })

    // Reasons first, so that by the time a change signal makes the panel
    // re-read the tree, the events explaining it are usually already in hand.
    yield* Effect.forkScoped(
      Stream.runForEach(controller.events, (event) =>
        Effect.sync(() => {
          recent = [...recent, event].slice(-HISTORY)
          current = { ...current, recent }
        }))
    )
    yield* Effect.forkScoped(Stream.runForEach(controller.changes, () => refresh))

    return {
      model: () => current,
      render: () => render(current),
      refresh
    }
  })

/** True when two models would render identically — for a host that wants to
 * avoid repainting a terminal that has not changed. */
export const same = (a: PanelModel, b: PanelModel): boolean =>
  a.recent === b.recent && Equal.equals(a.diagnostics, b.diagnostics) &&
  a.snapshot === b.snapshot
