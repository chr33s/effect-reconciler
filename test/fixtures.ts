import { Context, Effect, Option } from "effect"
import * as Reconciler from "../src/Reconciler.js"

export class SettingsService extends Context.Service<
  SettingsService,
  { readonly revision: number }
>()("test/SettingsService") {}

export class SessionService extends Context.Service<
  SessionService,
  { readonly userId: string }
>()("test/SessionService") {}

export class WorkspaceService extends Context.Service<
  WorkspaceService,
  { readonly workspaceId: string }
>()("test/WorkspaceService") {}

export class LanguageService extends Context.Service<
  LanguageService,
  { readonly language: string }
>()("test/LanguageService") {}

export class DocumentService extends Context.Service<
  DocumentService,
  { readonly uri: string }
>()("test/DocumentService") {}

export interface Model {
  readonly settingsRevision: Option.Option<number>
  readonly user: Option.Option<string>
  readonly workspaceId: Option.Option<string>
  readonly language: Option.Option<string>
  readonly documents: ReadonlyArray<string>
  readonly diagnostics: boolean
}

export const model = (partial: Partial<Model> = {}): Model => ({
  settingsRevision: Option.some(1),
  user: Option.none(),
  workspaceId: Option.none(),
  language: Option.none(),
  documents: [],
  diagnostics: false,
  ...partial
})

/**
 * The spec's editor topology:
 *
 *   Application
 *   ├── Settings
 *   └── Session
 *       └── Workspace
 *           ├── Language
 *           └── Document × N
 *               └── Diagnostics  (requires Settings + Language)
 */
export const makeEditor = (log: Array<string>) => {
  const record = (entry: string) =>
    Effect.gen(function* () {
      log.push(`start:${entry}`)
      yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`stop:${entry}`)))
    })

  return Reconciler.define((define) => {
    const Settings = define.one("Settings", {
      start: (revision: number) =>
        Effect.gen(function* () {
          yield* record(`settings:${revision}`)
          return Context.make(SettingsService, { revision })
        })
    })

    const Session = define.one("Session", {
      start: (userId: string) =>
        Effect.gen(function* () {
          yield* record(`session:${userId}`)
          return Context.make(SessionService, { userId })
        })
    })

    const Workspace = define.one("Workspace", {
      owner: Session,
      start: (workspaceId: string) =>
        Effect.gen(function* () {
          const session = yield* SessionService
          yield* record(`workspace:${workspaceId}@${session.userId}`)
          return Context.make(WorkspaceService, { workspaceId })
        })
    })

    const Language = define.one("Language", {
      owner: Workspace,
      start: (language: string) =>
        Effect.gen(function* () {
          yield* record(`language:${language}`)
          return Context.make(LanguageService, { language })
        })
    })

    const Document = define.many("Document", {
      owner: Workspace,
      start: (uri: string) =>
        Effect.gen(function* () {
          yield* record(`document:${uri}`)
          return Context.make(DocumentService, { uri })
        })
    })

    const Diagnostics = define.one("Diagnostics", {
      owner: Document,
      requires: { settings: Settings, language: Language },
      start: (_: null) =>
        Effect.gen(function* () {
          const settings = yield* SettingsService
          const language = yield* LanguageService
          const document = yield* DocumentService
          yield* record(`diagnostics:${document.uri}:s${settings.revision}:${language.language}`)
        })
    })

    return { Settings, Session, Workspace, Language, Document, Diagnostics }
  })
}

export const bindEditor = (editor: ReturnType<typeof makeEditor>) =>
  editor.bind<Model>((bind) => ({
    settings: bind.one(editor.Settings, (m) => m.settingsRevision),
    session: bind.one(editor.Session, (m) => m.user),
    workspace: bind.one(editor.Workspace, (m) => m.workspaceId),
    language: bind.one(editor.Language, (m) => m.language),
    documents: bind.many(editor.Document, (m) => m.documents),
    diagnostics: bind.one(editor.Diagnostics, (m) =>
      m.diagnostics ? Option.some(null) : Option.none()
    )
  }))
