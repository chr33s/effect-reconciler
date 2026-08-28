import { Data, Effect, Equal, Hash, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as Reconciler from "../src/Reconciler.js"
import { count, eventually, idle } from "./util.js"

interface UserState {
  readonly user: Option.Option<string>
}

const makeSession = (log: Array<string>) =>
  Reconciler.define((define) => ({
    Session: define.one("Session", {
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
      yield* idle(controller)

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
      yield* idle(controller)
      expect(log).toEqual(["start:alice", "stop:alice"])
    }))

  it.live("9.16 — many keys reconcile independently (add / retain / remove)", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Document: define.many("Document", {
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
      yield* idle(controller)

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

  it.live("structural keys are compared structurally, not referentially", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      // An ordinary Effect data value. A plain object literal works too:
      // Effect compares and hashes both structurally.
      class DocumentKey extends Data.Class<{
        readonly uri: string
        readonly version: number
      }> {}

      const Def = Reconciler.define((define) => ({
        Doc: define.one("Doc", {
          start: (k: DocumentKey) => Effect.sync(() => log.push(`start:${k.uri}@${k.version}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly uri: string; readonly version: number }>((bind) => ({
          doc: bind.one(Def.Doc, (s) =>
            Option.some(new DocumentKey({ uri: s.uri, version: s.version }))
          )
        }))
      )

      yield* controller.commit({ uri: "a", version: 1 })
      yield* eventually(() => log.includes("start:a@1"), "started")
      // A different instance with equal contents: the same lifetime.
      yield* controller.commit({ uri: "a", version: 1 })
      yield* idle(controller)
      expect(log).toEqual(["start:a@1"])
      // Changed field: a different lifetime.
      yield* controller.commit({ uri: "a", version: 2 })
      yield* eventually(() => log.includes("start:a@2"), "replaced")
    }))

  it.live("a plain object key works without any key descriptor", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Doc: define.many("Doc", {
          start: (k: { readonly uri: string; readonly line: number }) =>
            Effect.sync(() => log.push(`start:${k.uri}:${k.line}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly lines: ReadonlyArray<number> }>((bind) => ({
          docs: bind.many(Def.Doc, (s) => s.lines.map((line) => ({ uri: "a.ts", line })))
        }))
      )

      yield* controller.commit({ lines: [1, 2] })
      yield* eventually(() => log.length === 2, "both started")
      // Fresh objects with equal contents each commit: no churn at all.
      yield* controller.commit({ lines: [1, 2] })
      yield* controller.commit({ lines: [1, 2] })
      yield* idle(controller)
      expect(log).toEqual(["start:a.ts:1", "start:a.ts:2"])
    }))

  it.live("keys full of delimiter characters cannot collide across owners", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => {
        const Parent = define.many("Parent", {
          start: (k: string) => Effect.sync(() => log.push(`parent:${k}`))
        })
        const Child = define.one("Child", {
          owner: Parent,
          start: (k: string) => Effect.sync(() => log.push(`child:${k}`))
        })
        return { Parent, Child }
      })
      const controller = yield* Reconciler.make(
        Def.bind<{}>((bind) => ({
          // Identity is structural, so there is no encoding for these
          // characters to collide inside — the parent key is the value, not a
          // string spliced into a path.
          parents: bind.many(Def.Parent, () => ["a", "a/1:b", "a|b"]),
          child: bind.one(Def.Child, (_s, owner) =>
            owner.key === "a" ? Option.some("b") : Option.none()
          )
        }))
      )

      yield* controller.commit({})
      yield* eventually(
        () =>
          log.includes("parent:a") &&
          log.includes("parent:a/1:b") &&
          log.includes("parent:a|b") &&
          log.includes("child:b"),
        "all four distinct lifetimes exist"
      )
      expect(log).toHaveLength(4)
    }))

  it.live("structurally distinct keys stay distinct however adversarial", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      class Pair extends Data.Class<{ readonly a: string; readonly b: string }> {}
      const Def = Reconciler.define((define) => ({
        Res: define.many("Res", {
          start: (k: Pair) => Effect.sync(() => log.push(`start:${k.a}|${k.b}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly keys: ReadonlyArray<Pair> }>((bind) => ({
          res: bind.many(Def.Res, (s) => s.keys)
        }))
      )

      // Pairs that a naive `"a":<a>,"b":<b>` concatenation would collide, plus
      // quotes, braces, slashes and pipes. Structural identity has no encoding
      // for them to collide inside.
      const adversarial = [
        new Pair({ a: `1,"b":2`, b: `3` }),
        new Pair({ a: `1`, b: `2,"b":3` }),
        new Pair({ a: `{"a":x}`, b: `y` }),
        new Pair({ a: `{"a":x}|y`, b: `` }),
        new Pair({ a: `/1:2`, b: `|3` }),
        new Pair({ a: `/1`, b: `:2|3` })
      ]

      yield* controller.commit({ keys: adversarial })
      yield* eventually(
        () => log.length === adversarial.length,
        "every distinct structure got its own lifetime"
      )
      expect(new Set(log).size).toBe(adversarial.length)
    }))

  it.live("a key compared by reference is fine while the value is stable", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      // Opting out of structural comparison: this value is identified by
      // reference, which is legitimate as long as the Binding yields the same
      // value each commit.
      const stable = Equal.byReference({ id: "a" })
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: { readonly id: string }) => Effect.sync(() => log.push(`start:${k.id}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly fresh: boolean }>((bind) => ({
          res: bind.one(Def.Res, (s) =>
            Option.some(s.fresh ? Equal.byReference({ id: "a" }) : stable)
          )
        }))
      )

      yield* controller.commit({ fresh: false })
      yield* eventually(() => log.length === 1, "started")
      // The same reference: one lifetime, however many commits.
      yield* controller.commit({ fresh: false })
      yield* controller.commit({ fresh: false })
      yield* idle(controller)
      expect(log).toEqual(["start:a"])

      // A fresh by-reference value each commit is a different key, so it
      // replaces the lifetime — the documented consequence of opting out.
      yield* controller.commit({ fresh: true })
      yield* idle(controller)
      expect(log).toEqual(["start:a", "start:a"])
    }))

  it.live("a function implementing Equal and Hash is a structural key", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      // Effect compares functions by reference unless they say otherwise, so
      // a function that implements Equal/Hash is a perfectly good key.
      interface Rule {
        (input: string): string
        readonly name_: string
      }
      const rule = (name: string): Rule => {
        const fn = ((input: string) => `${name}:${input}`) as Rule & {
          name_: string
          [Equal.symbol]: (that: unknown) => boolean
          [Hash.symbol]: () => number
        }
        fn.name_ = name
        fn[Equal.symbol] = (that) =>
          typeof that === "function" && (that as Rule).name_ === name
        fn[Hash.symbol] = () => Hash.string(name)
        return fn
      }

      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
          start: (k: Rule) => Effect.sync(() => log.push(`start:${k.name_}`))
        })
      }))
      const controller = yield* Reconciler.make(
        Def.bind<{ readonly rule: string }>((bind) => ({
          res: bind.one(Def.Res, (s) => Option.some(rule(s.rule)))
        }))
      )

      yield* controller.commit({ rule: "strict" })
      yield* eventually(() => log.includes("start:strict"), "started")
      // A different function instance with the same identity: retained.
      yield* controller.commit({ rule: "strict" })
      yield* idle(controller)
      expect(log).toEqual(["start:strict"])
      // A different identity: replaced.
      yield* controller.commit({ rule: "lax" })
      yield* eventually(() => log.includes("start:lax"), "replaced")
    }))

  it.live("numeric keys follow Effect equality: 0 and -0 are one lifetime", () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const Def = Reconciler.define((define) => ({
        Res: define.one("Res", {
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

      // `Equal.equals(0, -0)` is true, so this is the same semantic key and
      // the lifetime is retained. Semantic identity is Effect's, not ours.
      expect(Equal.equals(0, -0)).toBe(true)
      yield* controller.commit({ key: -0 })
      yield* idle(controller)
      expect(log).toEqual(["start:0"])

      // A genuinely different number replaces it.
      yield* controller.commit({ key: 1 })
      yield* eventually(() => log.includes("start:1"), "1 replaced 0")
    }))
})
