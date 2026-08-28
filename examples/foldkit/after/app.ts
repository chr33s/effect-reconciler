/**
 * Workspace diagnostics, coordinated by the reconciler.
 *
 * The feature is the same one `../before/app.ts` implements: a language server
 * per workspace and language, a diagnostics stream that belongs to that
 * connection, and a per-document analyzer that depends on both the connection
 * and the current settings.
 *
 * What changed is who owns the lifetime rules. The Model carries domain state
 * only, `update` is pure domain transitions with no Commands, and the whole
 * ownership and capability story is stated once as a Definition. Lines marked
 * `@integration` are the cost of using the reconciler at all.
 */
import { Context, Effect, Option, PubSub, Schema as S, Stream } from "effect"
import { Message as FoldkitMessage } from "foldkit"
import type { Update } from "foldkit"
import * as Key from "../../../src/Key.js"
import * as Reconciler from "../../../src/Reconciler.js"
import { Backend, type BackendApi, type Diagnostic, type ServerHandle } from "../backend.js"
import * as Driver from "../driver.js"

// -----------------------------------------------------------------------------
// Model
// -----------------------------------------------------------------------------

export interface Model {
  readonly user: Option.Option<string>
  readonly workspace: Option.Option<string>
  readonly language: string
  readonly settingsRevision: number
  readonly openDocuments: ReadonlyArray<string>
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly serverUnavailable: boolean
}

export const init: Model = {
  user: Option.none(),
  workspace: Option.none(),
  language: "typescript",
  settingsRevision: 1,
  openDocuments: [],
  diagnostics: [],
  serverUnavailable: false
}

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

export const Message = FoldkitMessage.defineMessageUnion({
  SignedIn: { user: S.String },
  SignedOut: {},
  OpenedWorkspace: { workspace: S.String },
  ClosedWorkspace: {},
  ChangedLanguage: { language: S.String },
  ChangedSettings: { revision: S.Finite },
  OpenedDocument: { uri: S.String },
  ClosedDocument: { uri: S.String },
  ReceivedDiagnostic: { uri: S.String, message: S.String },
  PressedRetry: {},
  /** @integration A lifetime the Model asked for could not start. */
  LifetimeFailed: { family: S.String },
  /** @integration The runtime was asked to retry the failed connection. */
  RetryStarted: {}
})
export type Message = typeof Message.Type

/**
 * @integration The one effectful thing this application asks the runtime to
 * do beyond committing: retry the failed connection under the key the Model
 * already describes.
 */
export interface Retry {
  readonly server: (model: Model) => Update.Commands<Message>
}

export const makeUpdate = (retry: Retry) =>
(model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    SignedIn: ({ user }) => ({ model: { ...model, user: Option.some(user) } }),
    SignedOut: () => ({
      model: { ...model, user: Option.none(), workspace: Option.none() }
    }),
    OpenedWorkspace: ({ workspace }) => ({
      model: { ...model, workspace: Option.some(workspace) }
    }),
    ClosedWorkspace: () => ({ model: { ...model, workspace: Option.none() } }),
    ChangedLanguage: ({ language }) => ({
      model: { ...model, language, serverUnavailable: false }
    }),
    ChangedSettings: ({ revision }) => ({ model: { ...model, settingsRevision: revision } }),
    OpenedDocument: ({ uri }) => ({
      model: {
        ...model,
        openDocuments: model.openDocuments.includes(uri)
          ? model.openDocuments
          : [...model.openDocuments, uri]
      }
    }),
    ClosedDocument: ({ uri }) => ({
      model: {
        ...model,
        openDocuments: model.openDocuments.filter((open) => open !== uri),
        diagnostics: model.diagnostics.filter((diagnostic) => diagnostic.uri !== uri)
      }
    }),
    ReceivedDiagnostic: ({ uri, message: text }) => ({
      model: { ...model, diagnostics: [...model.diagnostics, { uri, message: text }] }
    }),
    LifetimeFailed: ({ family }) => ({
      model: { ...model, serverUnavailable: family === "Server" }
    }),
    // The user asks for another attempt: no nonce, no withdrawn desire, no
    // change to the Model's description of what should exist.
    PressedRetry: () => ({ model, commands: retry.server(model) }),
    RetryStarted: () => ({ model: { ...model, serverUnavailable: false } })
  })

// -----------------------------------------------------------------------------
// Lifetimes
// -----------------------------------------------------------------------------

// @coordination-begin
class SettingsService extends Context.Service<SettingsService, {
  readonly revision: number
}>()("example/Settings") {}

class ServerService extends Context.Service<ServerService, {
  readonly handle: ServerHandle
}>()("example/Server") {}

/** @integration Lets a lifetime push Messages back into the update loop, the
 * way a Subscription does. Required from the root environment. */
class Dispatch extends Context.Service<Dispatch, {
  readonly send: (message: Message) => Effect.Effect<void>
}>()("example/Dispatch") {}

export const Editor = Reconciler.define((define) => {
  const Settings = define.one("Settings", {
    key: Key.number,
    start: (revision: number) => Effect.succeed(Context.make(SettingsService, { revision }))
  })

  const Session = define.one("Session", {
    key: Key.string,
    start: () => Effect.void
  })

  const Workspace = define.one("Workspace", {
    key: Key.string,
    owner: Session,
    start: () => Effect.void
  })

  const Server = define.one("Server", {
    key: Key.string, // the language
    owner: Workspace,
    start: (language: string) =>
      Effect.gen(function* () {
        const backend = yield* Backend
        const dispatch = yield* Dispatch
        const handle = yield* Effect.acquireRelease(backend.openServer(language), (open) =>
          backend.closeServer(open)
        )
        // The diagnostics stream is part of the connection's lifetime: it
        // starts with it and is interrupted when it closes.
        yield* Effect.forkScoped(
          Stream.runForEach(Stream.fromPubSub(backend.diagnostics), (diagnostic) =>
            dispatch.send(
              Message.ReceivedDiagnostic({ uri: diagnostic.uri, message: diagnostic.message })
            )
          )
        )
        return Context.make(ServerService, { handle })
      })
  })

  const Analyzer = define.many("Analyzer", {
    key: Key.string, // the document uri
    owner: Server,
    requires: { settings: Settings },
    start: (uri: string) =>
      Effect.gen(function* () {
        const backend = yield* Backend
        const server = yield* ServerService
        const settings = yield* SettingsService
        yield* Effect.acquireRelease(
          backend.startAnalyzer(server.handle, uri, settings.revision),
          (analyzer) => backend.stopAnalyzer(analyzer)
        )
      })
  })

  return { Settings, Session, Workspace, Server, Analyzer }
})

export const binding = Editor.bind<Model>((bind) => ({
  settings: bind.one(Editor.Settings, (model) => Option.some(model.settingsRevision)),
  session: bind.one(Editor.Session, (model) => model.user),
  workspace: bind.one(Editor.Workspace, (model) => model.workspace),
  server: bind.one(Editor.Server, (model) => Option.some(model.language)),
  analyzers: bind.many(Editor.Analyzer, (model) => model.openDocuments)
}))
// @coordination-end

// -----------------------------------------------------------------------------
// Integration
// -----------------------------------------------------------------------------

// @integration-begin
export const start = (backend: BackendApi) =>
  Effect.gen(function* () {
    let dispatch: (message: Message) => Effect.Effect<void> = () => Effect.void
    const controller = yield* Reconciler.make(binding).pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(Dispatch, {
        send: (message) => Effect.suspend(() => dispatch(message))
      }),
      // A malformed Definition or Binding is a programming error, not a
      // runtime condition the application can act on.
      Effect.orDie
    )
    // The semantic reference of the connection the Model currently describes.
    // Pure: it names a lifetime, it does not reach into the runtime.
    const serverRef = (model: Model) =>
      Option.flatMap(model.user, (user) =>
        Option.map(model.workspace, (workspace) =>
          Reconciler.ref(
            Editor.Server,
            model.language,
            Reconciler.ref(Editor.Workspace, workspace, Reconciler.ref(Editor.Session, user, null))
          )
        )
      )

    const session = yield* Driver.start<Model, Message, never>({
      init,
      update: makeUpdate({
        server: (model) =>
          Option.match(serverRef(model), {
            onNone: () => [],
            onSome: (ref) => [
              {
                name: "RetryServer",
                effect: Effect.as(controller.retry(ref), Message.RetryStarted()).pipe(
                  Effect.orElseSucceed(() => Message.RetryStarted())
                )
              }
            ]
          })
      }),
      onCommitted: (model) => Effect.ignore(controller.commit(model))
    })
    dispatch = session.dispatch

    const failures = yield* controller.failures
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(PubSub.take(failures), (failure) =>
          session.dispatch(Message.LifetimeFailed({ family: failure.lifetime.family.name }))
        )
      )
    )

    return session
  })
// @integration-end
