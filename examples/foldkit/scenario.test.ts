/**
 * The migration check: the same user story, run against both versions, judged
 * on what each did to the backend.
 *
 * If the reconciler version does anything different to the outside world, the
 * migration changed behaviour and the coordination metrics are meaningless.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeBackend, unsupportedLanguage } from "./backend.js"
import { subjects } from "./subjects.js"

describe("workspace diagnostics", () => {
  for (const subject of subjects) {
    describe(subject.name, () => {
      it.live("runs the editor story", () =>
        Effect.gen(function* () {
          const { control, service } = yield* makeBackend
          const app = yield* subject.start(service, control)

          // Nothing exists before there is a session and a workspace.
          yield* app.openDocument("a.ts")
          expect(control.liveServers()).toEqual([])
          expect(control.liveAnalyzers()).toEqual([])

          yield* app.signIn("alice")
          expect(control.liveServers()).toEqual([])

          // The whole owner chain is live: the connection opens and the
          // already-open document gets its analyzer.
          yield* app.openWorkspace("acme")
          expect(control.liveServers()).toHaveLength(1)
          expect(control.liveAnalyzers()).toHaveLength(1)

          // Rapid document churn: analyzers follow, the connection does not.
          yield* app.openDocument("b.ts")
          yield* app.openDocument("c.ts")
          yield* app.closeDocument("a.ts")
          expect(control.liveAnalyzers()).toHaveLength(2)
          expect(control.liveServers()).toHaveLength(1)

          // Diagnostics arrive on the connection's stream.
          yield* control.emit({ uri: "b.ts", message: "unused variable" })
          yield* Effect.sleep(20)
          expect(app.diagnostics()).toEqual([{ uri: "b.ts", message: "unused variable" }])

          // A settings change invalidates the analyzers that captured the old
          // revision, and leaves the connection alone.
          const serverBefore = control.liveServers()[0]
          yield* app.changeSettings(2)
          expect(control.liveServers()).toEqual([serverBefore])
          expect(control.liveAnalyzers()).toHaveLength(2)
          expect(control.events.filter((event) => event.includes(":rev2"))).toHaveLength(2)

          // A language change replaces the connection, and everything beneath it.
          yield* app.changeLanguage("rust")
          expect(control.liveServers()).toHaveLength(1)
          expect(control.liveServers()).not.toEqual([serverBefore])
          expect(control.liveAnalyzers()).toHaveLength(2)

          // Signing out closes the whole tree.
          yield* app.signOut
          expect(control.liveServers()).toEqual([])
          expect(control.liveAnalyzers()).toEqual([])
        }))

      it.live("surfaces a language server that cannot start", () =>
        Effect.gen(function* () {
          const { control, service } = yield* makeBackend
          const app = yield* subject.start(service, control)

          yield* app.signIn("alice")
          yield* app.openWorkspace("acme")
          yield* app.openDocument("a.ts")
          yield* app.changeLanguage(unsupportedLanguage)

          // The failure is visible to the application, and nothing was left
          // running against a connection that never opened.
          expect(app.serverUnavailable()).toBe(true)
          expect(control.liveServers()).toEqual([])
          expect(control.liveAnalyzers()).toEqual([])

          // A supported language recovers without any further user action.
          yield* app.changeLanguage("typescript")
          expect(app.serverUnavailable()).toBe(false)
          expect(control.liveServers()).toHaveLength(1)
          expect(control.liveAnalyzers()).toHaveLength(1)
        }))
    })
  }
})
