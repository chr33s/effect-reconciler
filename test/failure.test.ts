import { Cause, Context, Effect, Latch, Option, Queue, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type { ReconcileEvent } from "../src/Diagnostics.js"
import * as Reconciler from "../src/Reconciler.js"
import { LanguageService, SessionService } from "./fixtures.js"
import { drainFailures, eventually, failureQueue, idle, quietFor, StartupFailed } from "./util.js"

describe("startup failure", () => {
  it.live("9.9 — a failed provider prevents dependent admission until a valid replacement runs", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => {
        const Language = define.one("Language", {
          start: (language: string) =>
            Effect.gen(function* () {
              log.push(`language:begin:${language}`)
              if (language === "bad") {
                return yield* new StartupFailed({ reason: "boom" })
              }
              return Context.make(LanguageService, { language })
            })
        })
        const Diagnostics = define.one("Diagnostics", {
          requires: { language: Language },
          start: (_: null) =>
            Effect.gen(function* () {
              const language = yield* LanguageService
              log.push(`diagnostics:${language.language}`)
            })
        })
        return { Language, Diagnostics }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly language: string }>((bind) => ({
          language: bind.one(Def.Language, (s) => Option.some(s.language)),
          diagnostics: bind.one(Def.Diagnostics, () => Option.some(null))
        }))
      )

      yield* controller.commit({ language: "bad" })
      yield* eventually(() => log.includes("language:begin:bad"), "provider attempted")
      yield* idle(controller)
      // The dependent never starts against a missing/failed provider.
      expect(log.some((e) => e.startsWith("diagnostics:"))).toBe(false)

      // A valid replacement becomes Running; the dependent may then start.
      yield* controller.commit({ language: "good" })
      yield* eventually(() => log.includes("diagnostics:good"), "dependent admitted")
    }))

  it.live("§9.1 — a failed lifetime is observable semantically, with no internals", () =>
    Effect.gen(function* () {
      const Def = Reconciler.define((define) => {
        const Session = define.one("Session", {
          start: (userId: string) => Effect.succeed(Context.make(SessionService, { userId }))
        })
        const Language = define.one("Language", {
          owner: Session,
          start: (language: string) =>
            language === "bad"
              ? new StartupFailed({ reason: "language server did not start" })
              : Effect.succeed(Context.make(LanguageService, { language }))
        })
        return { Session, Language }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly language: string }>((bind) => ({
          session: bind.one(Def.Session, () => Option.some("alice")),
          language: bind.one(Def.Language, (s) => Option.some(s.language))
        }))
      )

      const failures = yield* failureQueue(controller)
      yield* controller.commit({ language: "bad" })

      const failure = yield* Queue.take(failures)
      // Enough for a control plane to say "language server failed" for this
      // session, and nothing more.
      expect(failure.lifetime.family).toBe(Def.Language)
      expect(failure.lifetime.family.name).toBe("Language")
      expect(failure.lifetime.key).toBe("bad")
      expect(failure.lifetime.parent?.family).toBe(Def.Session)
      expect(failure.lifetime.parent?.key).toBe("alice")
      expect(failure.lifetime.parent?.parent).toBe(null)
      const error = Cause.squash(failure.cause)
      expect((error as StartupFailed)._tag).toBe("StartupFailed")

      // A healthy replacement produces no further failure event.
      yield* controller.commit({ language: "good" })
      yield* idle(controller)
      expect(yield* drainFailures(failures)).toEqual([])
    }))

  it.live("§6.6 — startup failure finalizes partial resources and admits no children", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => {
        const Parent = define.one("Parent", {
          start: (k: string) =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => log.push(`acquire:${k}`)),
                () => Effect.sync(() => log.push(`release:${k}`))
              )
              return yield* new StartupFailed({ reason: "startup failed" })
            })
        })
        const Child = define.one("Child", {
          owner: Parent,
          start: (_: null) => Effect.sync(() => log.push("child:start"))
        })
        return { Parent, Child }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          parent: bind.one(Def.Parent, (s) => Option.some(s.key)),
          child: bind.one(Def.Child, () => Option.some(null))
        }))
      )

      yield* controller.commit({ key: "p" })
      yield* eventually(() => log.includes("release:p"), "partial resources finalized")
      yield* idle(controller)
      expect(log).not.toContain("child:start")

      // A future desire change creates another physical instance.
      yield* controller.commit({ key: "q" })
      yield* eventually(() => log.includes("acquire:q"), "new physical attempt")
    }))

  it.live("§6.6 — no pass reports convergence while a failed startup is still finalizing", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const gate = yield* Latch.make(false)
      const Def = Reconciler.define((define) => ({
        Parent: define.one("Parent", {
          start: (k: string) =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => log.push(`acquire:${k}`)),
                () => Effect.andThen(gate.await, Effect.sync(() => log.push(`release:${k}`)))
              )
              return yield* new StartupFailed({ reason: "startup failed" })
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          parent: bind.one(Def.Parent, (s) => Option.some(s.key))
        }))
      )
      const events = yield* Stream.toQueue(controller.events, { capacity: 256 })
      yield* Effect.sleep(30)

      // The startup acquires a resource whose finalizer is wedged on the gate
      // below, then fails. The generation is Failed at once; what it acquired
      // is not released until the gate opens. Everything up to that point is
      // gathered before asserting, so a failed expectation can never leave the
      // gate shut and wedge this test's own teardown.
      yield* controller.commit({ key: "p" })
      yield* eventually(() => log.includes("acquire:p"), "partial resource acquired")
      yield* quietFor()
      const releasedEarly = log.includes("release:p")

      const seen: Array<ReconcileEvent> = []
      while (true) {
        const next = yield* Effect.timeoutOption(Effect.result(Queue.take(events)), 20)
        if (Option.isNone(next) || next.value._tag === "Failure") break
        if (next.value.success !== undefined) seen.push(next.value.success)
      }
      const failedAt = seen.findIndex((e) => e._tag === "StartupFailed")
      const passesAfter = seen
        .slice(failedAt)
        .filter((e) => e._tag === "PassCompleted") as ReadonlyArray<
          Extract<ReconcileEvent, { readonly _tag: "PassCompleted" }>
        >

      yield* gate.open
      yield* idle(controller)

      expect(releasedEarly).toBe(false)
      // A reconcile pass runs immediately behind the failure, and what it
      // decides is what every convergence observer is told. A pass that can run
      // before the failed generation's close has even been claimed reports a
      // settled controller while a finalizer has not begun — which is the one
      // thing `settled` exists to deny.
      expect(failedAt).toBeGreaterThanOrEqual(0)
      expect(passesAfter.length).toBeGreaterThan(0)
      expect(passesAfter.map((e) => e.settled)).not.toContain(true)

      // Released, the close reaches its boundary and convergence means it.
      expect(log).toContain("release:p")
      expect((yield* controller.diagnostics).settled).toBe(true)
    }))

  it.live("a start Effect that interrupts itself is treated as failure, not left wedged", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: string) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`cleanup:${k}`)))
              if (k === "self") return yield* Effect.interrupt
              log.push(`running:${k}`)
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )

      yield* controller.commit({ key: "self" })
      // The self-interrupted startup finalizes its partial resources...
      yield* eventually(() => log.includes("cleanup:self"), "partial resources finalized")

      // ...and the slot is not wedged: a desire change still replaces it.
      yield* controller.commit({ key: "ok" })
      yield* eventually(() => log.includes("running:ok"), "replacement admitted")
    }))
})
