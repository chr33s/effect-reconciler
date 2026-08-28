import { Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as Key from "../src/Key.js"
import * as Reconciler from "../src/Reconciler.js"
import { count, eventually, settle } from "./util.js"

interface UserState {
  readonly user: Option.Option<string>
}

const makeSession = (log: Array<string>) =>
  Reconciler.define((define) => ({
    Session: define.one("Session", {
      key: Key.string,
      start: (userId: string) =>
        Effect.gen(function* () {
          log.push(`start:${userId}`)
          yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`stop:${userId}`)))
        })
    })
  }))

describe("identity", () => {
  it.live("9.1/9.10 — equal keys retain the physical lifetime; equivalent commits cause no churn", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = makeSession(log)
      const controller = yield* Reconciler.make(
        Def.bind<UserState>((bind) => ({
          session: bind.one(Def.Session, (s) => s.user)
        }))
      )

      yield* controller.commit({ user: Option.some("alice") })
      yield* eventually(() => log.includes("start:alice"), "session started")

      // A different state object with semantically equivalent desire.
      yield* controller.commit({ user: Option.some("alice") })
      yield* controller.commit({ user: Option.some("alice") })
      yield* settle

      expect(log).toEqual(["start:alice"])
    }))

  it.live("9.2 — changed keys replace the lifetime (sequential: stop before start)", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = makeSession(log)
      const controller = yield* Reconciler.make(
        Def.bind<UserState>((bind) => ({
          session: bind.one(Def.Session, (s) => s.user)
        }))
      )

      yield* controller.commit({ user: Option.some("alice") })
      yield* eventually(() => log.includes("start:alice"), "alice started")
      yield* controller.commit({ user: Option.some("bob") })
      yield* eventually(() => log.includes("start:bob"), "bob started")

      expect(log).toEqual(["start:alice", "stop:alice", "start:bob"])
    }))

  it.live("one cardinality — None removes the instance", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = makeSession(log)
      const controller = yield* Reconciler.make(
        Def.bind<UserState>((bind) => ({
          session: bind.one(Def.Session, (s) => s.user)
        }))
      )

      yield* controller.commit({ user: Option.some("alice") })
      yield* eventually(() => log.includes("start:alice"), "started")
      yield* controller.commit({ user: Option.none() })
      yield* eventually(() => log.includes("stop:alice"), "stopped")
      yield* settle
      expect(log).toEqual(["start:alice", "stop:alice"])
    }))

  it.live("9.16 — many keys reconcile independently (add / retain / remove)", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Document: define.many("Document", {
          key: Key.string,
          start: (uri: string) =>
            Effect.gen(function* () {
              log.push(`start:${uri}`)
              yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`stop:${uri}`)))
            })
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly documents: ReadonlyArray<string> }>((bind) => ({
          documents: bind.many(Def.Document, (s) => s.documents)
        }))
      )

      yield* controller.commit({ documents: ["foo", "bar"] })
      yield* eventually(
        () => log.includes("start:foo") && log.includes("start:bar"),
        "foo+bar started"
      )

      yield* controller.commit({ documents: ["bar", "baz"] })
      yield* eventually(
        () => log.includes("stop:foo") && log.includes("start:baz"),
        "foo stopped, baz started"
      )
      yield* settle

      expect(count(log, "start:bar")).toBe(1)
      expect(count(log, "stop:bar")).toBe(0)
      expect(count(log, "start:foo")).toBe(1)
      expect(count(log, "stop:foo")).toBe(1)
      expect(count(log, "start:baz")).toBe(1)
    }))

  it.live("§69 — the same Definition binds to multiple state types", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = makeSession(log)

      const boundModel = Def.bind<UserState>((bind) => ({
        session: bind.one(Def.Session, (s) => s.user)
      }))
      const boundConfig = Def.bind<{ readonly account: string | null }>((bind) => ({
        session: bind.one(Def.Session, (c) => Option.fromNullishOr(c.account))
      }))

      const a = yield* Reconciler.make(boundModel)
      const b = yield* Reconciler.make(boundConfig)

      yield* a.commit({ user: Option.some("alice") })
      yield* b.commit({ account: "bob" })
      yield* eventually(
        () => log.includes("start:alice") && log.includes("start:bob"),
        "both controllers converged"
      )
    }))

  it.live("Key.struct — key equality is structural, not referential", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Doc: define.one("Doc", {
          key: Key.struct({ uri: Key.string, version: Key.number }),
          start: (k: { readonly uri: string; readonly version: number }) =>
            Effect.sync(() => log.push(`start:${k.uri}@${k.version}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly uri: string; readonly version: number }>((bind) => ({
          doc: bind.one(Def.Doc, (s) => Option.some({ uri: s.uri, version: s.version }))
        }))
      )

      yield* controller.commit({ uri: "a", version: 1 })
      yield* eventually(() => log.includes("start:a@1"), "started")
      // New object, equal structure: retained.
      yield* controller.commit({ uri: "a", version: 1 })
      yield* settle
      expect(log).toEqual(["start:a@1"])
      // Changed field: replaced.
      yield* controller.commit({ uri: "a", version: 2 })
      yield* eventually(() => log.includes("start:a@2"), "replaced")
    }))

  it.live("custom Key encodings containing path delimiters cannot collide identities", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      // Raw identity encoding: injective, but full of '/'-':'-'|' characters.
      const rawKey: Key.Key<string> = { encode: (s) => s }
      const Def = Reconciler.define((define) => {
        const Parent = define.many("Parent", {
          key: rawKey,
          start: (k: string) => Effect.sync(() => log.push(`parent:${k}`))
        })
        const Child = define.one("Child", {
          key: rawKey,
          owner: Parent,
          start: (k: string) => Effect.sync(() => log.push(`child:${k}`))
        })
        return { Parent, Child }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({
          // Parent "a" with child "b" would collide with parent "a/1:b" if
          // encodings were spliced into paths unescaped.
          parents: bind.many(Def.Parent, () => ["a", "a/1:b"]),
          child: bind.one(Def.Child, (_s, parentKey: string) =>
            parentKey === "a" ? Option.some("b") : Option.none()
          )
        }))
      )

      yield* controller.commit({})
      yield* eventually(
        () =>
          log.includes("parent:a") &&
          log.includes("parent:a/1:b") &&
          log.includes("child:b"),
        "all three distinct lifetimes exist"
      )
      expect(log).toHaveLength(3)
    }))

  it.live("Key.number distinguishes 0 from -0 (encode defines semantic equality)", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          key: Key.number,
          start: (k: number) =>
            Effect.sync(() => log.push(`start:${Object.is(k, -0) ? "-0" : String(k)}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly key: number }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(s.key))
        }))
      )

      yield* controller.commit({ key: 0 })
      yield* eventually(() => log.includes("start:0"), "0 started")
      yield* controller.commit({ key: -0 })
      yield* eventually(() => log.includes("start:-0"), "-0 replaced 0")
    }))
})
