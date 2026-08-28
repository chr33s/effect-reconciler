/**
 * Same-key retry (spec.2 §1).
 *
 * A failed lifetime keeps its slot until desire changes, which makes
 * recommitting the same state lifecycle-idempotent — recommitting cannot be
 * used as an implicit retry. `retry` is the explicit way to retire the failed
 * physical generation and let a fresh one be admitted under the *same*
 * semantic key, so an application never has to pollute domain identity with a
 * retry nonce or withdraw and restore desire.
 */
import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Option } from "effect"
import type { ControllerClosed } from "../src/Errors.js"
import * as Reconciler from "../src/Reconciler.js"
import * as Replacement from "../src/Replacement.js"
import { eventually, holding, idle, StartupFailed, statusTag } from "./util.js"

class ProviderService extends Context.Service<ProviderService, {
  readonly revision: number
}>()("test/RetryProvider") {}

describe("retry", () => {
  it.live("§1.1 — a failed root lifetime retries under the same key", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      let healthy = false
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`attempt:${k}`)
              if (!healthy) return yield* new StartupFailed({ reason: "boom" })
              log.push(`running:${k}`)
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )
      const ref = Reconciler.ref(Def.Res, "a", null)

      yield* controller.commit({ key: "a" })
      yield* eventually(() => log.includes("attempt:a"), "first attempt")
      yield* idle(controller)
      expect(yield* statusTag(controller, ref)).toBe("Failed")

      // Recommitting the same state is not a retry: nothing happens.
      yield* controller.commit({ key: "a" })
      yield* idle(controller)
      expect(log).toEqual(["attempt:a"])

      healthy = true
      yield* controller.retry(ref)
      yield* eventually(() => log.includes("running:a"), "retried and running")
      yield* idle(controller)

      expect(log).toEqual(["attempt:a", "attempt:a", "running:a"])
      expect(yield* statusTag(controller, ref)).toBe("Running")
    }))

  it.live("§1.2 — a failed owned lifetime retries under the same key", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      let healthy = false
      const Def = Reconciler.define((define) => {
        const Session = define.one("Session", {
          start: (_user: string) => Effect.void
        })
        const Child = define.one("Child", {
          owner: Session,
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`attempt:${k}`)
              if (!healthy) return yield* new StartupFailed({ reason: "boom" })
              log.push(`running:${k}`)
            })
        })
        return { Session, Child }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({
          session: bind.one(Def.Session, () => Option.some("alice")),
          child: bind.one(Def.Child, () => Option.some("c"))
        }))
      )
      const ref = Reconciler.ref(
        Def.Child,
        "c",
        Reconciler.ref(Def.Session, "alice", null)
      )

      yield* controller.commit({})
      yield* eventually(() => log.includes("attempt:c"), "first attempt")
      yield* idle(controller)
      expect(yield* statusTag(controller, ref)).toBe("Failed")

      healthy = true
      yield* controller.retry(ref)
      yield* eventually(() => log.includes("running:c"), "retried under the same owner")
      expect(yield* statusTag(controller, ref)).toBe("Running")
    }))

  it.live("§1.3 — retry is a no-op once the owner is no longer current", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => {
        const Session = define.one("Session", { start: (_user: string) => Effect.void })
        const Child = define.one("Child", {
          owner: Session,
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`attempt:${k}`)
              return yield* new StartupFailed({ reason: "boom" })
            })
        })
        return { Session, Child }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly user: string }>((bind) => ({
          session: bind.one(Def.Session, (s) => Option.some(s.user)),
          child: bind.one(Def.Child, () => Option.some("c"))
        }))
      )
      const underAlice = Reconciler.ref(
        Def.Child,
        "c",
        Reconciler.ref(Def.Session, "alice", null)
      )

      yield* controller.commit({ user: "alice" })
      yield* eventually(() => log.includes("attempt:c"), "failed under alice")
      yield* idle(controller)

      // The owner is replaced, so the failed generation is gone with it.
      yield* controller.commit({ user: "bob" })
      yield* idle(controller)
      const attemptsUnderBob = log.length

      expect(yield* statusTag(controller, underAlice)).toBe("None")
      yield* controller.retry(underAlice)
      yield* idle(controller)
      expect(log).toHaveLength(attemptsUnderBob)
    }))

  it.live("§1.4/§1.5 — a retried lifetime waits for its provider, then starts", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      let healthy = false
      const Def = Reconciler.define((define) => {
        const Provider = define.one("Provider", {
          start: (revision: number) =>
            Effect.succeed(Context.make(ProviderService, { revision }))
        })
        const Dependent = define.one("Dependent", {
          requires: { provider: Provider },
          start: (k: string) =>
            Effect.gen(function* () {
              const provider = yield* ProviderService
              log.push(`attempt:${k}:r${provider.revision}`)
              if (!healthy) return yield* new StartupFailed({ reason: "boom" })
              log.push(`running:${k}:r${provider.revision}`)
            })
        })
        return { Provider, Dependent }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly provider: Option.Option<number> }>((bind) => ({
          provider: bind.one(Def.Provider, (s) => s.provider),
          dependent: bind.one(Def.Dependent, () => Option.some("d"))
        }))
      )
      const ref = Reconciler.ref(Def.Dependent, "d", null)

      yield* controller.commit({ provider: Option.some(1) })
      yield* eventually(() => log.includes("attempt:d:r1"), "failed against provider 1")
      yield* idle(controller)

      // With the provider withdrawn the dependent cannot be admitted at all.
      yield* controller.commit({ provider: Option.none() })
      yield* idle(controller)
      expect(yield* statusTag(controller, ref)).toBe("None")

      healthy = true
      yield* controller.retry(ref)
      yield* idle(controller)
      expect(log).toEqual(["attempt:d:r1"])
      expect(yield* statusTag(controller, ref)).toBe("None")

      // Once a provider is Running again, the fresh generation is admitted.
      yield* controller.commit({ provider: Option.some(2) })
      yield* eventually(() => log.includes("running:d:r2"), "admitted against provider 2")
      expect(yield* statusTag(controller, ref)).toBe("Running")
    }))

  it.live("§1.6 — repeated retry is idempotent", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`attempt:${k}`)
              return yield* new StartupFailed({ reason: "boom" })
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({ res: bind.one(Def.Res, () => Option.some("a")) }))
      )
      const ref = Reconciler.ref(Def.Res, "a", null)

      yield* controller.commit({})
      yield* eventually(() => log.length === 1, "failed once")
      yield* idle(controller)

      // Hold the controller so all five calls observe the same failed
      // generation: exactly one of them retires it, the rest find nothing to
      // retire.
      const calls: Array<Fiber.Fiber<void, ControllerClosed>> = []
      yield* holding(controller)(
        Effect.gen(function* () {
          // Forked into the test Scope, not as children of this block: the
          // calls must outlive the hold in order to run against it.
          for (let call = 0; call < 5; call++) {
            calls.push(yield* Effect.forkScoped(controller.retry(ref), { startImmediately: true }))
          }
          // Every call is now queued on the controller's mutex.
          yield* Effect.sleep(5)
        })
      )
      yield* Effect.forEach(calls, Fiber.await)
      yield* idle(controller)

      expect(log).toEqual(["attempt:a", "attempt:a"])
      expect(yield* statusTag(controller, ref)).toBe("Failed")
    }))

  it.live("§1.7 — retry after shutdown fails with ControllerClosed", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", { start: (_key: string) => Effect.void })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({ res: bind.one(Def.Res, () => Option.none()) }))
      )
      yield* controller.shutdown

      const result = yield* Effect.result(
        controller.retry(Reconciler.ref(Def.Res, "a", null))
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ControllerClosed")
      }
    }))

  it.live("§1.8 — sequential retry waits for the failed generation's cleanup", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const releaseGate = yield* Deferred.make<void>()
      let healthy = false
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          replacement: Replacement.sequential(),
          start: (k: string) =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => log.push(`acquire:${k}`)),
                () =>
                  Effect.gen(function* () {
                    if (!healthy) yield* Deferred.await(releaseGate)
                    log.push(`release:${k}`)
                  })
              )
              if (!healthy) return yield* new StartupFailed({ reason: "boom" })
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({ res: bind.one(Def.Res, () => Option.some("a")) }))
      )
      const ref = Reconciler.ref(Def.Res, "a", null)

      yield* controller.commit({})
      yield* eventually(() => log.includes("acquire:a"), "first attempt acquired")

      // The failed generation still holds the exclusive resource.
      healthy = true
      yield* controller.retry(ref)
      yield* Effect.sleep(30)
      expect(log).toEqual(["acquire:a"])

      yield* Deferred.succeed(releaseGate, void 0)
      yield* eventually(() => log.filter((e) => e === "acquire:a").length === 2, "retried")
      expect(log).toEqual(["acquire:a", "release:a", "acquire:a"])
    }))

  it.live("§1.9 — retry never restarts a healthy Running lifetime", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`start:${k}`)
              yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`stop:${k}`)))
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({ res: bind.one(Def.Res, () => Option.some("a")) }))
      )
      const ref = Reconciler.ref(Def.Res, "a", null)

      yield* controller.commit({})
      yield* eventually(() => log.includes("start:a"), "running")
      expect(yield* statusTag(controller, ref)).toBe("Running")

      yield* controller.retry(ref)
      yield* idle(controller)

      expect(log).toEqual(["start:a"])
      expect(yield* statusTag(controller, ref)).toBe("Running")
    }))

  it.live("§1.10 — retry preserves semantic identity, so children keep their path", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      let healthy = false
      const Def = Reconciler.define((define) => {
        const Parent = define.one("Parent", {
          start: (k: string) =>
            Effect.gen(function* () {
              log.push(`parent:${k}`)
              if (!healthy) return yield* new StartupFailed({ reason: "boom" })
            })
        })
        const Child = define.many("Child", {
          owner: Parent,
          start: (k: string) => Effect.sync(() => log.push(`child:${k}`))
        })
        return { Parent, Child }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({
          parent: bind.one(Def.Parent, () => Option.some("p")),
          children: bind.many(Def.Child, (_s, owner) => [`${owner.key}-1`])
        }))
      )
      const parentRef = Reconciler.ref(Def.Parent, "p", null)
      const childRef = Reconciler.ref(Def.Child, "p-1", parentRef)

      yield* controller.commit({})
      yield* eventually(() => log.includes("parent:p"), "parent failed")
      yield* idle(controller)
      expect(yield* statusTag(controller, childRef)).toBe("None")

      healthy = true
      yield* controller.retry(parentRef)
      yield* eventually(() => log.includes("child:p-1"), "child admitted after retry")

      // The key never changed, so the child's owner-relative identity is the
      // one the binding always described.
      expect(log).toEqual(["parent:p", "parent:p", "child:p-1"])
      expect(yield* statusTag(controller, parentRef)).toBe("Running")
      expect(yield* statusTag(controller, childRef)).toBe("Running")
    }))
})
