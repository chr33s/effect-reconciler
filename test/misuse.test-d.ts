/**
 * Phase 1 type-misuse checks. This file is compiled by `tsc --noEmit`; every
 * `@ts-expect-error` line asserts that the API rejects the misuse statically.
 */
import { Context, Effect, Option } from "effect"
import * as Key from "../src/Key.js"
import * as Reconciler from "../src/Reconciler.js"

const Def = Reconciler.define((define) => {
  const Session = define.one("Session", {
    key: Key.string,
    start: (userId: string) => Effect.succeed(userId)
  })
  const Workspace = define.one("Workspace", {
    key: Key.string,
    owner: Session,
    start: (workspaceId: string) => Effect.succeed(workspaceId)
  })
  const Document = define.many("Document", {
    key: Key.string,
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
  workspace: bind.one(Def.Workspace, (_s, userId: string) => Option.some(userId)),
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
  // @ts-expect-error — wrong owner key type: Workspace's owner key is a string
  workspace: bind.one(Def.Workspace, (_s, ownerKey: number) => Option.some("acme"))
}))

Reconciler.define((define) => {
  const Session = define.one("Session", {
    key: Key.string,
    start: (userId: string) => Effect.succeed(userId)
  })
  const Bad = define.one("Bad", {
    key: Key.string,
    owner: Session,
    // @ts-expect-error — the start key is a string, not a number
    start: (key) => Effect.succeed(Math.abs(key))
  })
  return { Session, Bad }
})

// -----------------------------------------------------------------------------
// Startup environments (§28, §29, §60)
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
    key: Key.number,
    start: (revision: number) => Effect.succeed(Context.make(SettingsService, { revision }))
  })
  const Session = define.one("Session", {
    key: Key.string,
    start: (userId: string) => Effect.succeed(Context.make(SessionService, { userId }))
  })
  const Child = define.one("Child", {
    key: Key.null,
    owner: Session,
    requires: { settings: Settings },
    start: () =>
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
// `requires` is a root-environment requirement of the Controller (§60).
const Unmet = Reconciler.define((define) => {
  const Settings = define.one("Settings", {
    key: Key.number,
    start: (revision: number) => Effect.succeed(Context.make(SettingsService, { revision }))
  })
  const Loose = define.one("Loose", {
    key: Key.null,
    // No `owner`, no `requires`: Settings is a sibling, not a provider.
    start: () => Effect.service(SettingsService)
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
