/**
 * Workspace diagnostics, coordinated by the application.
 *
 * This is the "before" side of the Phase 4/5 comparison: an idiomatic Foldkit
 * feature that owns its own lifecycle rules. The language server is a Managed
 * Resource, its diagnostics are a Subscription, and the per-document analyzers
 * — which Managed Resources cannot express, being single-instance — are
 * supervised by hand from `update` through Commands.
 *
 * Lines that exist only because lifetimes have to be coordinated are marked
 * `@lifecycle`. `metrics.ts` counts them; they are what the reconciler is
 * supposed to delete.
 */
import { Effect, Option, Schema as S, Stream } from "effect"
import type { Command, Update } from "foldkit"
import { ManagedResource, Message as FoldkitMessage, Subscription } from "foldkit"
import type { AnalyzerHandle, BackendApi, Diagnostic, ServerHandle } from "../backend.js"
import * as Driver from "../driver.js"

// -----------------------------------------------------------------------------
// Model
// -----------------------------------------------------------------------------

// @coordination-begin
/** @lifecycle A running analyzer, with the provider generations it captured. */
export interface RunningAnalyzer {
  readonly uri: string
  readonly handle: AnalyzerHandle
  readonly serverId: string
  readonly settingsRevision: number
}
// @coordination-end

export interface Model {
  // --- domain state ---------------------------------------------------------
  readonly user: Option.Option<string>
  readonly workspace: Option.Option<string>
  readonly language: string
  readonly settingsRevision: number
  readonly openDocuments: ReadonlyArray<string>
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly serverUnavailable: boolean

  // --- operational bookkeeping ----------------------------------------------
  /** @lifecycle */ readonly server: Option.Option<ServerHandle>
  /** @lifecycle */ readonly analyzers: ReadonlyArray<RunningAnalyzer>
  /** @lifecycle */ readonly analyzersStarting: ReadonlyArray<string>
  /** @lifecycle */ readonly analyzersStopping: ReadonlyArray<string>
  /**
   * @lifecycle The retry nonce. A Managed Resource only re-acquires when its
   * requirements change, so "try again with the same server" has to be
   * expressed as a change in operational identity — inside the requirements
   * that describe *which* server is wanted.
   */
  readonly serverAttempt: number
}

export const init: Model = {
  user: Option.none(),
  workspace: Option.none(),
  language: "typescript",
  settingsRevision: 1,
  openDocuments: [],
  diagnostics: [],
  serverUnavailable: false,
  server: Option.none(),
  analyzers: [],
  analyzersStarting: [],
  analyzersStopping: [],
  serverAttempt: 0
}

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

const HandleSchema = S.Struct({ id: S.String, uri: S.String })

export const Message = FoldkitMessage.defineMessageUnion({
  // --- domain facts ---------------------------------------------------------
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

  // --- lifecycle facts ------------------------------------------------------
  /** @lifecycle */ AcquiredServer: { id: S.String, language: S.String },
  /** @lifecycle */ ReleasedServer: {},
  /** @lifecycle */ FailedAcquireServer: {},
  /** @lifecycle */ StartedAnalyzer: {
    uri: S.String,
    handle: HandleSchema,
    serverId: S.String,
    settingsRevision: S.Finite
  },
  /** @lifecycle */ StoppedAnalyzer: { uri: S.String }
})
export type Message = typeof Message.Type

// -----------------------------------------------------------------------------
// The application
// -----------------------------------------------------------------------------

export const makeApp = (backend: BackendApi) => {
  type Return = Update.Return<Model, Message>

  // @coordination-begin
  /** @lifecycle */
  const startAnalyzer = (
    server: ServerHandle,
    uri: string,
    settingsRevision: number
  ): Command.Command<Message> => ({
    name: "StartAnalyzer",
    effect: Effect.map(backend.startAnalyzer(server, uri, settingsRevision), (handle) =>
      Message.StartedAnalyzer({ uri, handle, serverId: server.id, settingsRevision })
    )
  })

  /** @lifecycle */
  const stopAnalyzer = (handle: AnalyzerHandle): Command.Command<Message> => ({
    name: "StopAnalyzer",
    effect: Effect.as(backend.stopAnalyzer(handle), Message.StoppedAnalyzer({ uri: handle.uri }))
  })

  /**
   * @lifecycle The analyzer supervisor. Every message that could change which
   * analyzers should exist has to run this, and it has to re-derive the whole
   * ownership and capability story from the Model each time.
   */
  const reconcileAnalyzers = (model: Model): Return => {
    const server = Option.getOrNull(model.server)
    // @lifecycle The same predicate the Managed Resource uses, restated: an
    // analyzer may only exist while its whole owner chain is live.
    const chainAlive =
      Option.isSome(model.user) && Option.isSome(model.workspace) && server !== null
    const desired = chainAlive ? model.openDocuments : []
    const commands: Array<Command.Command<Message>> = []
    const starting = new Set(model.analyzersStarting)
    const stopping = new Set(model.analyzersStopping)

    for (const running of model.analyzers) {
      if (stopping.has(running.uri)) continue
      // @lifecycle Manual provider invalidation: an analyzer bound to a
      // superseded server generation or an old settings revision is stale.
      const stale =
        !desired.includes(running.uri) ||
        server === null ||
        running.serverId !== server.id ||
        running.settingsRevision !== model.settingsRevision
      if (stale) {
        stopping.add(running.uri)
        commands.push(stopAnalyzer(running.handle))
      }
    }

    if (server !== null) {
      for (const uri of desired) {
        // @lifecycle Sequential replacement by hand: never start a second
        // analyzer for a document while the previous one is still stopping.
        if (starting.has(uri)) continue
        if (model.analyzers.some((analyzer) => analyzer.uri === uri)) continue
        starting.add(uri)
        commands.push(startAnalyzer(server, uri, model.settingsRevision))
      }
    }

    return {
      model: {
        ...model,
        analyzersStarting: [...starting],
        analyzersStopping: [...stopping]
      },
      commands
    }
  }

  // @coordination-end

  const update = (model: Model, message: Message): Return =>
    Message.match(message, {
      // --- domain transitions, each of which has to re-run the supervisor ----
      SignedIn: ({ user }) => reconcileAnalyzers({ ...model, user: Option.some(user) }),
      SignedOut: () =>
        reconcileAnalyzers({ ...model, user: Option.none(), workspace: Option.none() }),
      OpenedWorkspace: ({ workspace }) =>
        reconcileAnalyzers({ ...model, workspace: Option.some(workspace) }),
      ClosedWorkspace: () => reconcileAnalyzers({ ...model, workspace: Option.none() }),
      ChangedLanguage: ({ language }) =>
        reconcileAnalyzers({ ...model, language, serverUnavailable: false }),
      ChangedSettings: ({ revision }) =>
        reconcileAnalyzers({ ...model, settingsRevision: revision }),
      OpenedDocument: ({ uri }) =>
        reconcileAnalyzers({
          ...model,
          openDocuments: model.openDocuments.includes(uri)
            ? model.openDocuments
            : [...model.openDocuments, uri]
        }),
      ClosedDocument: ({ uri }) =>
        reconcileAnalyzers({
          ...model,
          openDocuments: model.openDocuments.filter((open) => open !== uri),
          diagnostics: model.diagnostics.filter((diagnostic) => diagnostic.uri !== uri)
        }),
      ReceivedDiagnostic: ({ uri, message: text }) => ({
        model: { ...model, diagnostics: [...model.diagnostics, { uri, message: text }] }
      }),
      // @lifecycle Bumping the nonce is what actually forces the re-acquire.
      PressedRetry: () =>
        reconcileAnalyzers({
          ...model,
          serverUnavailable: false,
          serverAttempt: model.serverAttempt + 1
        }),

      // --- lifecycle transitions ---------------------------------------------
      // @coordination-begin
      /** @lifecycle */
      AcquiredServer: ({ id, language }) =>
        reconcileAnalyzers({
          ...model,
          server: Option.some({ id, language }),
          serverUnavailable: false
        }),
      /** @lifecycle */
      ReleasedServer: () => reconcileAnalyzers({ ...model, server: Option.none() }),
      /** @lifecycle */
      FailedAcquireServer: () =>
        reconcileAnalyzers({ ...model, server: Option.none(), serverUnavailable: true }),
      /** @lifecycle */
      StartedAnalyzer: ({ uri, handle, serverId, settingsRevision }) => {
        const starting = model.analyzersStarting.filter((open) => open !== uri)
        const server = Option.getOrNull(model.server)
        // @lifecycle A start that completed against a superseded server, an old
        // settings revision or a closed document must not become live.
        const stale =
          server === null ||
          server.id !== serverId ||
          settingsRevision !== model.settingsRevision ||
          !model.openDocuments.includes(uri)
        if (stale) {
          return {
            model: {
              ...model,
              analyzersStarting: starting,
              analyzersStopping: [...model.analyzersStopping, uri]
            },
            commands: [stopAnalyzer(handle)]
          }
        }
        return reconcileAnalyzers({
          ...model,
          analyzersStarting: starting,
          analyzers: [...model.analyzers, { uri, handle, serverId, settingsRevision }]
        })
      },
      /** @lifecycle */
      StoppedAnalyzer: ({ uri }) =>
        reconcileAnalyzers({
          ...model,
          analyzers: model.analyzers.filter((analyzer) => analyzer.uri !== uri),
          analyzersStopping: model.analyzersStopping.filter((open) => open !== uri)
        })
      // @coordination-end
    })

  // @coordination-begin
  const LanguageServer = ManagedResource.tag<ServerHandle>()("LanguageServer")

  const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
    server: entry(
      S.Option(
        S.Struct({
          user: S.String,
          workspace: S.String,
          language: S.String,
          // @lifecycle Operational identity leaking into the description of
          // which server is wanted.
          attempt: S.Finite
        })
      ),
      {
        resource: LanguageServer,
        // @lifecycle The ownership predicate, stated here as well as in the
        // supervisor above.
        modelToMaybeRequirements: (model) =>
          Option.isSome(model.user) && Option.isSome(model.workspace)
            ? Option.some({
              user: model.user.value,
              workspace: model.workspace.value,
              language: model.language,
              attempt: model.serverAttempt
            })
            : Option.none(),
        acquire: ({ language }) => backend.openServer(language),
        release: (handle) => backend.closeServer(handle),
        onAcquired: (handle) =>
          Message.AcquiredServer({ id: handle.id, language: handle.language }),
        onReleased: () => Message.ReleasedServer(),
        onAcquireError: () => Message.FailedAcquireServer()
      }
    )
  }))

  const subscriptions = Subscription.make<Model, Message>()((entry) => ({
    diagnostics: entry(
      { serverId: S.Option(S.String) },
      {
        // @lifecycle The subscription has to track the server generation too,
        // so it restarts when the connection is replaced.
        modelToDependencies: (model) => ({
          serverId: Option.map(model.server, (server) => server.id)
        }),
        dependenciesToStream: ({ serverId }) =>
          Option.isNone(serverId)
            ? Stream.empty
            : Stream.map(Stream.fromPubSub(backend.diagnostics), (diagnostic) =>
              Message.ReceivedDiagnostic({ uri: diagnostic.uri, message: diagnostic.message })
            )
      }
    )
  }))

  // @coordination-end

  return { init, update, managedResources, subscriptions } as const
}

export const start = (backend: BackendApi) =>
  Driver.start<Model, Message, never>(makeApp(backend))
