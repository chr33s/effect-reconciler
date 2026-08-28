import { Context, Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as Key from "../src/Key.js"
import * as Reconciler from "../src/Reconciler.js"
import { LanguageService } from "./fixtures.js"
import { eventually, settle, StartupFailed } from "./util.js"

describe("startup failure", () => {
  it.live("9.9 — a failed provider prevents dependent admission until a valid replacement runs", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => {
        const Language = define.one("Language", {
          key: Key.string,
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
          key: Key.null,
          requires: { language: Language },
          start: () =>
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
      yield* settle
      // The dependent never starts against a missing/failed provider.
      expect(log.some((e) => e.startsWith("diagnostics:"))).toBe(false)

      // A valid replacement becomes Running; the dependent may then start.
      yield* controller.commit({ language: "good" })
      yield* eventually(() => log.includes("diagnostics:good"), "dependent admitted")
    }))

  it.live("§38 — startup failure finalizes partial resources and admits no children", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => {
        const Parent = define.one("Parent", {
          key: Key.string,
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
          key: Key.null,
          owner: Parent,
          start: () => Effect.sync(() => log.push("child:start"))
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
      yield* settle
      expect(log).not.toContain("child:start")

      // A future desire change creates another physical instance.
      yield* controller.commit({ key: "q" })
      yield* eventually(() => log.includes("acquire:q"), "new physical attempt")
    }))

  it.live("a start Effect that interrupts itself is treated as failure, not left wedged", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          key: Key.string,
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
