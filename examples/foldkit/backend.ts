/**
 * The editor backend both versions of the app drive.
 *
 * It stands in for a real language-server integration and gives the example
 * the traits the validation needs: an expensive connection with acquire and
 * release, a push stream of diagnostics, per-document child work that only
 * makes sense against a live connection and the current settings, and a
 * language that simply fails to start.
 *
 * Every lifecycle transition is recorded in `events`, so the two versions can
 * be compared on what they actually did to the outside world rather than on
 * how their models happen to be shaped.
 */
import { Context, Data, Deferred, Effect, PubSub } from "effect"

export interface Diagnostic {
  readonly uri: string
  readonly message: string
}

export interface ServerHandle {
  readonly id: string
  readonly language: string
}

export interface AnalyzerHandle {
  readonly id: string
  readonly uri: string
}

/** The language server for this language could not be started. */
export class LanguageServerUnavailable extends Data.TaggedError("LanguageServerUnavailable")<{
  readonly language: string
}> {}

export interface BackendApi {
  readonly openServer: (language: string) => Effect.Effect<ServerHandle, LanguageServerUnavailable>
  readonly closeServer: (handle: ServerHandle) => Effect.Effect<void>
  readonly diagnostics: PubSub.PubSub<Diagnostic>
  readonly startAnalyzer: (
    server: ServerHandle,
    uri: string,
    settingsRevision: number
  ) => Effect.Effect<AnalyzerHandle>
  readonly stopAnalyzer: (handle: AnalyzerHandle) => Effect.Effect<void>
}

/** The backend as an Effect service. The reconciler version takes it from the
 * root environment; the Foldkit version closes over it, because a Managed
 * Resource's `acquire` may only require a Scope. */
export class Backend extends Context.Service<Backend, BackendApi>()("example/Backend") {}

export interface BackendControl {
  /** Every lifecycle transition, in order. */
  readonly events: ReadonlyArray<string>
  /** Currently open server ids. */
  readonly liveServers: () => ReadonlyArray<string>
  /** Currently running analyzer ids. */
  readonly liveAnalyzers: () => ReadonlyArray<string>
  /** Make server startup block until `resumeServers` is called. */
  readonly pauseServers: Effect.Effect<void>
  readonly resumeServers: Effect.Effect<void>
  /** Make analyzer startup block until `resumeAnalyzers` is called. */
  readonly pauseAnalyzers: Effect.Effect<void>
  readonly resumeAnalyzers: Effect.Effect<void>
  /** Push a diagnostic as a real server would. */
  readonly emit: (diagnostic: Diagnostic) => Effect.Effect<void>
}

/** A language that no server supports, used to exercise startup failure. */
export const unsupportedLanguage = "cobol"

export const makeBackend = Effect.gen(function* () {
  const events: Array<string> = []
  const servers = new Set<string>()
  const analyzers = new Set<string>()
  const diagnostics = yield* PubSub.unbounded<Diagnostic>()
  let nextServer = 1
  let nextAnalyzer = 1
  let serverGate: Deferred.Deferred<void> | null = null
  let analyzerGate: Deferred.Deferred<void> | null = null

  const service: BackendApi = {
    openServer: (language) =>
      Effect.gen(function* () {
        const pending = serverGate
        if (pending !== null) yield* Deferred.await(pending)
        if (language === unsupportedLanguage) {
          events.push(`server:failed:${language}`)
          return yield* new LanguageServerUnavailable({ language })
        }
        const handle: ServerHandle = { id: `server-${nextServer++}`, language }
        servers.add(handle.id)
        events.push(`server:open:${handle.id}:${language}`)
        return handle
      }),
    closeServer: (handle) =>
      Effect.sync(() => {
        servers.delete(handle.id)
        events.push(`server:close:${handle.id}`)
      }),
    diagnostics,
    startAnalyzer: (server, uri, settingsRevision) =>
      Effect.gen(function* () {
        const pending = analyzerGate
        if (pending !== null) yield* Deferred.await(pending)
        const handle: AnalyzerHandle = { id: `analyzer-${nextAnalyzer++}`, uri }
        analyzers.add(handle.id)
        events.push(`analyzer:start:${uri}@${server.id}:rev${settingsRevision}`)
        return handle
      }),
    stopAnalyzer: (handle) =>
      Effect.sync(() => {
        analyzers.delete(handle.id)
        events.push(`analyzer:stop:${handle.uri}`)
      })
  }

  const control: BackendControl = {
    events,
    liveServers: () => [...servers],
    liveAnalyzers: () => [...analyzers],
    pauseServers: Effect.gen(function* () {
      serverGate = yield* Deferred.make<void>()
    }),
    resumeServers: Effect.gen(function* () {
      const pending = serverGate
      serverGate = null
      if (pending !== null) yield* Deferred.succeed(pending, void 0)
    }),
    pauseAnalyzers: Effect.gen(function* () {
      analyzerGate = yield* Deferred.make<void>()
    }),
    resumeAnalyzers: Effect.gen(function* () {
      const pending = analyzerGate
      analyzerGate = null
      if (pending !== null) yield* Deferred.succeed(pending, void 0)
    }),
    emit: (diagnostic) => Effect.asVoid(PubSub.publish(diagnostics, diagnostic))
  }

  return { service, control } as const
})
