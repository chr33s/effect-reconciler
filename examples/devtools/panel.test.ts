/**
 * The DevTools panel, tested the way a panel should be: by looking at what it
 * would show.
 *
 * Rendering to a string is what makes that possible, and it is why the
 * example renders to one. The assertions below are the questions a person
 * actually asks a panel — what is running, what failed, why did that restart
 * — checked against the text they would read.
 */
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Option } from "effect"
import * as Reconciler from "../../src/Reconciler.js"
import { eventually, idle, StartupFailed } from "../../test/util.js"
import * as Panel from "./panel.js"

class Config extends Context.Service<Config, { readonly revision: number }>()(
  "devtools/Config"
) {}

interface Model {
  readonly revision: number
  readonly docs: ReadonlyArray<string>
}

const app = () => {
  const Def = Reconciler.define((define) => {
    const Settings = define.one("Settings", {
      start: (revision: number) => Effect.succeed(Context.make(Config, { revision }))
    })
    const Doc = define.many("Doc", {
      requires: { settings: Settings },
      start: (uri: string) =>
        uri === "bad.ts" ? new StartupFailed({ reason: "unreadable" }) : Effect.void
    })
    const Analyzer = define.one("Analyzer", {
      owner: Doc,
      start: (_: null) => Effect.void
    })
    return { Settings, Doc, Analyzer }
  })
  return {
    Def,
    binding: Def.bind<Model>((b) => ({
      settings: b.one(Def.Settings, (m) => Option.some(m.revision)),
      docs: b.many(Def.Doc, (m) => m.docs),
      analyzer: b.one(Def.Analyzer, () => Option.some(null))
    }))
  }
}

describe("devtools panel", () => {
  it.live("shows the tree, the counters and why things happened", () =>
    Effect.gen(function* () {
      const { binding } = app()
      const controller = yield* Reconciler.make(binding)
      const panel = yield* Panel.make(controller)

      expect(panel.render()).toContain("(nothing running)")

      yield* controller.commit({ revision: 1, docs: ["a.ts", "bad.ts"] })
      yield* idle(controller)
      yield* eventually(
        () => panel.render().includes("Doc:a.ts"),
        "the panel to catch up with the runtime"
      )
      yield* panel.refresh

      const running = panel.render()
      // The tree, drawn from the snapshot: owners with their children under
      // them, and the failure visible with its reason rather than as a count.
      expect(running).toContain("Settings:1  Running")
      expect(running).toContain("Doc:a.ts  Running")
      expect(running).toContain("Analyzer:null  Running")
      expect(running).toMatch(/Doc:bad\.ts\s+Failed — .*StartupFailed/)
      // The analyzer under the failed document was never admitted, so the
      // panel does not invent it. Counted in the tree only — the same name
      // legitimately appears again in the event lines below it.
      const treeLines = running.split("\n\nrecent")[0]!
      expect(treeLines.match(/Analyzer:null/g)?.length).toBe(1)
      expect(running).toContain("4 total · 3 running · 0 starting · 1 failed")
      expect(running).toContain("settled")

      // Replacing the provider is the case a panel earns its keep on: the
      // application changed one number, and three lifetimes moved for three
      // different reasons, none of them stated anywhere in the application.
      yield* controller.commit({ revision: 2, docs: ["a.ts", "bad.ts"] })
      yield* idle(controller)
      yield* eventually(
        () => panel.render().includes("Settings:2"),
        "the replacement to appear"
      )
      yield* panel.refresh

      const replaced = panel.render()
      expect(replaced).toContain("retire · Settings:1 (desire)")
      expect(replaced).toContain("retire · Doc:a.ts (provider)")
      expect(replaced).toContain("retire · Analyzer:null (owner)")
      expect(replaced).toContain("Settings:2  Running")
    }))

  it.live("re-reads only when the runtime says something moved", () =>
    Effect.gen(function* () {
      let reads = 0
      const { binding } = app()
      const base = yield* Reconciler.make(binding)
      const controller: typeof base = {
        ...base,
        snapshot: Effect.andThen(
          Effect.sync(() => {
            reads++
          }),
          base.snapshot
        )
      }
      const panel = yield* Panel.make(controller)

      yield* controller.commit({ revision: 1, docs: ["a.ts"] })
      yield* idle(controller)
      yield* eventually(() => panel.render().includes("Doc:a.ts"), "the first paint")

      // A panel is open on a screen for hours. The only reason this one costs
      // anything while nothing happens is if the runtime lies about that.
      const settledAt = reads
      yield* Effect.sleep(300)
      expect(reads).toBe(settledAt)
    }))
})
