/**
 * Observed state and nested Reconcilers (spec §9.10).
 *
 * Observation is the one channel by which a *running* lifetime sees state
 * change instead of being replaced by it, so the tests are about what that
 * must not become: it must not start or stop anything, it must not fire for a
 * projection that did not change, and it must not reach a generation that is
 * on its way out. `Reconciler.nested` is then the three lines that fall out
 * of it, and the tests hold it to the ownership closure a nested runtime is
 * only worth having if it inherits.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Logger, Option, Ref, Stream, SubscriptionRef } from "effect"
import * as Reconciler from "../src/Reconciler.js"
import { eventually, idle, quietFor, statusTag } from "./util.js"

interface Inner {
  readonly docs: ReadonlyArray<string>
}
interface Outer {
  readonly workspace: Option.Option<string>
  readonly docsByWorkspace: Readonly<Record<string, ReadonlyArray<string>>>
  readonly noise: number
}

describe("observed state", () => {
  it.live("§9.10 — a running lifetime sees the projection change without restarting", () =>
    Effect.gen(function* () {
      const starts: Array<string> = []
      const seen: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          observes: Reconciler.observed<number>(),
          start: (key: string, observed) =>
            Effect.gen(function* () {
              starts.push(key)
              yield* Effect.forkScoped(
                Stream.runForEach(SubscriptionRef.changes(observed), (n) =>
                  Effect.sync(() => {
                    seen.push(`${key}=${n}`)
                  }))
              )
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string; readonly value: number }>((b) => ({
          res: b.one(Def.Res, (m) => Option.some(m.key), { observe: (m) => m.value })
        }))
      )
      const latest = () => seen[seen.length - 1]

      // What observation promises is convergence, not a transcript. Both the
      // reconcile pass and the ref's own subscription coalesce, and §11 is
      // explicit that no intermediate state is guaranteed to be materialized
      // — so every assertion here is about where the observer ends up.
      yield* controller.commit({ key: "a", value: 1 })
      yield* eventually(() => latest() === "a=1", "the initial projection")

      yield* controller.commit({ key: "a", value: 2 })
      yield* controller.commit({ key: "a", value: 3 })
      yield* eventually(() => latest() === "a=3", "the latest of a burst")

      // One lifetime throughout. The key never changed, so nothing was
      // replaced — which is the entire distinction between observing state
      // and keying on it.
      expect(starts).toEqual(["a"])

      // An unchanged projection is not news, for the same reason an
      // equivalent commit is not churn (§8.4). Nothing can prove an absence
      // except waiting for it.
      const before = seen.length
      yield* controller.commit({ key: "a", value: 3 })
      yield* idle(controller)
      yield* quietFor()
      expect(seen.length).toBe(before)

      // And the key still governs identity: change it and the lifetime is
      // replaced, observation or no observation.
      yield* controller.commit({ key: "b", value: 3 })
      yield* eventually(() => latest() === "b=3", "the replacement's projection")
      expect(starts).toEqual(["a", "b"])
    }))

  it.live("§9.10 — a start that takes observed state must declare it", () =>
    Effect.gen(function* () {
      const Inner = Reconciler.define((define) => ({
        Doc: define.many("Doc", { start: (_uri: string) => Effect.void })
      }))
      const innerBinding = Inner.bind<Inner>((b) => ({ docs: b.many(Inner.Doc, (m) => m.docs) }))
      const Outer = Reconciler.define((define) => ({
        // `nested` takes the observation parameter by construction, so it
        // always needs `observes` beside it — and the type system cannot say
        // so, because with no `observes` that parameter's type is `never`,
        // which every argument type satisfies.
        Host: define.one("Host", { start: Reconciler.nested<string>()(innerBinding) })
      }))
      const result = yield* Effect.result(
        Reconciler.make(
          Outer.bind<{ readonly host: string }>((b) => ({
            host: b.one(Outer.Host, (m) => Option.some(m.host))
          }))
        )
      )
      // Named, at `make`, about a named family — not a `TypeError` about
      // reading a property of undefined, from inside a startup Effect.
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ObservationRequired")
      }
    }))

  it.live("§9.10 — a `start` that merely takes a second parameter is not a mistake", () =>
    Effect.gen(function* () {
      const started: Array<string> = []
      // A two-parameter helper reused as `start`. It observes nothing, ignores
      // the second argument, and is exactly what a function-arity check would
      // condemn — while the type system accepts it, because with no `observes`
      // the parameter's type is `never` and `never` satisfies every annotation.
      const helper = (uri: string, _unused: unknown) =>
        Effect.sync(() => {
          started.push(uri)
        })
      const Def = Reconciler.define((define) => ({
        Doc: define.many("Doc", { start: helper })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly docs: ReadonlyArray<string> }>((b) => ({
          docs: b.many(Def.Doc, (m) => m.docs)
        }))
      )

      yield* controller.commit({ docs: ["a.ts"] })
      yield* eventually(() => started.includes("a.ts"), "the family started")
    }))

  it.live("§9.10 — a projection for a family that observes nothing is rejected", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", { start: (_key: string) => Effect.void })
      }))
      const binding = Def.bind<{ readonly key: string }>((b) => ({
        // Nothing would ever read this, and with no `observes` there is
        // nothing for the type of `observe` to be checked against — so the
        // Binding compiler settles it rather than letting it pass silently.
        res: b.one(Def.Res, (m) => Option.some(m.key), { observe: (m) => m.key })
      }))
      const result = yield* Effect.result(Reconciler.make(binding))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("UnexpectedObservation")
      }
    }))

  it.live("§9.10 — a Binding that does not project is rejected at make", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          observes: Reconciler.observed<number>(),
          start: (_key: string) => Effect.void
        })
      }))
      const binding = Def.bind<{ readonly key: string }>((b) => ({
        // No `observe`, for a family that declared it needs one.
        res: b.one(Def.Res, (m) => Option.some(m.key)) as never
      }))
      const result = yield* Effect.result(Reconciler.make(binding))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("MissingObservation")
      }
    }))
})

describe("nested reconcilers", () => {
  const makeNested = (opened: Array<string>) => {
    const Inner = Reconciler.define((define) => ({
      Doc: define.many("Doc", {
        start: (uri: string) =>
          Effect.gen(function* () {
            opened.push(uri)
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                opened.push(`-${uri}`)
              })
            )
          })
      })
    }))
    const innerBinding = Inner.bind<Inner>((b) => ({
      docs: b.many(Inner.Doc, (m) => m.docs)
    }))

    const Outer = Reconciler.define((define) => ({
      Workspace: define.one("Workspace", {
        observes: Reconciler.observed<Inner>(),
        start: Reconciler.nested<string>()(innerBinding)
      })
    }))
    return {
      Inner,
      Outer,
      binding: Outer.bind<Outer>((b) => ({
        workspace: b.one(Outer.Workspace, (m) => m.workspace, {
          observe: (m, owner) => ({
            docs: Option.isSome(m.workspace) ? m.docsByWorkspace[m.workspace.value] ?? [] : []
          })
        })
      }))
    }
  }

  it.live("§9.10 — the child reconciles on the parent's commits", () =>
    Effect.gen(function* () {
      const opened: Array<string> = []
      const { Outer, binding } = makeNested(opened)
      const controller = yield* Reconciler.make(binding)

      yield* controller.commit({
        workspace: Option.some("w1"),
        docsByWorkspace: { w1: ["a.ts", "b.ts"] },
        noise: 0
      })
      yield* idle(controller)
      yield* Effect.sleep(30)
      expect(opened.slice().sort()).toEqual(["a.ts", "b.ts"])

      // A parent commit that does not change the projection reaches the child
      // not at all; one that does costs the child one commit, over its own
      // families only.
      opened.length = 0
      yield* controller.commit({
        workspace: Option.some("w1"),
        docsByWorkspace: { w1: ["a.ts", "b.ts"] },
        noise: 1
      })
      yield* idle(controller)
      yield* Effect.sleep(30)
      expect(opened).toEqual([])

      yield* controller.commit({
        workspace: Option.some("w1"),
        docsByWorkspace: { w1: ["b.ts", "c.ts"] },
        noise: 1
      })
      yield* idle(controller)
      yield* Effect.sleep(40)
      expect(opened.slice().sort()).toEqual(["-a.ts", "c.ts"])

      // The parent knows nothing about the child's lifetimes: two runtimes,
      // two identity spaces, which is the cost the modularity is bought with.
      expect(
        (yield* controller.snapshot).lifetimes.map((e) => e.lifetime.family.name)
      ).toEqual(["Workspace"])
      expect(yield* statusTag(controller, Reconciler.ref(Outer.Workspace, "w1", null)))
        .toBe("Running")
    }))

  it.live("§9.10 — tearing down a nested host is not a fault", () => {
    const logged: Array<string> = []
    const opened: Array<string> = []
    return Effect.gen(function* () {
      const { binding } = makeNested(opened)
      const controller = yield* Reconciler.make(binding)

      yield* controller.commit({
        workspace: Option.some("w1"),
        docsByWorkspace: { w1: ["a.ts"] },
        noise: 0
      })
      yield* idle(controller)
      yield* quietFor()

      // Teardown with a projection still in flight, which is the shape the
      // forwarding loop's `ControllerClosed` guard is there for: the child
      // Controller is shut down by the closing of the host's Scope, and the
      // fiber forwarding projections into it is interrupted by the same close.
      // A commit that lost that race must not surface as a defect.
      //
      // The ordering is the runtime's, so this cannot force the race — the
      // assertion is that teardown is silent and complete however it resolves,
      // which is what would break if a commit landing in the window ever
      // became a fault.
      yield* controller.commit({
        workspace: Option.some("w1"),
        docsByWorkspace: { w1: ["b.ts"] },
        noise: 0
      })
      const exit = yield* Effect.exit(controller.shutdown)

      expect(exit._tag).toBe("Success")
      expect(logged).toEqual([])
      // Everything the child had open is closed, by ownership.
      expect(opened.filter((e) => !e.startsWith("-")).sort())
        .toEqual(opened.filter((e) => e.startsWith("-")).map((e) => e.slice(1)).sort())
    }).pipe(
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([Logger.make(({ message }) => {
          logged.push(Array.isArray(message) ? message.map(String).join(" ") : String(message))
        })])
      )
    )
  })

  it.live("§9.10 — a projection the child cannot accept stops the loop and says so", () => {
    const logged: Array<string> = []
    const opened: Array<string> = []
    return Effect.gen(function* () {
      const Inner = Reconciler.define((define) => ({
        Doc: define.many("Doc", {
          start: (uri: string) =>
            Effect.acquireRelease(
              Effect.sync(() => opened.push(uri)),
              () => Effect.sync(() => opened.push(`-${uri}`))
            )
        })
      }))
      const innerBinding = Inner.bind<Inner>((b) => ({ docs: b.many(Inner.Doc, (m) => m.docs) }))
      const Outer = Reconciler.define((define) => ({
        Host: define.one("Host", {
          observes: Reconciler.observed<Inner>(),
          start: Reconciler.nested<string>()(innerBinding)
        })
      }))
      const controller = yield* Reconciler.make(
        Outer.bind<Outer>((b) => ({
          host: b.one(Outer.Host, (m) => m.workspace, {
            observe: (m) => ({
              docs: m.docsByWorkspace[Option.getOrElse(m.workspace, () => "")] ?? []
            })
          })
        }))
      )
      const hostRef = Reconciler.ref(Outer.Host, "w1", null)

      yield* controller.commit({
        workspace: Option.some("w1"),
        docsByWorkspace: { w1: ["a.ts"] },
        noise: 0
      })
      yield* eventually(() => opened.includes("a.ts"), "the child is following")

      // A projection the child's Binding cannot turn into a desired state — a
      // duplicate key, rejected at the child's own `commit`. The host's
      // resources are all healthy, so `status` has nothing to report about it,
      // which is exactly why the loop says it out loud instead.
      yield* controller.commit({
        workspace: Option.some("w1"),
        docsByWorkspace: { w1: ["b.ts", "b.ts"] },
        noise: 0
      })
      yield* eventually(
        () => logged.some((line) => line.includes("stopped following its parent")),
        "the loop reported that it stopped"
      )

      // And it really stopped: a later, perfectly valid projection reaches the
      // child not at all. The host stays Running, because nothing it owns
      // failed — the trade the log line exists to make visible.
      yield* controller.commit({
        workspace: Option.some("w1"),
        docsByWorkspace: { w1: ["c.ts"] },
        noise: 0
      })
      yield* idle(controller)
      yield* quietFor()
      expect(opened).toEqual(["a.ts"])
      expect(yield* statusTag(controller, hostRef)).toBe("Running")
    }).pipe(
      // The loop dies on purpose here, so its own log line is the assertion
      // and the fiber failure behind it is not console noise.
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([Logger.make(({ message }) => {
          logged.push(Array.isArray(message) ? message.map(String).join(" ") : String(message))
        })])
      )
    )
  })

  it.live("§9.10 — the child dies with its host, by ownership and not by rule", () =>
    Effect.gen(function* () {
      const opened: Array<string> = []
      const { binding } = makeNested(opened)
      const controller = yield* Reconciler.make(binding)

      yield* controller.commit({
        workspace: Option.some("w1"),
        docsByWorkspace: { w1: ["a.ts"] },
        noise: 0
      })
      yield* idle(controller)
      yield* Effect.sleep(30)
      expect(opened).toEqual(["a.ts"])

      // The host lifetime's key changes, so the host is replaced — and the
      // child Controller lives in the host's Scope, so it and everything it
      // was running go with it. Nothing in the child had to be told.
      yield* controller.commit({
        workspace: Option.some("w2"),
        docsByWorkspace: { w2: ["z.ts"] },
        noise: 0
      })
      yield* idle(controller)
      yield* Effect.sleep(40)
      expect(opened).toEqual(["a.ts", "-a.ts", "z.ts"])

      // And shutdown reaches all the way down, for the same reason.
      yield* controller.shutdown
      expect(opened).toEqual(["a.ts", "-a.ts", "z.ts", "-z.ts"])
    }))

  it.live("§9.10 — an obsolete generation is not told about a world it has left", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<string>>([])
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          observes: Reconciler.observed<number>(),
          start: (key: string, observed) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sleep(40))
              yield* Effect.forkScoped(
                Stream.runForEach(SubscriptionRef.changes(observed), (n) =>
                  Ref.update(updates, (u) => [...u, `${key}=${n}`]))
              )
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string; readonly value: number }>((b) => ({
          res: b.one(Def.Res, (m) => Option.some(m.key), { observe: (m) => m.value })
        }))
      )

      yield* controller.commit({ key: "a", value: 1 })
      yield* idle(controller)
      yield* Effect.sleep(20)

      // The old generation is Stopping — its finalizer is slow — while a new
      // projection is published for the new key. It must not receive it.
      yield* controller.commit({ key: "b", value: 2 })
      yield* Effect.sleep(20)
      expect(yield* statusTag(controller, Reconciler.ref(Def.Res, "a", null))).toBe("Stopping")
      yield* Effect.sleep(60)

      expect(yield* Ref.get(updates)).toEqual(["a=1", "b=2"])
    }))
})
