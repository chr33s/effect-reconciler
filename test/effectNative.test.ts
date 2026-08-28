/**
 * The reconciler decides what should exist; Effect decides how it runs
 * (spec.3 §29, §43, §44).
 *
 * These two tests exist to keep that boundary honest. Transient retry inside a
 * startup is `Effect.retry` with a `Schedule` and stays one physical
 * generation; building services is `Layer` inside the instance Scope. Neither
 * has, or needs, a reconciler-specific API.
 */
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Schedule } from "effect"
import * as Reconciler from "../src/Reconciler.js"
import { idle, StartupFailed, statusTag } from "./util.js"

class Connection extends Context.Service<Connection, {
  readonly endpoint: string
}>()("test/Connection") {}

describe("effect-native startup", () => {
  it.live("§43 — transient retry inside startup is one generation", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      let attempts = 0

      const Def = Reconciler.define((define) => ({
        Server: define.one("Server", {
          start: (endpoint: string) =>
            Effect.gen(function* () {
              attempts++
              log.push(`attempt:${attempts}`)
              // Flaky twice, then fine — ordinary Effect, ordinary Schedule.
              if (attempts < 3) return yield* new StartupFailed({ reason: "flaky" })
              yield* Effect.addFinalizer(() => Effect.sync(() => log.push("release")))
              log.push(`open:${endpoint}`)
            }).pipe(Effect.retry(Schedule.recurs(5)))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly endpoint: string }>((bind) => ({
          server: bind.one(Def.Server, (s) => Option.some(s.endpoint))
        }))
      )
      const ref = Reconciler.ref(Def.Server, "wss://a", null)

      yield* controller.commit({ endpoint: "wss://a" })
      yield* idle(controller)

      // Three acquisition attempts, one lifetime: the reconciler saw a single
      // startup that happened to take a while, and no failure at all.
      expect(log).toEqual(["attempt:1", "attempt:2", "attempt:3", "open:wss://a"])
      expect(yield* statusTag(controller, ref)).toBe("Running")

      // And it is one generation: nothing was released along the way.
      expect(log.filter((entry) => entry === "release")).toEqual([])
    }))

  it.live("§44 — a lifetime may build a Layer in its own Scope", () =>
    Effect.gen(function* () {
      const log: Array<string> = []

      const connectionLayer = (endpoint: string) =>
        Layer.effect(
          Connection,
          Effect.acquireRelease(
            Effect.sync(() => {
              log.push(`open:${endpoint}`)
              return { endpoint }
            }),
            () => Effect.sync(() => log.push(`close:${endpoint}`))
          )
        )

      const Def = Reconciler.define((define) => {
        const Server = define.one("Server", {
          // The Layer is built into the instance Scope, and its Context is
          // published to children exactly like any other returned Context.
          start: (endpoint: string) => Layer.build(connectionLayer(endpoint))
        })
        const Consumer = define.one("Consumer", {
          owner: Server,
          start: (_: null) =>
            Effect.gen(function* () {
              const connection = yield* Connection
              log.push(`use:${connection.endpoint}`)
            })
        })
        return { Server, Consumer }
      })

      const controller = yield* Reconciler.make(
        Def.bind<{ readonly endpoint: string }>((bind) => ({
          server: bind.one(Def.Server, (s) => Option.some(s.endpoint)),
          consumer: bind.one(Def.Consumer, () => Option.some(null))
        }))
      )

      yield* controller.commit({ endpoint: "wss://a" })
      yield* idle(controller)
      expect(log).toEqual(["open:wss://a", "use:wss://a"])

      // Replacing the lifetime tears the Layer down with its Scope.
      yield* controller.commit({ endpoint: "wss://b" })
      yield* idle(controller)
      expect(log).toEqual([
        "open:wss://a",
        "use:wss://a",
        "close:wss://a",
        "open:wss://b",
        "use:wss://b"
      ])
    }))
})
