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
import type { GenerationId, LifetimeEntry, Snapshot } from "../../src/Snapshot.js"

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

/** What a lifetime is called on screen: family and key, no owner chain. */
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
 * Children are grouped by their owner's **generation**, never by anything
 * derived from the owner's `LifetimeRef`. A reference names a lifetime, and
 * one lifetime can have two generations in a snapshot at once — a `Stopping`
 * one draining beside the `Running` one replacing it. Grouping by reference
 * draws every child under both of them and shows each generation the other's
 * children. Grouping by generation is exact, needs no string encoding of a
 * key (`Snapshot` deliberately has none, and inventing one here would put
 * escaping and collision safety back on this file), and costs one map probe
 * per entry instead of rebuilding an owner path three times.
 *
 * The snapshot promises owners before children, so one pass over it builds
 * the whole thing: every entry's owner has already been placed.
 */
const tree = (snapshot: Snapshot): ReadonlyArray<string> => {
  const present = new Set(snapshot.lifetimes.map((entry) => entry.generation))
  const children = new Map<GenerationId, Array<LifetimeEntry>>()
  const roots: Array<LifetimeEntry> = []
  for (const entry of snapshot.lifetimes) {
    const owner = entry.owner
    // A generation can outlive its owner in the snapshot: an owner whose
    // close has finished is forgotten, while a child that had its own close
    // in flight is skipped by that sweep and dropped later by its own fiber.
    // Drawing such an entry at the root is a strange-looking panel; not
    // drawing it is a panel that has quietly lost a lifetime, which is worse.
    if (owner === null || !present.has(owner)) {
      roots.push(entry)
      continue
    }
    const list = children.get(owner)
    if (list === undefined) children.set(owner, [entry])
    else list.push(entry)
  }

  const lines: Array<string> = []
  const draw = (entry: LifetimeEntry, prefix: string, last: boolean): void => {
    lines.push(`${prefix}${prefix === "" ? "" : last ? "└─ " : "├─ "}${label(entry.lifetime)}  ${statusText(entry)}`)
    const kids = children.get(entry.generation) ?? []
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
 * avoid repainting a terminal that has not changed.
 *
 * Compared structurally, because that is the question being asked. Every
 * `Controller.snapshot` allocates a fresh value, so a host refreshing on a
 * timer would repaint on every tick if this compared snapshots by reference —
 * which is exactly the work it exists to avoid. Entries are plain records of
 * an `Equal`-comparable reference, a status and two generation tokens, so
 * `Equal.equals` answers it directly. */
export const same = (a: PanelModel, b: PanelModel): boolean =>
  a.recent === b.recent && Equal.equals(a.diagnostics, b.diagnostics) &&
  Equal.equals(a.snapshot.lifetimes, b.snapshot.lifetimes)
