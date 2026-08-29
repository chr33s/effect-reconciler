import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { Atom } from "effect/unstable/reactivity"
import {
  Document,
  emptyModel,
  make,
  makeProbe,
  Session,
  Workspace,
  type Family,
  type LifecycleEvent,
  type Model,
  type Probe
} from "./editor.js"

const base = (overrides: Partial<Model> = {}): Model => ({
  settingsRevision: 1,
  session: "alice",
  workspace: "main",
  language: "typescript",
  documents: ["foo", "bar"],
  ...overrides
})

const matching = (
  probe: Probe,
  type: LifecycleEvent["type"],
  family: Family,
  key?: unknown
): ReadonlyArray<LifecycleEvent> =>
  probe.events.filter((event) =>
    event.type === type && event.family === family &&
    (key === undefined || event.key === key))

const eventually = (condition: () => boolean, label: string): Effect.Effect<void> => {
  const loop: Effect.Effect<void> = Effect.suspend(() =>
    condition() ? Effect.void : Effect.andThen(Effect.sleep(2), loop)
  )
  return Effect.timeoutOrElse(loop, {
    duration: 5_000,
    orElse: () => Effect.die(new Error(`layer-atom experiment timed out: ${label}`))
  })
}

describe("Layer + Atom editor experiment", () => {
  it.live("retains equal keys and replaces changed keys", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)

      yield* editor.commit(base())
      yield* editor.idle
      const before = probe.events.filter((event) => event.type === "start").length
      const firstSession = matching(probe, "running", "Session", "alice")[0]!.generation

      // Fresh state and document array, structurally the same.
      yield* editor.commit(base({ documents: ["foo", "bar"] }))
      yield* editor.idle
      expect(probe.events.filter((event) => event.type === "start")).toHaveLength(before)
      expect(matching(probe, "running", "Session", "alice")[0]!.generation).toBe(firstSession)

      yield* editor.commit(base({ session: "bob" }))
      yield* editor.idle
      const bob = matching(probe, "running", "Session", "bob")
      expect(bob).toHaveLength(1)
      expect(bob[0]!.generation).not.toBe(firstSession)
      // The equal Workspace key is owner-relative and therefore replaced.
      expect(matching(probe, "running", "Workspace", "main")).toHaveLength(2)
    }))

  it("Atom.family keys are structural and owner-relative", () => {
    const family = Atom.family((key: {
      readonly owner: string
      readonly workspace: string
    }) => Atom.make(key))
    const a = family({ owner: "A", workspace: "main" })
    const aAgain = family({ owner: "A", workspace: "main" })
    const b = family({ owner: "B", workspace: "main" })
    expect(aAgain).toBe(a)
    expect(b).not.toBe(a)
  })

  it.live("reconciles dynamic many independently", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)
      yield* editor.commit(base())
      yield* editor.idle
      const barGeneration = matching(probe, "running", "Document", "bar")[0]!.generation

      yield* editor.commit(base({ documents: ["bar", "baz"] }))
      yield* editor.idle

      expect(matching(probe, "stop", "Document", "foo")).toHaveLength(1)
      expect(matching(probe, "running", "Document", "baz")).toHaveLength(1)
      expect(matching(probe, "running", "Document", "bar")).toHaveLength(1)
      expect(matching(probe, "running", "Document", "bar")[0]!.generation).toBe(barGeneration)
    }))

  it.live("owner closure suppresses a late child startup", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      yield* probe.pauseStart("Document", "slow")
      const editor = yield* make(probe)
      yield* editor.commit(base({ documents: ["slow"] }))
      yield* eventually(
        () => matching(probe, "start", "Document", "slow").length === 1,
        "slow document admitted"
      )

      // Atom desire is published synchronously by commit. Release startup
      // immediately, before waiting for a retirement pass: completion must
      // validate against that publication rather than stale live indexes.
      yield* editor.commit(base({ session: "bob", documents: [] }))
      yield* probe.resumeStart("Document", "slow")
      yield* editor.idle

      expect(probe.startupCompletions.filter((completion) =>
        completion.family === "Document" && completion.key === "slow")).toHaveLength(1)
      expect(matching(probe, "running", "Document", "slow")).toEqual([])
      expect(matching(probe, "stop", "Workspace", "main").length).toBeGreaterThan(0)
      expect(yield* editor.status("Document", "slow")).toBe("None")
    }))

  it.live("replaces only dependents when a collateral provider changes", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)
      yield* editor.commit(base())
      yield* editor.idle
      const workspace = matching(probe, "running", "Workspace", "main")[0]!.generation
      const language = matching(probe, "running", "Language", "typescript")[0]!.generation
      const fooDocument = matching(probe, "running", "Document", "foo")[0]!.generation
      const capturesBefore = probe.captures.length

      yield* editor.commit(base({ settingsRevision: 2 }))
      yield* editor.idle

      expect(matching(probe, "running", "Workspace", "main")).toHaveLength(1)
      expect(matching(probe, "running", "Workspace", "main")[0]!.generation).toBe(workspace)
      expect(matching(probe, "running", "Language", "typescript")[0]!.generation).toBe(language)
      expect(matching(probe, "running", "Document", "foo")[0]!.generation).toBe(fooDocument)
      const fresh = probe.captures.slice(capturesBefore)
      expect(fresh).toHaveLength(2)
      expect(fresh.every((capture) => capture.settingsRevision === 2)).toBe(true)
      expect(fresh.every((capture) => capture.languageGeneration === language)).toBe(true)
      expect(fresh.every((capture) => capture.workspaceGeneration === workspace)).toBe(true)
    }))

  it.live("captures one internally consistent provider-generation set", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)
      yield* editor.commit(base({ documents: ["foo"] }))
      yield* editor.idle
      const before = probe.captures.length

      yield* editor.commit(base({
        settingsRevision: 2,
        language: "rust",
        documents: ["foo"]
      }))
      yield* editor.idle

      const captures = probe.captures.slice(before)
      expect(captures).toHaveLength(1)
      expect(captures[0]!.settingsRevision).toBe(2)
      expect(captures[0]!.language).toBe("rust")
      const settingsGeneration = matching(probe, "running", "Settings", 2)[0]!.generation
      const languageGeneration = matching(probe, "running", "Language", "rust")[0]!.generation
      expect(captures[0]!.settingsGeneration).toBe(settingsGeneration)
      expect(captures[0]!.languageGeneration).toBe(languageGeneration)
    }))

  it.live("a failed provider blocks dependents and same-key retry creates a generation", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      probe.fail("Language", "typescript")
      const editor = yield* make(probe)
      yield* editor.commit(base({ documents: ["foo"] }))
      yield* editor.idle

      expect(yield* editor.status("Language", "typescript")).toBe("Failed")
      expect(matching(probe, "start", "Diagnostics", "foo")).toEqual([])
      const failed = matching(probe, "failed", "Language", "typescript")[0]!.generation

      probe.fix("Language", "typescript")
      yield* editor.retryLanguage
      yield* editor.idle

      const running = matching(probe, "running", "Language", "typescript").at(-1)!
      expect(running.generation).not.toBe(failed)
      expect(matching(probe, "running", "Diagnostics", "foo")).toHaveLength(1)
    }))

  it.live("sequential replacement waits, coalesces A → B → C, and skips B", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)
      yield* editor.commit(base({ session: "A", workspace: null, documents: [] }))
      yield* editor.idle
      yield* probe.pauseStop("Session", "A")

      yield* editor.commit(base({ session: "B", workspace: null, documents: [] }))
      yield* eventually(
        () => matching(probe, "stopping", "Session", "A").length === 1,
        "A finalizer entered"
      )
      yield* editor.commit(base({ session: "C", workspace: null, documents: [] }))
      expect(matching(probe, "start", "Session", "B")).toEqual([])
      expect(matching(probe, "start", "Session", "C")).toEqual([])

      yield* probe.resumeStop("Session", "A")
      yield* editor.idle
      expect(matching(probe, "start", "Session", "B")).toEqual([])
      expect(matching(probe, "running", "Session", "C")).toHaveLength(1)
    }))

  it.live("overlap starts the replacement while the old generation finalizes", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe, { replacement: { Session: "overlap" } })
      yield* editor.commit(base({ session: "A", workspace: null, documents: [] }))
      yield* editor.idle
      yield* probe.pauseStop("Session", "A")

      yield* editor.commit(base({ session: "B", workspace: null, documents: [] }))
      yield* eventually(
        () => matching(probe, "running", "Session", "B").length === 1,
        "B running during A finalization"
      )
      expect(matching(probe, "stop", "Session", "A")).toEqual([])
      yield* probe.resumeStop("Session", "A")
      yield* editor.idle
    }))

  it.live("state desire keeps resources alive without an external Atom subscriber", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)
      yield* editor.commit(base({ documents: ["background"] }))
      yield* editor.idle

      // The experiment owns one root subscription; no UI or test subscription
      // to desiredAtom/status is required to keep the Layer Scope mounted.
      expect(matching(probe, "running", "Document", "background")).toHaveLength(1)
      yield* Effect.sleep(20)
      expect(yield* editor.status("Document", "background")).toBe("Running")
    }))

  it.live("a finite Effect borrows the exact generation and is interrupted with it", () =>
    Effect.gen(function* () {
      const editor = yield* make()
      yield* editor.commit(base({ documents: ["foo"] }))
      yield* editor.idle
      const entered = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()

      const fiber = yield* Effect.forkChild(
        editor.runDocument(
          "foo",
          Effect.gen(function* () {
            const session = yield* Session
            const workspace = yield* Workspace
            const document = yield* Document
            expect([session.user, workspace.id, document.uri]).toEqual(["alice", "main", "foo"])
            yield* Deferred.succeed(entered, void 0)
            yield* Deferred.await(never)
          })
        )
      )
      yield* Deferred.await(entered)
      yield* editor.commit(base({ documents: [] }))
      yield* editor.idle
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
    }))

  it.live("Atom dependency values update without replacing an unrelated Layer lifetime", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const editor = yield* make(probe)
      yield* editor.commit(base())
      yield* editor.idle
      const sessionStarts = matching(probe, "start", "Session", "alice").length
      const settingsReads = editor.atomCounts.settings

      yield* editor.commit(base({ settingsRevision: 2 }))
      yield* editor.idle
      expect(editor.atomCounts.settings).toBeGreaterThan(settingsReads)
      expect(matching(probe, "start", "Session", "alice")).toHaveLength(sessionStarts)
    }))

  it.live("shutdown finalizes the Layer graph", () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const editor = yield* make(probe)
          yield* editor.commit(base())
          yield* editor.idle
        })
      )
      const started = probe.events.filter((event) => event.type === "start").length
      const stopped = probe.events.filter((event) => event.type === "stop").length
      expect(stopped).toBe(started)
    }))

  it.live("empty desire has no owned subtree", () =>
    Effect.gen(function* () {
      const editor = yield* make()
      yield* editor.commit(emptyModel)
      yield* editor.idle
      expect(yield* editor.status("Session", "alice")).toBe("None")
      expect(editor.lifecycleHelper.generations()).toBe(1) // Settings is root-desired.
    }))
})
