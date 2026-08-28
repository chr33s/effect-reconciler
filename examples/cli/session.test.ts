/**
 * The sketch, driven as a scripted transcript: real ports, real files, real
 * `EADDRINUSE`.
 *
 * It is here because the interesting claims of the example are exactly the
 * ones a reader would otherwise have to take on faith — that `serve` twice
 * never leaves two listeners on the old port, that a watcher follows the
 * server generation it required, and that a failed bind is recoverable with
 * `retry` and nothing else.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { eventually } from "../../test/util.js"
import { empty, parse, Term, update } from "./app.js"
import * as Session from "./session.js"

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })

const occupy = (port: number): Promise<net.Server> =>
  new Promise((resolve, reject) => {
    const squatter = net.createServer()
    squatter.once("error", reject)
    squatter.listen(port, "127.0.0.1", () => resolve(squatter))
  })

const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1")
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })

/** A terminal that remembers, so the transcript is what the test asserts on. */
const recorder = () => {
  const lines: Array<string> = []
  const service: typeof Term.Service = {
    line: (text) =>
      Effect.sync(() => {
        for (const part of text.split("\n")) lines.push(part)
      })
  }
  return {
    service,
    lines,
    saw: (fragment: string) => lines.some((line) => line.includes(fragment)),
    since: (mark: number) => lines.slice(mark)
  }
}

describe("devctl", () => {
  it("commands are a pure function of state", () => {
    expect(parse("serve 3000")).toEqual({ _tag: "Serve", port: 3000 })
    expect(parse("serve nope")._tag).toEqual("Unknown")
    // Stopping a server is withdrawing desire, not a lifecycle call.
    const served = update(update(empty, parse("open .")), parse("serve 3000"))
    expect(update(served, parse("stop")).port._tag).toEqual("None")
    // Watching the same file twice is not two watchers.
    const watched = update(update(served, parse("watch a.ts")), parse("watch a.ts"))
    expect(watched.watching).toEqual(["a.ts"])
  })

  it.live("serves, watches, re-binds and recovers", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "devctl-")))
      yield* Effect.promise(() => fs.writeFile(path.join(root, "a.ts"), "export const a = 1\n"))
      const first = yield* Effect.promise(freePort)
      const second = yield* Effect.promise(freePort)
      const taken = yield* Effect.promise(freePort)
      const term = recorder()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make

          // Desire ahead of the tree: a watcher with no project is desired and
          // simply not admissible yet. No error, nothing to clean up later.
          yield* session.submit("watch a.ts")
          yield* session.submit("status")
          expect(term.saw("no project")).toBe(true)

          // The project admits nothing on its own: Watch requires a Server.
          yield* session.submit(`open ${root}`)
          yield* eventually(() => term.saw(`opened ${root}`), "project opened")
          expect(term.saw("watching a.ts")).toBe(false)

          // One command, two lifetimes: the server binds, and the watcher its
          // capability was waiting on is admitted behind it.
          yield* session.submit(`serve ${first}`)
          yield* eventually(() => term.saw(`watching a.ts → :${first}`), "watcher admitted")
          expect(yield* Effect.promise(() => listening(first))).toBe(true)

          // Re-binding: `sequential` replacement means the old listener has
          // reached its finalization boundary before the new one binds — so by
          // the time the new port answers, the old one is already free.
          const mark = term.lines.length
          yield* session.submit(`serve ${second}`)
          yield* eventually(() => term.saw(`watching a.ts → :${second}`), "watcher followed")
          expect(yield* Effect.promise(() => listening(first))).toBe(false)
          expect(yield* Effect.promise(() => listening(second))).toBe(true)
          // The watcher was replaced, not silently re-pointed at the new server.
          expect(term.since(mark).some((line) => line.includes("unwatched a.ts"))).toBe(true)

          // A real failure: something else already owns the port.
          const squatter = yield* Effect.promise(() => occupy(taken))
          yield* session.submit(`serve ${taken}`)
          yield* eventually(() => term.saw("! Server"), "failure reported")
          expect(term.saw("EADDRINUSE")).toBe(true)

          // Failure is remembered, not just announced.
          yield* session.submit("status")
          expect(term.saw("failed — ListenFailed")).toBe(true)
          // And it holds its slot: re-committing the same state is not a retry.
          yield* session.submit(`serve ${taken}`)
          yield* session.submit("status")
          expect(term.saw("failed — ListenFailed")).toBe(true)

          // The environment is fixed outside the CLI; `retry` is what turns
          // that into a fresh generation under the same key.
          yield* Effect.promise(
            () => new Promise<void>((resolve) => squatter.close(() => resolve()))
          )
          yield* session.submit("retry server")
          yield* eventually(() => term.saw(`watching a.ts → :${taken}`), "recovered")
          expect(yield* Effect.promise(() => listening(taken))).toBe(true)

          // Closing the project closes everything under it, structurally.
          yield* session.submit("close")
          yield* eventually(() => term.saw(`closed ${root}`), "project closed")
          expect(yield* Effect.promise(() => listening(taken))).toBe(false)
        })
      ).pipe(Effect.provideService(Term, term.service))

      yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
    }))

  it.live("leaving the session closes what it started", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "devctl-")))
      const port = yield* Effect.promise(freePort)
      const term = recorder()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make
          yield* session.submit(`open ${root}`)
          yield* session.submit(`serve ${port}`)
          yield* eventually(() => term.saw(`on http://127.0.0.1:${port}`), "serving")
        })
      ).pipe(Effect.provideService(Term, term.service))

      // The Scope closed on the way out, and finalization was awaited.
      expect(yield* Effect.promise(() => listening(port))).toBe(false)
      expect(term.saw(`stopped :${port}`)).toBe(true)
      yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
    }))
})
