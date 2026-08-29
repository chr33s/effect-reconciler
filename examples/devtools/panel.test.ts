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
import { Context, Effect, Latch, Option } from "effect"
import * as Reconciler from "../../src/Reconciler.js"
import * as Replacement from "../../src/Replacement.js"
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

  it.live("keeps two same-named lifetimes under different owners apart", () =>
    Effect.gen(function* () {
      // `Doc:shared.ts` exists under two sessions. A tree indexed by
      // `family:key` merges them into one node and draws both analyzers under
      // it — a panel that quietly reports a topology the runtime does not
      // have. Identity is the whole owner path, so the index has to be too.
      const Def = Reconciler.define((define) => {
        const Session = define.many("Session", { start: (_id: string) => Effect.void })
        const Doc = define.many("Doc", { owner: Session, start: (_uri: string) => Effect.void })
        return { Session, Doc }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly sessions: ReadonlyArray<string> }>((b) => ({
          sessions: b.many(Def.Session, (m) => m.sessions),
          docs: b.many(Def.Doc, () => ["shared.ts"])
        }))
      )
      const panel = yield* Panel.make(controller)

      yield* controller.commit({ sessions: ["s1", "s2"] })
      yield* idle(controller)
      yield* eventually(() => panel.render().includes("Doc:shared.ts"), "the first paint")
      yield* panel.refresh

      const tree = panel.render().split("\n\nrecent")[0]!
      // One document under each session, not two under one and none under the
      // other.
      expect(tree.match(/Session:s1/g)?.length).toBe(1)
      expect(tree.match(/Session:s2/g)?.length).toBe(1)
      expect(tree.match(/Doc:shared\.ts/g)?.length).toBe(2)
      const lines = tree.split("\n").filter((l) => l.includes("Session:") || l.includes("Doc:"))
      expect(lines.map((l) => l.trimStart().startsWith("└─"))).toEqual([false, true, false, true])
    }))

  it.live("keeps two generations of one lifetime apart", () =>
    Effect.gen(function* () {
      // Under `Replacement.overlap()` a retired generation drains beside the
      // one replacing it, so `Doc:a.ts` is two entries in one snapshot — same
      // family, same key, same owner path, different generations. Anything
      // that indexes children by the owner's *reference* cannot tell them
      // apart, so it files both analyzers under both documents and draws four
      // where there are two, each document showing the other's child.
      const gate = yield* Latch.make(false)
      const Def = Reconciler.define((define) => {
        const Settings = define.one("Settings", {
          start: (revision: number) => Effect.succeed(Context.make(Config, { revision }))
        })
        const Doc = define.many("Doc", {
          requires: { settings: Settings },
          replacement: Replacement.overlap(),
          start: (_uri: string) =>
            Effect.addFinalizer(() => gate.await)
        })
        const Analyzer = define.one("Analyzer", {
          owner: Doc,
          replacement: Replacement.overlap(),
          start: (_: null) => Effect.void
        })
        return { Settings, Doc, Analyzer }
      })
      const controller = yield* Reconciler.make(
        Def.bind<Model>((b) => ({
          settings: b.one(Def.Settings, (m) => Option.some(m.revision)),
          docs: b.many(Def.Doc, (m) => m.docs),
          analyzer: b.one(Def.Analyzer, () => Option.some(null))
        }))
      )
      const panel = yield* Panel.make(controller)

      yield* controller.commit({ revision: 1, docs: ["a.ts"] })
      yield* eventually(() => panel.render().includes("Analyzer:null"), "the first paint")

      // Replacing the provider retires the document, whose finalizer is wedged
      // on the gate — so the replacement starts while the original is still
      // draining, and both are in the snapshot at once.
      yield* controller.commit({ revision: 2, docs: ["a.ts"] })
      yield* eventually(
        () => panel.render().includes("Doc:a.ts  Stopping"),
        "the retired generation to appear beside its replacement"
      )
      yield* panel.refresh
      const tree = panel.render().split("\n\nrecent")[0]!

      yield* gate.open

      expect(tree.match(/Doc:a\.ts/g)?.length).toBe(2)
      // Two analyzers for two documents. Four is the bug: every child drawn
      // under every generation of its owner.
      expect(tree.match(/Analyzer:null/g)?.length).toBe(2)
      // And each analyzer sits under exactly one document, in the status its
      // own generation is in.
      const lines = tree.split("\n").filter((l) => /Doc:|Analyzer:/.test(l))
      expect(lines.length).toBe(4)
      expect(lines[0]).toContain("Doc:a.ts")
      expect(lines[1]?.trimStart().startsWith("└─")).toBe(true)
      expect(lines[2]).toContain("Doc:a.ts")
      expect(lines[3]?.trimStart().startsWith("└─")).toBe(true)
    }))

  it.live("two models of an unchanged runtime compare equal", () =>
    Effect.gen(function* () {
      const { binding } = app()
      const controller = yield* Reconciler.make(binding)
      const panel = yield* Panel.make(controller)

      yield* controller.commit({ revision: 1, docs: ["a.ts"] })
      yield* idle(controller)
      yield* eventually(() => panel.render().includes("Doc:a.ts"), "the first paint")

      // Every `snapshot` allocates a fresh value, so a host that refreshes on
      // a timer gets a different object each time with nothing different in
      // it. Comparing by reference makes `same` answer "no" forever and
      // repaint a terminal that has not changed — the exact work it exists to
      // avoid.
      const before = panel.model()
      yield* panel.refresh
      const after = panel.model()
      expect(after.snapshot).not.toBe(before.snapshot)
      expect(Panel.same(before, after)).toBe(true)

      // And it still says "no" when something actually moved.
      yield* controller.commit({ revision: 1, docs: ["a.ts", "b.ts"] })
      yield* idle(controller)
      yield* eventually(() => panel.render().includes("Doc:b.ts"), "the second paint")
      expect(Panel.same(before, panel.model())).toBe(false)
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
