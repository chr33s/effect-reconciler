import { Context, Deferred, Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as Key from "../src/Key.js"
import * as Reconciler from "../src/Reconciler.js"
import * as Replacement from "../src/Replacement.js"
import { bindEditor, makeEditor, model, SessionService } from "./fixtures.js"
import { count, eventually, settle } from "./util.js"

describe("ownership", () => {
  it.live("9.3 — owner invalidation closes all descendants structurally", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const editor = makeEditor(log)
      const controller = yield* Reconciler.make(bindEditor(editor))

      yield* controller.commit(
        model({
          user: Option.some("alice"),
          workspaceId: Option.some("acme"),
          language: Option.some("ts"),
          documents: ["foo", "bar"],
          diagnostics: true
        })
      )
      yield* eventually(
        () =>
          log.includes("start:diagnostics:foo:s1:ts") &&
          log.includes("start:diagnostics:bar:s1:ts"),
        "full tree converged"
      )

      // Session key changes; no child binding repeats the session predicate.
      yield* controller.commit(
        model({
          user: Option.some("bob"),
          workspaceId: Option.some("acme"),
          language: Option.some("ts"),
          documents: ["foo", "bar"],
          diagnostics: true
        })
      )
      yield* eventually(() => log.includes("start:workspace:acme@bob"), "rebuilt under bob")

      expect(log).toContain("stop:session:alice")
      expect(log).toContain("stop:workspace:acme@alice")
      expect(log).toContain("stop:language:ts")
      expect(log).toContain("stop:document:foo")
      expect(log).toContain("stop:document:bar")
      expect(log).toContain("stop:diagnostics:foo:s1:ts")

      // 9.17 — Session[alice]/Workspace[acme] and Session[bob]/Workspace[acme]
      // are different physical Workspace lifetimes despite the equal key.
      yield* eventually(
        () => count(log, "start:document:foo") === 2,
        "documents rebuilt under new workspace"
      )
      expect(count(log, "start:workspace:acme@alice")).toBe(1)
      expect(count(log, "start:workspace:acme@bob")).toBe(1)
    }))

  it.live("child waits for its owner to become Running", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const gate = yield* Deferred.make<void>()
      const Def = Reconciler.define((define) => {
        const Session = define.one("Session", {
          key: Key.string,
          start: (userId: string) =>
            Effect.gen(function* () {
              log.push(`session:starting:${userId}`)
              yield* Deferred.await(gate)
              log.push(`session:running:${userId}`)
            })
        })
        const Workspace = define.one("Workspace", {
          key: Key.string,
          owner: Session,
          start: (id: string) => Effect.sync(() => log.push(`workspace:start:${id}`))
        })
        return { Session, Workspace }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly user: string }>((bind) => ({
          session: bind.one(Def.Session, (s) => Option.some(s.user)),
          workspace: bind.one(Def.Workspace, () => Option.some("acme"))
        }))
      )

      yield* controller.commit({ user: "alice" })
      yield* eventually(() => log.includes("session:starting:alice"), "session starting")
      yield* settle
      expect(log).not.toContain("workspace:start:acme")

      yield* Deferred.succeed(gate, void 0)
      yield* eventually(() => log.includes("workspace:start:acme"), "workspace admitted")
    }))

  it.live("9.6 — late child startup completion cannot outlive its replaced owner", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      // Released only after the owner has been replaced: the first
      // workspace's startup completes "successfully" but late.
      const lateGate = yield* Deferred.make<void>()

      class WorkspaceReady extends Context.Service<
        WorkspaceReady,
        { readonly under: string }
      >()("test/WorkspaceReady") {}

      const Def = Reconciler.define((define) => {
        const Session = define.one("Session", {
          key: Key.string,
          replacement: Replacement.overlap(),
          start: (userId: string) =>
            Effect.succeed(Context.make(SessionService, { userId }))
        })
        const Workspace = define.one("Workspace", {
          key: Key.string,
          owner: Session,
          start: (id: string) =>
            Effect.gen(function* () {
              const session = yield* SessionService
              log.push(`workspace:begin:${id}@${session.userId}`)
              if (session.userId === "alice") {
                // Uninterruptible: obsolescence cannot interrupt this
                // startup; it must be discarded on late completion instead.
                yield* Effect.uninterruptible(Deferred.await(lateGate))
              }
              return Context.make(WorkspaceReady, { under: session.userId })
            })
        })
        // Admitted only beneath a Running workspace: observes exactly which
        // workspace generations ever became Running.
        const Marker = define.one("Marker", {
          key: Key.null,
          owner: Workspace,
          start: () =>
            Effect.gen(function* () {
              const ready = yield* WorkspaceReady
              log.push(`marker:${ready.under}`)
            })
        })
        return { Session, Workspace, Marker }
      })

      const controller = yield* Reconciler.make(
        Def.bind<{ readonly user: string }>((bind) => ({
          session: bind.one(Def.Session, (s) => Option.some(s.user)),
          workspace: bind.one(Def.Workspace, () => Option.some("acme")),
          marker: bind.one(Def.Marker, () => Option.some(null))
        }))
      )

      yield* controller.commit({ user: "alice" })
      yield* eventually(() => log.includes("workspace:begin:acme@alice"), "W#1 starting")

      yield* controller.commit({ user: "bob" })
      yield* eventually(() => log.includes("marker:bob"), "new generation running")

      // Let W#1's startup complete late.
      yield* Deferred.succeed(lateGate, void 0)
      yield* settle

      // W#1 never became Running: it never admitted its Marker.
      expect(log.filter((e) => e.startsWith("marker:"))).toEqual(["marker:bob"])
    }))
})
