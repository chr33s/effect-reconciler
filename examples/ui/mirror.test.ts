/**
 * The mirror is where all the UI-adapter substance lives, so it is tested
 * headlessly: the React and Solid layers on top of it are thin enough to be
 * read, and their own tests check only what is framework-specific.
 */
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Option, type Scope } from "effect"
import * as Reconciler from "../../src/Reconciler.js"
import { idle } from "../../test/util.js"
import {
  bindConnections,
  connectionRef,
  defineConnections,
  emptyState,
  makeBehaviour,
  withHosts,
  type AppState
} from "./connections.js"
import * as Mirror from "./mirror.js"

const setup = () =>
  Effect.gen(function* () {
    const behaviour = makeBehaviour()
    const definition = defineConnections(behaviour)
    const controller = yield* Reconciler.make(bindConnections(definition))
    const mirror = yield* Mirror.make(controller)
    /** Converge the runtime, then bring the mirror up to date with it. */
    const settle = Effect.andThen(mirror.flush, Effect.andThen(idle(controller), mirror.flush))
    const ref = (host: string) => connectionRef(definition, host)
    return { behaviour, controller, mirror, settle, ref }
  })

describe("ui mirror", () => {
  it.live("reads None before the first refresh and the real status after it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { mirror, ref, settle } = yield* setup()
        const a = ref("a.example")

        // Nothing is watched yet, and nothing is desired.
        expect(mirror.statusOf(a)._tag).toBe("None")

        const seen: Array<string> = []
        yield* Effect.sync(() => mirror.watch(a, () => seen.push("changed")))
        mirror.commit(withHosts("a.example"))
        yield* settle

        expect(Option.getOrNull(mirror.statusOf(a))?._tag).toBe("Running")
        expect(seen.length).toBeGreaterThan(0)
      })
    ))

  it.live("returns the same status object while nothing has changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { mirror, ref, settle } = yield* setup()
        const a = ref("a.example")
        yield* Effect.sync(() => mirror.watch(a, () => {}))
        mirror.commit(withHosts("a.example"))
        yield* settle

        // This is the `useSyncExternalStore` contract: a getSnapshot that
        // allocates a fresh value every call re-renders forever.
        const first = mirror.statusOf(a)
        yield* settle
        yield* settle
        expect(mirror.statusOf(a)).toBe(first)
      })
    ))

  it.live("commits coalesce to the latest state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { behaviour, mirror, ref, settle } = yield* setup()
        const c = ref("c.example")
        yield* Effect.sync(() => mirror.watch(c, () => {}))

        // Three states in one turn, the way a UI produces them.
        mirror.commit(withHosts("a.example"))
        mirror.commit(withHosts("b.example"))
        mirror.commit(withHosts("c.example"))
        yield* settle

        expect(Option.getOrNull(mirror.statusOf(c))?._tag).toBe("Running")
        // Neither intermediate state was ever desired, so nothing opened for it.
        expect(behaviour.opened).toEqual(["c.example"])
      })
    ))

  it.live("surfaces a failure through status, and retry clears it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { behaviour, mirror, ref, settle } = yield* setup()
        const bad = ref("bad.example")
        behaviour.failing.add("bad.example")
        yield* Effect.sync(() => mirror.watch(bad, () => {}))

        mirror.commit(withHosts("bad.example"))
        yield* settle
        expect(Option.getOrNull(mirror.statusOf(bad))?._tag).toBe("Failed")

        // Retry is what the failed generation needs; the host itself is still
        // desired, so the semantic key never changes.
        behaviour.failing.delete("bad.example")
        mirror.retry(bad)
        yield* settle
        expect(Option.getOrNull(mirror.statusOf(bad))?._tag).toBe("Running")
        expect(behaviour.opened).toEqual(["bad.example"])
      })
    ))

  it.live("reports a Starting lifetime while its startup is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { behaviour, mirror, ref } = yield* setup()
        const slow = ref("slow.example")
        const gate = yield* Deferred.make<void>()
        behaviour.blocking.set("slow.example", Deferred.await(gate))

        // A wedged startup is exactly the case with no convergence barrier:
        // `idle` cannot complete while a lifetime is deliberately stuck. The
        // mirror's own notification is the barrier instead — which is only
        // possible because the runtime pushes. Waiting on it, rather than on
        // a clock, is the whole difference this test exists to show.
        const starting = yield* Deferred.make<void>()
        const running = yield* Deferred.make<void>()
        yield* Effect.sync(() =>
          mirror.watch(slow, () => {
            const tag = Option.getOrNull(mirror.statusOf(slow))?._tag
            if (tag === "Starting") Deferred.doneUnsafe(starting, Effect.void)
            if (tag === "Running") Deferred.doneUnsafe(running, Effect.void)
          })
        )

        mirror.commit(withHosts("slow.example"))
        yield* Deferred.await(starting)
        expect(Option.getOrNull(mirror.statusOf(slow))?._tag).toBe("Starting")

        yield* Deferred.succeed(gate, void 0)
        yield* Deferred.await(running)
        expect(Option.getOrNull(mirror.statusOf(slow))?._tag).toBe("Running")
      })
    ))

  it.live("re-reads when the runtime says something moved, and at no other time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const behaviour = makeBehaviour()
        const definition = defineConnections(behaviour)
        const controller = yield* Reconciler.make(bindConnections(definition))
        let reads = 0
        // Spreading keeps the controller's test hooks, so `idle` still works
        // through the wrapper; only the read the mirror actually makes is
        // instrumented. It takes one coherent `snapshot` per flush rather than
        // a `status` per watched lifetime, so counting snapshots is counting
        // times the mirror went to the runtime at all.
        const counted: typeof controller = {
          ...controller,
          snapshot: Effect.andThen(
            Effect.sync(() => {
              reads++
            }),
            controller.snapshot
          )
        }
        const mirror = yield* Mirror.make(counted)
        const a = connectionRef(definition, "a.example")
        yield* Effect.sync(() => mirror.watch(a, () => {}))

        mirror.commit(withHosts("a.example"))
        yield* Effect.andThen(mirror.flush, Effect.andThen(idle(counted), mirror.flush))
        expect(Option.getOrNull(mirror.statusOf(a))?._tag).toBe("Running")

        // Converged and watched. The mirror that polled read this lifetime
        // every 250 ms forever; this one has been told there is nothing to
        // read, and so reads nothing.
        const afterConverging = reads
        yield* Effect.sleep(400)
        expect(reads).toBe(afterConverging)

        // And it is not merely asleep: a real change still wakes it, with no
        // flush of the test's own. Withdrawal is two transitions — Stopping,
        // then gone — and the mirror is told about both.
        const gone = yield* Deferred.make<void>()
        yield* Effect.sync(() =>
          mirror.watch(a, () => {
            if (Option.isNone(mirror.statusOf(a))) Deferred.doneUnsafe(gone, Effect.void)
          })
        )
        mirror.commit(emptyState)
        yield* Deferred.await(gone)
        expect(reads).toBeGreaterThan(afterConverging)
      })
    ))

  it.live("a reference from another Definition does not take the mirror with it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const behaviour = makeBehaviour()
        const definition = defineConnections(behaviour)
        const controller = yield* Reconciler.make(bindConnections(definition))
        const defects: Array<unknown> = []
        const mirror = yield* Mirror.make(controller, {
          onDefect: (cause) => defects.push(cause)
        })
        const settle = Effect.andThen(mirror.flush, Effect.andThen(idle(controller), mirror.flush))

        // A component built this against a *different* Definition — two
        // Definitions in one app, or a duplicate installed copy of the
        // package. It cannot name anything in this runtime, so reading it is
        // a defect rather than a `None` that would be indistinguishable from
        // "not running".
        const foreign = connectionRef(defineConnections(makeBehaviour()), "a.example")
        const ours = connectionRef(definition, "a.example")

        const seen: Array<string> = []
        yield* Effect.sync(() => mirror.watch(foreign, () => seen.push("foreign")))
        yield* Effect.sync(() => mirror.watch(ours, () => seen.push("ours")))
        mirror.commit(withHosts("a.example"))
        yield* settle

        // The bad reference is reported once per read and costs its own
        // component its reading — and nothing else. `Effect.ignore` does not
        // catch a defect, so a mirror that used it lost the whole work loop
        // here: every lifetime on screen frozen at its last reading, silently.
        expect(defects.length).toBeGreaterThan(0)
        expect(Option.getOrNull(mirror.statusOf(ours))?._tag).toBe("Running")
        expect(seen).toContain("ours")

        // Still live afterwards: a later transition is still mirrored.
        mirror.commit(emptyState)
        yield* settle
        expect(mirror.statusOf(ours)._tag).toBe("None")
      })
    ))

  it.live("stops tracking a lifetime once nothing watches it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { mirror, ref, settle } = yield* setup()
        const a = ref("a.example")
        const unwatch = yield* Effect.sync(() => mirror.watch(a, () => {}))
        mirror.commit(withHosts("a.example"))
        yield* settle
        expect(Option.getOrNull(mirror.statusOf(a))?._tag).toBe("Running")

        yield* Effect.sync(unwatch)
        // Forgotten, not stale: an unwatched lifetime is no longer read, so
        // the mirror reports what it reports for anything it is not tracking.
        expect(mirror.statusOf(a)._tag).toBe("None")
      })
    ))

  it.live("reports a commit error instead of swallowing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const behaviour = makeBehaviour()
        const definition = defineConnections(behaviour)
        const controller = yield* Reconciler.make(bindConnections(definition))
        const errors: Array<string> = []
        const mirror = yield* Mirror.make<AppState>(controller, {
          onCommitError: (error) => errors.push(error._tag)
        })

        // A `many` selector that yields the same key twice cannot become
        // desire: that is a bug in the application, and the UI must hear it.
        mirror.commit(withHosts("dup.example", "dup.example"))
        yield* mirror.flush

        expect(errors).toEqual(["InvalidDesiredState"])
        // The previous desired snapshot stays authoritative.
        mirror.commit(emptyState)
        yield* mirror.flush
        expect(errors).toEqual(["InvalidDesiredState"])
      })
    ))
})
