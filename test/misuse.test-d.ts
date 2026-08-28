/**
 * Phase 1 type-misuse checks. This file is compiled by `tsc --noEmit`; every
 * `@ts-expect-error` line asserts that the API rejects the misuse statically.
 */
import { Context, Data, Effect, Option } from "effect"
import type { LifetimeRef } from "../src/LifetimeRef.js"
import * as Reconciler from "../src/Reconciler.js"

const Def = Reconciler.define((define) => {
  const Session = define.one("Session", {
    start: (userId: string) => Effect.succeed(userId)
  })
  const Workspace = define.one("Workspace", {
    owner: Session,
    start: (workspaceId: string) => Effect.succeed(workspaceId)
  })
  const Document = define.many("Document", {
    owner: Workspace,
    start: (uri: string) => Effect.succeed(uri)
  })
  return { Session, Workspace, Document }
})

interface State {
  readonly user: Option.Option<string>
  readonly revision: number
  readonly documents: ReadonlyArray<string>
}

// Valid usage compiles.
Def.bind<State>((bind) => ({
  session: bind.one(Def.Session, (s) => s.user),
  workspace: bind.one(Def.Workspace, (_s, owner) => Option.some(owner.key)),
  documents: bind.many(Def.Document, (s) => s.documents)
}))

Def.bind<State>((bind) => ({
  // @ts-expect-error — wrong key type: Session keys are strings, not numbers
  session: bind.one(Def.Session, (s) => Option.some(s.revision))
}))

Def.bind<State>((bind) => ({
  // @ts-expect-error — one/many mismatch: Document is a many definition
  documents: bind.one(Def.Document, (s) => s.user)
}))

Def.bind<State>((bind) => ({
  // @ts-expect-error — one/many mismatch: Session is a one definition
  session: bind.many(Def.Session, (s) => s.documents)
}))

Def.bind<State>((bind) => ({
  // @ts-expect-error — wrong owner family: Workspace is owned by Session
  workspace: bind.one(Def.Workspace, (_s, owner: LifetimeRef<typeof Def.Document>) =>
    Option.some(owner.key)
  )
}))

// The owner reference is the whole semantic path, statically typed: a Document
// sees its Workspace, that Workspace's Session, and the root beyond it.
Def.bind<State>((bind) => ({
  documents: bind.many(Def.Document, (s, owner) => {
    const workspaceId: string = owner.key
    const userId: string = owner.parent.key
    const root: null = owner.parent.parent
    return root === null ? s.documents : [workspaceId, userId]
  })
}))

Def.bind<State>((bind) => ({
  // @ts-expect-error — a root family's selector has no owner to inspect
  session: bind.one(Def.Session, (_s, owner) => Option.some(owner.key))
}))

Reconciler.define((define) => {
  const Session = define.one("Session", {
    start: (userId: string) => Effect.succeed(userId)
  })
  const Bad = define.one("Bad", {
    owner: Session,
    // The key parameter must be annotated, so a wrong annotation is what a
    // mistake looks like now: the Binding below cannot supply a number.
    start: (key: number) => Effect.succeed(Math.abs(key))
  })
  return { Session, Bad }
})

// An un-inferable key type is rejected where the handle is used, rather than
// silently widening to `unknown` and letting the Binding desire anything.
const Unannotated = Reconciler.define((define) => ({
  // @ts-expect-error — `start` ignores its key, so the key type is unknown
  Res: define.one("Res", { start: () => Effect.void })
}))

// -----------------------------------------------------------------------------
// Startup environments (§6.2, §6.3)
// -----------------------------------------------------------------------------

class SettingsService extends Context.Service<
  SettingsService,
  { readonly revision: number }
>()("misuse/Settings") {}

class SessionService extends Context.Service<
  SessionService,
  { readonly userId: string }
>()("misuse/Session") {}

// Ancestor-published and required-provider capabilities are in scope, so this
// Definition asks nothing of the root environment.
const Wired = Reconciler.define((define) => {
  const Settings = define.one("Settings", {
    start: (revision: number) => Effect.succeed(Context.make(SettingsService, { revision }))
  })
  const Session = define.one("Session", {
    start: (userId: string) => Effect.succeed(Context.make(SessionService, { userId }))
  })
  const Child = define.one("Child", {
    owner: Session,
    requires: { settings: Settings },
    start: (_: null) =>
      Effect.gen(function* () {
        yield* SessionService // published by the owner
        yield* SettingsService // published by a required provider
        yield* Effect.addFinalizer(() => Effect.void) // the instance Scope
      })
  })
  return { Settings, Session, Child }
})

Effect.runPromise(
  Effect.scoped(
    Reconciler.make(
      Wired.bind<{}>((bind) => ({
        settings: bind.one(Wired.Settings, () => Option.some(1)),
        session: bind.one(Wired.Session, () => Option.none()),
        child: bind.one(Wired.Child, () => Option.none())
      }))
    )
  )
)

// A capability that is neither published by an ancestor nor named in
// `requires` is a root-environment requirement of the Controller (§6.2).
const Unmet = Reconciler.define((define) => {
  const Settings = define.one("Settings", {
    start: (revision: number) => Effect.succeed(Context.make(SettingsService, { revision }))
  })
  const Loose = define.one("Loose", {
    // No `owner`, no `requires`: Settings is a sibling, not a provider.
    start: (_: null) => Effect.service(SettingsService)
  })
  return { Settings, Loose }
})

const UnmetBound = Unmet.bind<{}>((bind) => ({
  settings: bind.one(Unmet.Settings, () => Option.some(1)),
  loose: bind.one(Unmet.Loose, () => Option.none())
}))

// The missing service is the point of the assertions below, so the Effect
// language service's own check for it is disabled from here on.
// @effect-diagnostics missingEffectContext:off

// @ts-expect-error — SettingsService is required by a startup Effect but never provided
Effect.runPromise(Effect.scoped(Reconciler.make(UnmetBound)))

// Providing it as a root service satisfies the Controller.
Effect.runPromise(
  Effect.scoped(
    Reconciler.make(UnmetBound).pipe(
      Effect.provideService(SettingsService, { revision: 1 })
    )
  )
)

// -----------------------------------------------------------------------------
// Key inference (§3.2)
// -----------------------------------------------------------------------------

class WorkspaceKey extends Data.Class<{
  readonly organizationId: string
  readonly workspaceId: string
}> {}

const Keyed = Reconciler.define((define) => {
  // The semantic key type is inferred from `start`; no key descriptor exists.
  const Primitive = define.one("Primitive", { start: (revision: number) => Effect.void })
  const Structural = define.many("Structural", {
    start: (key: WorkspaceKey) => Effect.succeed(key.workspaceId)
  })
  const Singleton = define.one("Singleton", { start: (_: null) => Effect.void })
  return { Primitive, Structural, Singleton }
})

interface KeyedState {
  readonly revision: number
  readonly workspaces: ReadonlyArray<WorkspaceKey>
}

// Primitive and Effect data keys both bind without ceremony.
Keyed.bind<KeyedState>((bind) => ({
  primitive: bind.one(Keyed.Primitive, (s) => Option.some(s.revision)),
  structural: bind.many(Keyed.Structural, (s) => s.workspaces),
  singleton: bind.one(Keyed.Singleton, () => Option.some(null))
}))

Keyed.bind<KeyedState>((bind) => ({
  // @ts-expect-error — the key is a number, not a string
  primitive: bind.one(Keyed.Primitive, () => Option.some("1"))
}))

Keyed.bind<KeyedState>((bind) => ({
  // @ts-expect-error — a bare object is not the declared data key
  structural: bind.many(Keyed.Structural, () => [{ organizationId: "a", workspaceId: "b" }])
}))

// A semantic reference is typed by the family it names.
Reconciler.ref(Keyed.Structural, new WorkspaceKey({ organizationId: "a", workspaceId: "b" }), null)

// @ts-expect-error — wrong key type for this family
Reconciler.ref(Keyed.Primitive, "1", null)
