/**
 * The snapshot API (spec §9.6).
 *
 * A snapshot is `status` for the whole tree at once, and the tests are about
 * the two words that carry: *whole* (a generation that exists appears, in an
 * order a renderer can build a tree from) and *at once* (nothing in it can
 * contradict anything else in it).
 */
import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Latch, Option } from "effect"
import * as Reconciler from "../src/Reconciler.js"
import * as Replacement from "../src/Replacement.js"
import type { Snapshot } from "../src/Snapshot.js"
import { SessionService } from "./fixtures.js"
import { eventually, idle, StartupFailed, statusTag } from "./util.js"

/** The snapshot as `family:key` → status tag, which is what an assertion
 * about the shape of the world actually wants to read. */
const tags = (snapshot: Snapshot): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const entry of snapshot.lifetimes) {
    out[`${entry.lifetime.family.name}:${String(entry.lifetime.key)}`] = entry.status._tag
  }
  return out
}

interface Model {
  readonly session: Option.Option<string>
  readonly docs: ReadonlyArray<string>
  readonly failing: boolean
}

const makeTree = (gate: Deferred.Deferred<void> | null) =>
  Reconciler.define((define) => {
    const Session = define.one("Session", { start: (_id: string) => Effect.void })
    const Doc = define.many("Doc", {
      owner: Session,
      start: (uri: string) =>
        uri === "bad.ts" ? new StartupFailed({ reason: uri }) : Effect.void
    })
    const Analyzer = define.one("Analyzer", {
      owner: Doc,
      start: (_: null) => (gate === null ? Effect.void : Deferred.await(gate))
    })
    return { Session, Doc, Analyzer }
  })

const bind = (Def: ReturnType<typeof makeTree>) =>
  Def.bind<Model>((b) => ({
    session: b.one(Def.Session, (m) => m.session),
    docs: b.many(Def.Doc, (m) => m.docs),
    analyzer: b.one(Def.Analyzer, () => Option.some(null))
  }))

describe("snapshot", () => {
  it.live("§9.6 — two generations of one lifetime are told apart, and `get` names the current one", () =>
    Effect.gen(function* () {
      // Under `Replacement.overlap()` a retired generation drains beside the
      // one replacing it. They share a family, a key and an owner path, so a
      // `LifetimeRef` cannot tell them apart — which is exactly what a
      // consumer building a tree has to do before it can place their children.
      const gate = yield* Latch.make(false)
      const opened: Array<string> = []
      const Def = Reconciler.define((define) => {
        const Session = define.one("Session", {
          start: (id: string) => Effect.succeed(Context.make(SessionService, { userId: id }))
        })
        const Doc = define.many("Doc", {
          requires: { session: Session },
          replacement: Replacement.overlap(),
          start: (uri: string) =>
            Effect.andThen(
              Effect.sync(() => opened.push(uri)),
              Effect.addFinalizer(() => gate.await)
            )
        })
        const Analyzer = define.one("Analyzer", {
          owner: Doc,
          replacement: Replacement.overlap(),
          start: (_: null) => Effect.void
        })
        return { Session, Doc, Analyzer }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly session: string }>((b) => ({
          session: b.one(Def.Session, (m) => Option.some(m.session)),
          docs: b.many(Def.Doc, () => ["a.ts"]),
          analyzer: b.one(Def.Analyzer, () => Option.some(null))
        }))
      )
      const docRef = Reconciler.ref(Def.Doc, "a.ts", null)

      yield* controller.commit({ session: "s1" })
      yield* idle(controller)

      // Replacing the provider retires the document, whose finalizer is wedged
      // — so both generations are live at once.
      yield* controller.commit({ session: "s2" })
      // The original is wedged in its finalizer, so once the replacement has
      // started both generations are live at once.
      yield* eventually(() => opened.length === 2, "the replacement started")
      const snapshot = yield* controller.snapshot
      const docs = snapshot.lifetimes.filter((e) => e.lifetime.family.name === "Doc")

      yield* gate.open

      expect(docs.length).toBe(2)
      // One reference, two generations, distinct tokens.
      expect(docs[0]!.lifetime).toEqual(docs[1]!.lifetime)
      expect(docs[0]!.generation).not.toBe(docs[1]!.generation)
      expect(docs.map((e) => e.status._tag).sort()).toEqual(["Running", "Stopping"])
      // `Doc` is a root family, so both generations are roots.
      expect(docs.map((e) => e.owner)).toEqual([null, null])
      // And each analyzer names the exact document generation that owns it —
      // not merely its owner's identity, which both documents share.
      const analyzers = snapshot.lifetimes.filter((e) => e.lifetime.family.name === "Analyzer")
      expect(analyzers.length).toBe(2)
      expect(new Set(analyzers.map((e) => e.owner)).size).toBe(2)
      for (const analyzer of analyzers) {
        expect(docs.some((doc) => doc.generation === analyzer.owner)).toBe(true)
      }
      // `get` answers as `status` does: the generation currently holding the
      // identity, never the one draining out of it.
      expect(Option.getOrNull(snapshot.get(docRef))?._tag).toBe("Running")
    }))

  it.live("§9.6 — reports every generation, owners before children", () =>
    Effect.gen(function* () {
      const Def = makeTree(null)
      const controller = yield* Reconciler.make(bind(Def))

      // Nothing desired: a snapshot of an empty world is empty, not absent.
      expect((yield* controller.snapshot).lifetimes).toEqual([])

      yield* controller.commit({
        session: Option.some("u1"),
        docs: ["a.ts", "b.ts", "bad.ts"],
        failing: false
      })
      yield* idle(controller)

      const snapshot = yield* controller.snapshot
      expect(tags(snapshot)).toEqual({
        "Session:u1": "Running",
        "Doc:a.ts": "Running",
        "Doc:b.ts": "Running",
        "Doc:bad.ts": "Failed",
        "Analyzer:null": "Running"
      })

      // Owners before children, so a renderer can build the tree in one pass
      // without sorting: every entry's owner has already been seen.
      const seen = new Set<string>()
      for (const entry of snapshot.lifetimes) {
        const parent = entry.lifetime.parent
        if (parent !== null) {
          expect(seen.has(`${parent.family.name}:${String(parent.key)}`)).toBe(true)
        }
        seen.add(`${entry.lifetime.family.name}:${String(entry.lifetime.key)}`)
      }
      // The Analyzer under the failed Doc was never admitted, so it is not
      // there to be reported: three Docs, two Analyzers.
      expect(snapshot.lifetimes.filter((e) => e.lifetime.family.name === "Analyzer").length)
        .toBe(2)
    }))

  it.live("§9.6 — `get` answers exactly as `status` does", () =>
    Effect.gen(function* () {
      const Def = makeTree(null)
      const controller = yield* Reconciler.make(bind(Def))
      yield* controller.commit({
        session: Option.some("u1"),
        docs: ["a.ts", "bad.ts"],
        failing: false
      })
      yield* idle(controller)

      const snapshot = yield* controller.snapshot
      const session = Reconciler.ref(Def.Session, "u1", null)
      for (const ref of [
        session,
        Reconciler.ref(Def.Doc, "a.ts", session),
        Reconciler.ref(Def.Doc, "bad.ts", session),
        Reconciler.ref(Def.Doc, "absent.ts", session)
      ]) {
        const fromSnapshot = Option.map(snapshot.get(ref), (s) => s._tag)
        expect(Option.getOrElse(fromSnapshot, () => "None")).toBe(
          yield* statusTag(controller, ref)
        )
      }
    }))

  it.live("§9.6 — is coherent: no child outlives its owner inside one reading", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const Def = makeTree(gate)
      const controller = yield* Reconciler.make(bind(Def))

      // The Analyzer is wedged in startup beneath its Doc, so the tree is
      // genuinely mid-transition when the snapshot is taken — the state where
      // separate `status` calls could disagree with each other.
      yield* controller.commit({
        session: Option.some("u1"),
        docs: ["a.ts"],
        failing: false
      })
      yield* Effect.sleep(30)

      const snapshot = yield* controller.snapshot
      const byName = tags(snapshot)
      expect(byName["Analyzer:null"]).toBe("Starting")

      // The invariant a coherent reading must never break: an entry whose
      // owner is absent, or whose owner has stopped while it claims to run.
      const owners = new Map(
        snapshot.lifetimes.map((e) => [
          `${e.lifetime.family.name}:${String(e.lifetime.key)}`,
          e.status._tag
        ])
      )
      for (const entry of snapshot.lifetimes) {
        const parent = entry.lifetime.parent
        if (parent === null) continue
        const ownerStatus = owners.get(`${parent.family.name}:${String(parent.key)}`)
        expect(ownerStatus).toBeDefined()
        if (entry.status._tag === "Starting" || entry.status._tag === "Running") {
          expect(ownerStatus).toBe("Running")
        }
      }
      yield* Deferred.succeed(gate, void 0)
    }))

  it.live("§9.6 — after shutdown the world is empty, not stale", () =>
    Effect.gen(function* () {
      const Def = makeTree(null)
      const controller = yield* Reconciler.make(bind(Def))
      yield* controller.commit({
        session: Option.some("u1"),
        docs: ["a.ts"],
        failing: false
      })
      yield* idle(controller)
      expect((yield* controller.snapshot).lifetimes.length).toBeGreaterThan(0)

      // §8.6: shutdown closes every Scope. A snapshot that still reported
      // those lifetimes as Running would be describing resources that no
      // longer exist.
      yield* controller.shutdown
      expect((yield* controller.snapshot).lifetimes).toEqual([])
      expect(yield* statusTag(controller, Reconciler.ref(Def.Session, "u1", null))).toBe("None")
    }))
})
