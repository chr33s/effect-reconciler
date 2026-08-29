import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Document, makeProbe, Session, Workspace, type Model } from "../editor.js"
import { make } from "./editor.js"
import * as Kernel from "./kernel.js"

const base = (overrides: Partial<Model> = {}): Model => ({
  settingsRevision: 1,
  session: "alice",
  workspace: "main",
  language: "typescript",
  documents: ["foo", "bar"],
  ...overrides
})

const eventually = (condition: () => boolean, label: string): Effect.Effect<void> => {
  const loop: Effect.Effect<void> = Effect.suspend(() =>
    condition() ? Effect.void : Effect.andThen(Effect.sleep(2), loop)
  )
  return Effect.timeoutOrElse(loop, {
    duration: 5_000,
    orElse: () => Effect.die(new Error(`rebased experiment timed out: ${label}`))
  })
}

describe("Atom → generation kernel → Layer rebase", () => {
  it("interns structurally equal keys relative to their owner", () => {
    const cache = Kernel.makeRefCache()
    const ownerFamily = Kernel.family({
      name: "Owner",
      cardinality: "many",
      layer: () => Layer.empty as unknown as Layer.Layer<any, any, any>
    })
    const childFamily = Kernel.family({
      name: "Child",
      cardinality: "many",
      layer: () => Layer.empty as unknown as Layer.Layer<any, any, any>
    })
    const ownerA = cache.get(ownerFamily, { id: 1 }, null)
    const ownerAEqual = cache.get(ownerFamily, { id: 1 }, null)
    const ownerB = cache.get(ownerFamily, { id: 2 }, null)
    expect(ownerAEqual).toBe(ownerA)
    expect(cache.get(childFamily, { id: "x" }, ownerAEqual)).toBe(
      cache.get(childFamily, { id: "x" }, ownerA)
    )
    expect(cache.get(childFamily, { id: "x" }, ownerB)).not.toBe(
      cache.get(childFamily, { id: "x" }, ownerA)
    )
  })

  it.live("retains equal desire and reconciles dynamic many selectively", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)
      yield* editor.commit(base())
      yield* editor.idle
      const starts = probe.events.filter((event) => event.type === "start").length
      const first = yield* editor.kernel.snapshot
      const bar = first.generations.find((entry) =>
        entry.ref.family === editor.families.Document && entry.ref.key === "bar")!.generation

      yield* editor.commit(base({ documents: ["foo", "bar"] }))
      yield* editor.idle
      expect(probe.events.filter((event) => event.type === "start")).toHaveLength(starts)

      yield* editor.commit(base({ documents: ["bar", "baz"] }))
      yield* editor.idle
      const next = yield* editor.kernel.snapshot
      expect(next.generations.find((entry) =>
        entry.ref.family === editor.families.Document && entry.ref.key === "bar")!.generation).toBe(bar)
      expect(probe.events.filter((event) =>
        event.type === "start" && event.family === "Document" && event.key === "baz")).toHaveLength(1)
      expect(probe.events.filter((event) =>
        event.type === "stop" && event.family === "Document" && event.key === "foo")).toHaveLength(1)
    }))

  it.live("keeps equal child keys owner-relative", () =>
    Effect.gen(function* () {
      const editor = yield* make()
      const alice = editor.refs(base({ session: "alice", documents: ["foo"] })).documents.get("foo")!
      const bob = editor.refs(base({ session: "bob", documents: ["foo"] })).documents.get("foo")!
      expect(alice).not.toBe(bob)
      expect(alice.key).toBe(bob.key)
      expect(alice.parent).not.toBe(bob.parent)
    }))

  it.live("publishes authoritative status as an Atom", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      probe.fail("Language", "typescript")
      const editor = yield* make(probe)
      const identity = editor.refs(base()).language!
      const seen: Array<string> = []
      const unsubscribe = editor.kernel.registry.subscribe(
        editor.kernel.status(identity),
        (status) => seen.push(status._tag),
        { immediate: true }
      )

      yield* editor.commit(base({ documents: ["foo"] }))
      yield* editor.idle
      expect(seen).toContain("Starting")
      expect(seen.at(-1)).toBe("Failed")
      expect(yield* editor.status("Language", "typescript")).toBe("Failed")
      unsubscribe()
    }))

  it.live("captures immutable provider generations and replaces only Diagnostics", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)
      yield* editor.commit(base({ documents: ["foo"] }))
      yield* editor.idle
      const before = yield* editor.kernel.snapshot
      const generationOf = (family: object, key: unknown) => before.generations.find((entry) =>
        entry.ref.family === family && entry.ref.key === key)!.generation
      const workspace = generationOf(editor.families.Workspace, "main")
      const language = generationOf(editor.families.Language, "typescript")
      const document = generationOf(editor.families.Document, "foo")
      const captures = probe.captures.length

      yield* editor.commit(base({ settingsRevision: 2, documents: ["foo"] }))
      yield* editor.idle
      const after = yield* editor.kernel.snapshot
      const afterGeneration = (family: object, key: unknown) => after.generations.find((entry) =>
        entry.ref.family === family && entry.ref.key === key)!.generation
      expect(afterGeneration(editor.families.Workspace, "main")).toBe(workspace)
      expect(afterGeneration(editor.families.Language, "typescript")).toBe(language)
      expect(afterGeneration(editor.families.Document, "foo")).toBe(document)
      const fresh = probe.captures.slice(captures)
      expect(fresh).toHaveLength(1)
      expect(fresh[0]!.settingsRevision).toBe(2)
      expect(fresh[0]!.languageGeneration).toBe(language)
      expect(fresh[0]!.workspaceGeneration).toBe(workspace)
    }))

  it.live("admits a dependent with one consistent provider-generation set", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)
      yield* editor.commit(base({ documents: ["foo"] }))
      yield* editor.idle
      const before = probe.captures.length

      yield* editor.commit(base({ settingsRevision: 2, language: "rust", documents: ["foo"] }))
      yield* editor.idle
      const capture = probe.captures.slice(before)
      expect(capture).toHaveLength(1)
      expect(capture[0]!.settingsRevision).toBe(2)
      expect(capture[0]!.language).toBe("rust")
      const snapshot = yield* editor.kernel.snapshot
      expect(capture[0]!.settingsGeneration).toBe(snapshot.generations.find((entry) =>
        entry.ref.family === editor.families.Settings)!.generation)
      expect(capture[0]!.languageGeneration).toBe(snapshot.generations.find((entry) =>
        entry.ref.family === editor.families.Language)!.generation)
    }))

  it.live("owner replacement suppresses late startup and closes descendants", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      yield* probe.pauseStart("Document", "slow")
      const editor = yield* make(probe)
      yield* editor.commit(base({ documents: ["slow"] }))
      yield* eventually(
        () => probe.events.some((event) =>
          event.type === "start" && event.family === "Document" && event.key === "slow"),
        "slow child admitted"
      )

      yield* editor.commit(base({ session: "bob", documents: [] }))
      yield* probe.resumeStart("Document", "slow")
      yield* editor.idle
      expect(probe.startupCompletions.filter((completion) =>
        completion.family === "Document" && completion.key === "slow")).toHaveLength(1)
      expect(probe.captures.some((capture) => capture.uri === "slow")).toBe(false)
      expect(probe.events.some((event) =>
        event.type === "stop" && event.family === "Workspace")).toBe(true)
    }))

  it.live("failed provider blocks dependents and same-key retry creates a generation", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      probe.fail("Language", "typescript")
      const editor = yield* make(probe)
      yield* editor.commit(base({ documents: ["foo"] }))
      yield* editor.idle
      const failed = (yield* editor.kernel.snapshot).generations.find((entry) =>
        entry.ref.family === editor.families.Language)!.generation
      expect(probe.captures).toEqual([])

      probe.fix("Language", "typescript")
      yield* editor.retryLanguage
      yield* editor.idle
      const running = (yield* editor.kernel.snapshot).generations.find((entry) =>
        entry.ref.family === editor.families.Language)!.generation
      expect(running).not.toBe(failed)
      expect(probe.captures).toHaveLength(1)
    }))

  it.live("sequential policy waits and coalesces A → B → C", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)
      yield* editor.commit(base({ session: "A", workspace: null, documents: [] }))
      yield* editor.idle
      yield* probe.pauseStop("Session", "A")

      yield* editor.commit(base({ session: "B", workspace: null, documents: [] }))
      yield* eventually(() => probe.events.some((event) =>
        event.type === "stopping" && event.family === "Session" && event.key === "A"), "A stopping")
      yield* editor.commit(base({ session: "C", workspace: null, documents: [] }))
      expect(probe.events.some((event) => event.type === "start" && event.key === "B")).toBe(false)
      expect(probe.events.some((event) => event.type === "start" && event.key === "C")).toBe(false)

      yield* probe.resumeStop("Session", "A")
      yield* editor.idle
      expect(probe.events.some((event) => event.type === "start" && event.key === "B")).toBe(false)
      expect(yield* editor.status("Session", "C")).toBe("Running")
    }))

  it.live("overlap policy starts the replacement before old finalization", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe, { sessionReplacement: "overlap" })
      yield* editor.commit(base({ session: "A", workspace: null, documents: [] }))
      yield* editor.idle
      yield* probe.pauseStop("Session", "A")

      yield* editor.commit(base({ session: "B", workspace: null, documents: [] }))
      yield* eventually(() => probe.events.some((event) =>
        event.type === "start" && event.family === "Session" && event.key === "B"), "B started")
      expect(probe.events.some((event) =>
        event.type === "stop" && event.family === "Session" && event.key === "A")).toBe(false)
      yield* probe.resumeStop("Session", "A")
      yield* editor.idle
    }))

  it.live("routes finite work into the exact generation Scope", () =>
    Effect.gen(function* () {
      const editor = yield* make()
      yield* editor.commit(base({ documents: ["foo"] }))
      yield* editor.idle
      const entered = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        editor.runDocument("foo", Effect.gen(function* () {
          expect((yield* Session).user).toBe("alice")
          expect((yield* Workspace).id).toBe("main")
          expect((yield* Document).uri).toBe("foo")
          yield* Deferred.succeed(entered, void 0)
          yield* Deferred.await(never)
        }))
      )
      yield* Deferred.await(entered)
      yield* editor.commit(base({ documents: [] }))
      yield* editor.idle
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
    }))
})
