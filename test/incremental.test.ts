/**
 * Incremental bindings (spec §9.9 / §15).
 *
 * The optimization is opt-in and its correctness rests on a promise the
 * runtime cannot check, so the tests are about the boundary: it must skip
 * exactly the work whose inputs are unchanged, produce byte-for-byte the same
 * desire as the full sweep when the promise is kept, and remember nothing
 * about owners that have gone away.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as Reconciler from "../src/Reconciler.js"
import { idle } from "./util.js"

interface Model {
  readonly workspaces: ReadonlyArray<string>
  readonly docsByWorkspace: Readonly<Record<string, ReadonlyArray<string>>>
  /** Deliberately not read by any selector: changing it must cost nothing. */
  readonly cursor: number
}

const makeApp = (incremental: boolean) => {
  const calls: Array<string> = []
  const Def = Reconciler.define((define) => {
    const Workspace = define.many("Workspace", { start: (_id: string) => Effect.void })
    const Doc = define.many("Doc", { owner: Workspace, start: (_uri: string) => Effect.void })
    return { Workspace, Doc }
  })
  const binding = Def.bind<Model>((b) => ({
    workspaces: b.many(Def.Workspace, (m) => {
      calls.push("workspaces")
      return m.workspaces
    }),
    docs: b.many(
      Def.Doc,
      (m, owner) => {
        calls.push(`docs:${owner.key}`)
        return m.docsByWorkspace[owner.key] ?? []
      },
      // The declared dependency: this selector reads exactly one workspace's
      // documents, and nothing else in the model.
      incremental ? { deps: (m, owner) => m.docsByWorkspace[owner.key] } : undefined
    )
  }))
  return { calls, Def, binding }
}

const model = (partial: Partial<Model> = {}): Model => ({
  workspaces: ["w1", "w2"],
  docsByWorkspace: { w1: ["a.ts"], w2: ["b.ts", "c.ts"] },
  cursor: 0,
  ...partial
})

describe("incremental bindings", () => {
  it.live("§9.9 — skips a selector whose declared dependencies are unchanged", () =>
    Effect.gen(function* () {
      const { calls, binding } = makeApp(true)
      const controller = yield* Reconciler.make(binding)

      yield* controller.commit(model())
      yield* idle(controller)
      expect(calls).toEqual(["workspaces", "docs:w1", "docs:w2"])

      // A commit that changes something no selector reads.
      calls.length = 0
      yield* controller.commit(model({ cursor: 1 }))
      yield* idle(controller)
      // The root selector has no `deps` and runs as it always did; the owned
      // one is the expensive one at scale, and it did not run at all.
      expect(calls).toEqual(["workspaces"])

      // One workspace's documents change: exactly that owner is re-evaluated.
      calls.length = 0
      yield* controller.commit(model({
        docsByWorkspace: { w1: ["a.ts"], w2: ["b.ts", "c.ts", "d.ts"] }
      }))
      yield* idle(controller)
      expect(calls).toEqual(["workspaces", "docs:w2"])

      const diagnostics = yield* controller.diagnostics
      expect(diagnostics.selectorEvaluationsSkipped).toBeGreaterThan(0)
    }))

  it.live("§9.9 — produces exactly the desire the full sweep produces", () =>
    Effect.gen(function* () {
      // The claim that matters: the optimization is invisible. Both runtimes
      // are driven through the same sequence and must end up with the same
      // world, lifetime for lifetime.
      const plain = makeApp(false)
      const memo = makeApp(true)
      const controllers = [
        yield* Reconciler.make(plain.binding),
        yield* Reconciler.make(memo.binding)
      ]
      const states: ReadonlyArray<Model> = [
        model(),
        model({ cursor: 1 }),
        model({ docsByWorkspace: { w1: ["a.ts", "e.ts"], w2: ["b.ts", "c.ts"] } }),
        model({ workspaces: ["w2"], docsByWorkspace: { w2: ["b.ts"] } }),
        model({ workspaces: ["w1", "w2"], docsByWorkspace: { w1: ["a.ts"], w2: ["b.ts"] } }),
        model({ workspaces: [] , docsByWorkspace: {} }),
        model()
      ]
      for (const state of states) {
        const worlds: Array<string> = []
        for (const controller of controllers) {
          yield* controller.commit(state)
          yield* idle(controller)
          const snapshot = yield* controller.snapshot
          worlds.push(
            JSON.stringify(
              snapshot.lifetimes
                .map((e) =>
                  `${e.lifetime.parent === null ? "" : String(e.lifetime.parent.key) + "/"}` +
                  `${e.lifetime.family.name}:${String(e.lifetime.key)}=${e.status._tag}`
                )
                .sort()
            )
          )
        }
        expect(worlds[1]).toBe(worlds[0])
      }

      // And it did less work getting there.
      const [plainDiag, memoDiag] = [
        yield* controllers[0]!.diagnostics,
        yield* controllers[1]!.diagnostics
      ]
      expect(memoDiag.selectorEvaluations).toBeLessThan(plainDiag.selectorEvaluations)
      expect(plainDiag.selectorEvaluationsSkipped).toBe(0)
    }))

  it.live("§9.9 — forgets what it remembered about an owner that went away", () =>
    Effect.gen(function* () {
      const { calls, binding } = makeApp(true)
      const controller = yield* Reconciler.make(binding)

      yield* controller.commit(model())
      yield* idle(controller)

      // The workspace leaves and comes back with different documents. A memo
      // that outlived it — or one that was pruned but keyed by anything
      // physical — would answer with the old keys here.
      yield* controller.commit(model({ workspaces: ["w1"], docsByWorkspace: { w1: ["a.ts"] } }))
      yield* idle(controller)
      calls.length = 0
      yield* controller.commit(model({
        workspaces: ["w1", "w2"],
        docsByWorkspace: { w1: ["a.ts"], w2: ["z.ts"] }
      }))
      yield* idle(controller)

      expect(calls).toContain("docs:w2")
      const snapshot = yield* controller.snapshot
      const docs = snapshot.lifetimes
        .filter((e) => e.lifetime.family.name === "Doc")
        .map((e) => String(e.lifetime.key))
        .sort()
      expect(docs).toEqual(["a.ts", "z.ts"])
    }))

  it.live("§9.9 — a `one` family may be incremental too", () =>
    Effect.gen(function* () {
      let evaluations = 0
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", { start: (_key: string) => Effect.void })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: string; readonly noise: number }>((b) => ({
          res: b.one(
            Def.Res,
            (m) => {
              evaluations++
              return Option.some(m.key)
            },
            { deps: (m) => m.key }
          )
        }))
      )

      yield* controller.commit({ key: "a", noise: 0 })
      yield* idle(controller)
      yield* controller.commit({ key: "a", noise: 1 })
      yield* controller.commit({ key: "a", noise: 2 })
      yield* idle(controller)
      expect(evaluations).toBe(1)

      yield* controller.commit({ key: "b", noise: 2 })
      yield* idle(controller)
      expect(evaluations).toBe(2)
      expect(
        Option.isSome((yield* controller.snapshot).get(Reconciler.ref(Def.Res, "b", null)))
      ).toBe(true)
    }))
})
