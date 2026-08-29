/**
 * Diagnostics: the event stream and the counters (spec §9.7).
 *
 * Both exist to explain the runtime, and the tests hold them to that and to
 * its limit. An event says *why* something happened — which is the one thing
 * `status` cannot tell you, and the reason a DevTools view is worth having.
 * It is still not authoritative, and nothing here should ever read as though
 * it were.
 */
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Option, Queue, Stream, type Scope } from "effect"
import type { ReconcileEvent } from "../src/Diagnostics.js"
import * as Reconciler from "../src/Reconciler.js"
import { hooks, idle, StartupFailed } from "./util.js"

class Settings extends Context.Service<Settings, { readonly revision: number }>()(
  "test/DiagSettings"
) {}

interface Model {
  readonly settings: Option.Option<number>
  readonly docs: ReadonlyArray<string>
}

const makeApp = () => {
  const Def = Reconciler.define((define) => {
    const Config = define.one("Config", {
      start: (revision: number) => Effect.succeed(Context.make(Settings, { revision }))
    })
    const Doc = define.many("Doc", {
      requires: { settings: Config },
      start: (uri: string) =>
        uri === "bad.ts" ? new StartupFailed({ reason: uri }) : Effect.void
    })
    const Analyzer = define.many("Analyzer", {
      owner: Doc,
      start: (_: null) => Effect.void
    })
    return { Config, Doc, Analyzer }
  })
  return {
    Def,
    binding: Def.bind<Model>((b) => ({
      config: b.one(Def.Config, (m) => m.settings),
      docs: b.many(Def.Doc, (m) => m.docs),
      analyzer: b.many(Def.Analyzer, () => [null])
    }))
  }
}

/**
 * Subscribe, and wait long enough for the subscription to be established.
 *
 * `Stream.toQueue` runs the stream in a forked fiber, so the subscription
 * exists a moment after this Effect returns, and events published in that
 * moment are not delivered. There is no barrier for it — the channel is
 * explicitly lossy at its start, and giving it one would mean promising a
 * completeness a diagnostic stream must not promise. A real-time window is
 * the honest way to test a channel that only offers one.
 */
const eventQueue = <S>(
  controller: Reconciler.Controller<S>
): Effect.Effect<Queue.Dequeue<ReconcileEvent, never>, never, Scope.Scope> =>
  Effect.tap(
    Stream.toQueue(controller.events, { capacity: 1024 }) as Effect.Effect<
      Queue.Dequeue<ReconcileEvent, never>,
      never,
      Scope.Scope
    >,
    () => Effect.sleep(30)
  )

const drain = (
  queue: Queue.Dequeue<ReconcileEvent, never>
): Effect.Effect<Array<ReconcileEvent>> =>
  Effect.gen(function* () {
    const out: Array<ReconcileEvent> = []
    while (true) {
      const next = yield* Effect.timeoutOption(Effect.result(Queue.take(queue)), 20)
      if (Option.isNone(next) || next.value._tag === "Failure") return out
      if (next.value.success !== undefined) out.push(next.value.success)
    }
  })

const named = (events: ReadonlyArray<ReconcileEvent>, tag: ReconcileEvent["_tag"]) =>
  events
    .filter((e) => e._tag === tag)
    .map((e) => ("lifetime" in e ? `${e.lifetime.family.name}:${String(e.lifetime.key)}` : tag))

describe("event stream", () => {
  it.live("§9.7 — names why a generation was retired", () =>
    Effect.gen(function* () {
      const { Def, binding } = makeApp()
      const controller = yield* Reconciler.make(binding)
      const events = yield* eventQueue(controller)

      yield* controller.commit({ settings: Option.some(1), docs: ["a.ts", "b.ts"] })
      yield* idle(controller)
      yield* drain(events)

      // One document withdrawn. Its Analyzer's own key is still desired in
      // the abstract, but there is no owner for it to hang under, so both are
      // reported for the reason that is actually true of them.
      yield* controller.commit({ settings: Option.some(1), docs: ["a.ts"] })
      yield* idle(controller)
      const withdrawn = yield* drain(events)
      const reasons = withdrawn
        .filter((e) => e._tag === "Retired")
        .map((e) => `${e.lifetime.family.name}:${e.reason}`)
      expect(reasons).toContain("Doc:desire")

      // The provider replaced. This is the case no `status` read can explain
      // and the whole reason to look at events: the document was not touched
      // by the application at all, and its analyzer was not touched by
      // anything the application can even name.
      yield* controller.commit({ settings: Option.some(2), docs: ["a.ts"] })
      yield* idle(controller)
      const replaced = yield* drain(events)
      const providerReasons = replaced
        .filter((e) => e._tag === "Retired")
        .map((e) => `${e.lifetime.family.name}:${e.reason}`)
      expect(providerReasons).toContain("Config:desire")
      expect(providerReasons).toContain("Doc:provider")
      expect(providerReasons).toContain("Analyzer:owner")
      expect(Def.Doc.name).toBe("Doc")
    }))

  it.live("§9.7 — reports the lifecycle of one generation in order", () =>
    Effect.gen(function* () {
      const { binding } = makeApp()
      const controller = yield* Reconciler.make(binding)
      const events = yield* eventQueue(controller)

      yield* controller.commit({ settings: Option.some(1), docs: ["a.ts", "bad.ts"] })
      yield* idle(controller)
      yield* controller.commit({ settings: Option.some(1), docs: [] })
      yield* idle(controller)

      const all = yield* drain(events)
      expect(named(all, "Admitted")).toContain("Doc:a.ts")
      expect(named(all, "Started")).toContain("Doc:a.ts")
      expect(named(all, "StartupFailed")).toContain("Doc:bad.ts")
      expect(named(all, "Stopped")).toContain("Doc:a.ts")
      // A failed startup is never Started, and a started one never fails.
      expect(named(all, "Started")).not.toContain("Doc:bad.ts")
      expect(named(all, "StartupFailed")).not.toContain("Doc:a.ts")

      const order = (tag: ReconcileEvent["_tag"]) =>
        all.findIndex((e) => e._tag === tag && "lifetime" in e && e.lifetime.key === "a.ts")
      expect(order("Admitted")).toBeLessThan(order("Started"))
      expect(order("Started")).toBeLessThan(order("Stopped"))
    }))

  it.live("§9.7 — retains nothing for a Controller nobody is watching", () =>
    Effect.gen(function* () {
      const { binding } = makeApp()
      const controller = yield* Reconciler.make(binding)

      yield* controller.commit({ settings: Option.some(1), docs: ["a.ts"] })
      yield* idle(controller)

      // Not a replay log: what happened before anyone subscribed is gone, and
      // it is `status` and `snapshot` that answer for the state it left.
      const events = yield* eventQueue(controller)
      expect(yield* drain(events)).toEqual([])
      // Config, the document, and the analyzer under it.
      expect((yield* controller.snapshot).lifetimes.length).toBe(3)
    }))

  it.live("§9.7 — constructs events only while a subscription is active", () =>
    Effect.gen(function* () {
      const { binding } = makeApp()
      const controller = yield* Reconciler.make(binding)

      // Obtaining the stream is not subscribing to it.
      const events = controller.events
      expect(yield* hooks(controller).eventSubscribers).toBe(0)

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Stream.toQueue(events, { capacity: 16 })
          yield* Effect.sleep(30)
          expect(yield* hooks(controller).eventSubscribers).toBe(1)
        })
      )

      // Ending the subscription turns construction back off.
      expect(yield* hooks(controller).eventSubscribers).toBe(0)
    }))
})

describe("counters", () => {
  it.live("§9.7 — selector counts what was evaluated, not what was published", () =>
    Effect.gen(function* () {
      const { binding } = makeApp()
      const controller = yield* Reconciler.make(binding)

      yield* controller.commit({ settings: Option.some(1), docs: ["a.ts"] })
      yield* idle(controller)
      const before = (yield* controller.diagnostics).selectorEvaluations
      expect(before).toBeGreaterThan(0)

      // Every selector ran; the desired state they produced is invalid, so
      // nothing is published. The evaluations happened either way, and that is
      // the whole distinction: a counter copied at evaluation time and written
      // in the publication region never records them at all — and, because
      // evaluation happens outside the mutex, two concurrent commits can write
      // those copies out of order and hand a reader a *negative* rate between
      // two samples. Read from the memory under the mutex, the count is what
      // the runtime actually did.
      const failed = yield* Effect.result(
        controller.commit({ settings: Option.some(1), docs: ["dup.ts", "dup.ts"] })
      )
      expect(failed._tag).toBe("Failure")
      const after = (yield* controller.diagnostics).selectorEvaluations
      expect(after).toBeGreaterThan(before)

      // And so it is worth subtracting: successive readings never go back.
      const readings: Array<number> = [after]
      for (let round = 0; round < 6; round++) {
        yield* Effect.all(
          [
            controller.commit({ settings: Option.some(round), docs: ["a.ts"] }),
            controller.commit({ settings: Option.some(round), docs: ["a.ts", "b.ts"] })
          ],
          { concurrency: "unbounded" }
        )
        readings.push((yield* controller.diagnostics).selectorEvaluations)
      }
      for (let i = 1; i < readings.length; i++) {
        expect(readings[i]!).toBeGreaterThanOrEqual(readings[i - 1]!)
      }
    }))

  it.live("§9.7 — count what the runtime did, and are always available", () =>
    Effect.gen(function* () {
      const { binding } = makeApp()
      const controller = yield* Reconciler.make(binding)

      // Never subscribed to `events`: counters do not depend on that.
      yield* controller.commit({ settings: Option.some(1), docs: ["a.ts", "bad.ts"] })
      yield* idle(controller)

      const after = yield* controller.diagnostics
      expect(after.commits).toBe(1)
      expect(after.passes).toBeGreaterThan(0)
      expect(after.admitted).toBe(4) // Config, two Docs, one Analyzer
      expect(after.started).toBe(3)
      expect(after.startupFailures).toBe(1)
      expect(after.lifetimes).toEqual({
        starting: 0,
        running: 3,
        failed: 1,
        stopping: 0,
        total: 4
      })
      expect(after.settled).toBe(true)

      // An equivalent commit costs selector evaluations and nothing else,
      // which is the claim §8.4 makes, stated as a number.
      yield* controller.commit({ settings: Option.some(1), docs: ["a.ts", "bad.ts"] })
      yield* idle(controller)
      const again = yield* controller.diagnostics
      expect(again.commits).toBe(2)
      expect(again.admitted).toBe(after.admitted)
      expect(again.stopped).toBe(after.stopped)
      expect(again.selectorEvaluations).toBeGreaterThan(after.selectorEvaluations)
    }))
})
