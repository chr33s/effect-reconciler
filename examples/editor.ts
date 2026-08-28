/**
 * The editor topology from the specification (§11, §85, §86): one Definition,
 * bound to two different control-state types.
 */
import { Context, Effect, Option } from "effect"
import * as Reconciler from "../src/Reconciler.js"
import * as Replacement from "../src/Replacement.js"

class SettingsService extends Context.Service<
  SettingsService,
  { readonly revision: number }
>()("example/Settings") {}

class SessionService extends Context.Service<
  SessionService,
  { readonly userId: string }
>()("example/Session") {}

class LanguageService extends Context.Service<
  LanguageService,
  { readonly language: string }
>()("example/Language") {}

class DocumentService extends Context.Service<
  DocumentService,
  { readonly uri: string }
>()("example/Document") {}

export const Editor = Reconciler.define((define) => {
  const Settings = define.one("Settings", {
    start: (settingsRevision: number) =>
      Effect.succeed(Context.make(SettingsService, { revision: settingsRevision }))
  })

  const Session = define.one("Session", {
    replacement: Replacement.overlap(),
    start: (userId: string) => Effect.succeed(Context.make(SessionService, { userId }))
  })

  const Workspace = define.one("Workspace", {
    owner: Session,
    replacement: Replacement.sequential(),
    start: (workspaceId: string) =>
      Effect.gen(function* () {
        const session = yield* SessionService
        yield* Effect.log(`workspace ${workspaceId} opened for ${session.userId}`)
        yield* Effect.addFinalizer(() => Effect.log(`workspace ${workspaceId} closed`))
      })
  })

  const Language = define.one("Language", {
    owner: Workspace,
    start: (language: string) => Effect.succeed(Context.make(LanguageService, { language }))
  })

  const Document = define.many("Document", {
    owner: Workspace,
    start: (uri: string) => Effect.succeed(Context.make(DocumentService, { uri }))
  })

  const Diagnostics = define.one("Diagnostics", {
    owner: Document,
    requires: { settings: Settings, language: Language },
    start: (_: null) =>
      Effect.gen(function* () {
        // Ordinary Effect code: required capabilities are ordinary services.
        const settings = yield* SettingsService
        const language = yield* LanguageService
        const document = yield* DocumentService
        yield* Effect.log(
          `diagnostics for ${document.uri} (settings ${settings.revision}, ${language.language})`
        )
      })
  })

  return { Settings, Session, Workspace, Language, Document, Diagnostics }
})

// --- Foldkit-style Model binding (§85) ---------------------------------------

interface Model {
  readonly session: Option.Option<{ readonly userId: string }>
  readonly workspaceId: Option.Option<string>
  readonly language: string
  readonly settingsRevision: number
  readonly openDocuments: ReadonlyArray<string>
}

export const FoldkitEditor = Editor.bind<Model>((bind) => ({
  settings: bind.one(Editor.Settings, (model) => Option.some(model.settingsRevision)),
  session: bind.one(Editor.Session, (model) =>
    model.session.pipe(Option.map((session) => session.userId))
  ),
  workspace: bind.one(Editor.Workspace, (model) => model.workspaceId),
  language: bind.one(Editor.Language, (model) => Option.some(model.language)),
  documents: bind.many(Editor.Document, (model) => model.openDocuments),
  diagnostics: bind.one(Editor.Diagnostics, () => Option.some(null))
}))

// --- Same Definition, different control plane (§86) --------------------------

interface DaemonConfig {
  readonly account: Option.Option<string>
  readonly project: Option.Option<string>
  readonly parser: string
  readonly settingsEpoch: number
  readonly files: ReadonlyArray<string>
}

export const DaemonEditor = Editor.bind<DaemonConfig>((bind) => ({
  settings: bind.one(Editor.Settings, (config) => Option.some(config.settingsEpoch)),
  session: bind.one(Editor.Session, (config) => config.account),
  workspace: bind.one(Editor.Workspace, (config) => config.project),
  language: bind.one(Editor.Language, (config) => Option.some(config.parser)),
  documents: bind.many(Editor.Document, (config) => config.files),
  diagnostics: bind.one(Editor.Diagnostics, () => Option.some(null))
}))

// --- Running it --------------------------------------------------------------

export const main = Effect.scoped(
  Effect.gen(function* () {
    const controller = yield* Reconciler.make(FoldkitEditor)

    // After every committed Model transition:
    yield* controller.commit({
      session: Option.some({ userId: "alice" }),
      workspaceId: Option.some("acme"),
      language: "typescript",
      settingsRevision: 1,
      openDocuments: ["file:///a.ts", "file:///b.ts"]
    })

    yield* Effect.sleep(100)
    yield* controller.shutdown
  })
)
