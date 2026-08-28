/**
 * The generic lifecycle races this feature has to survive.
 *
 * Read these twice. For the "before" version they test **application code**:
 * every rule they check is written by hand in `before/app.ts`, and a real
 * project would have to keep them forever. For the "after" version the
 * application contains no lifetime rules at all, so the same scenarios pass
 * against behaviour the reconciler's own conformance suite already proves —
 * which is exactly what Phase 5 means by race tests moving out of the
 * application.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeBackend } from "./backend.js"
import { subjects } from "./subjects.js"

/** Events for one document, in order, as `start` / `stop`. */
const documentEvents = (events: ReadonlyArray<string>, uri: string): ReadonlyArray<string> =>
  events
    .filter((event) => event.startsWith(`analyzer:start:${uri}@`) || event === `analyzer:stop:${uri}`)
    .map((event) => (event.startsWith("analyzer:start:") ? "start" : "stop"))

describe("lifecycle races", () => {
  for (const subject of subjects) {
    describe(subject.name, () => {
      it.live("an analyzer that starts against a superseded connection cannot win", () =>
        Effect.gen(function* () {
          const { control, service } = yield* makeBackend
          const app = yield* subject.start(service, control)

          yield* app.signIn("alice")
          yield* app.openWorkspace("acme")

          // The analyzer start is in flight when the connection is replaced.
          yield* control.pauseAnalyzers
          yield* app.fire.openDocument("a.ts")
          yield* Effect.sleep(10)
          yield* app.fire.changeLanguage("rust")
          yield* Effect.sleep(10)
          yield* control.resumeAnalyzers
          yield* app.settle

          // Exactly one analyzer survives, and it belongs to the live server.
          const live = control.liveServers()
          expect(live).toHaveLength(1)
          expect(control.liveAnalyzers()).toHaveLength(1)
          const lastStart = control.events
            .filter((event) => event.startsWith("analyzer:start:a.ts@"))
            .at(-1)
          expect(lastStart).toContain(live[0])
        }))

      it.live("no analyzer outlives the connection it belongs to", () =>
        Effect.gen(function* () {
          const { control, service } = yield* makeBackend
          const app = yield* subject.start(service, control)

          yield* app.signIn("alice")
          yield* app.openWorkspace("acme")
          yield* app.openDocument("a.ts")
          yield* app.openDocument("b.ts")
          expect(control.liveAnalyzers()).toHaveLength(2)

          yield* app.signOut

          expect(control.liveAnalyzers()).toEqual([])
          expect(control.liveServers()).toEqual([])
          // Every analyzer stopped before the connection closed.
          const closed = control.events.indexOf("analyzer:stop:b.ts")
          const serverClosed = control.events.findIndex((event) => event.startsWith("server:close:"))
          expect(closed).toBeLessThan(serverClosed)
        }))

      it.live("a settings change during startup never leaves a stale analyzer", () =>
        Effect.gen(function* () {
          const { control, service } = yield* makeBackend
          const app = yield* subject.start(service, control)

          yield* app.signIn("alice")
          yield* app.openWorkspace("acme")

          yield* control.pauseAnalyzers
          yield* app.fire.openDocument("a.ts")
          yield* Effect.sleep(10)
          yield* app.fire.changeSettings(2)
          yield* Effect.sleep(10)
          yield* control.resumeAnalyzers
          yield* app.settle

          expect(control.liveAnalyzers()).toHaveLength(1)
          const lastStart = control.events
            .filter((event) => event.startsWith("analyzer:start:a.ts@"))
            .at(-1)
          expect(lastStart).toContain(":rev2")
        }))

      it.live("the latest desired language wins after rapid changes", () =>
        Effect.gen(function* () {
          const { control, service } = yield* makeBackend
          const app = yield* subject.start(service, control)

          yield* app.signIn("alice")
          yield* app.openWorkspace("acme")
          yield* app.openDocument("a.ts")

          yield* app.fire.changeLanguage("rust")
          yield* app.fire.changeLanguage("go")
          yield* app.fire.changeLanguage("python")
          yield* app.settle

          expect(control.liveServers()).toHaveLength(1)
          const opened = control.events.filter((event) => event.startsWith("server:open:"))
          expect(opened.at(-1)).toContain("python")
          // Every superseded connection was closed.
          const closed = control.events.filter((event) => event.startsWith("server:close:"))
          expect(closed).toHaveLength(opened.length - 1)
        }))

      it.live("a document reopened during cleanup never runs two analyzers", () =>
        Effect.gen(function* () {
          const { control, service } = yield* makeBackend
          const app = yield* subject.start(service, control)

          yield* app.signIn("alice")
          yield* app.openWorkspace("acme")
          yield* app.openDocument("a.ts")

          for (let round = 0; round < 5; round++) {
            yield* app.fire.closeDocument("a.ts")
            yield* app.fire.openDocument("a.ts")
          }
          yield* app.settle

          // start/stop strictly alternate: the document never had two
          // analyzers running at the same time.
          const sequence = documentEvents(control.events, "a.ts")
          for (const [index, event] of sequence.entries()) {
            expect(event).toBe(index % 2 === 0 ? "start" : "stop")
          }
          expect(control.liveAnalyzers()).toHaveLength(1)
        }))
    })
  }
})
