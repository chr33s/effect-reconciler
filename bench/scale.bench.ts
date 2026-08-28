/**
 * Scale behaviour of the reconciler, measured before any incremental
 * optimization exists (spec plan §71–73, docs/spec.1.md Phase 6).
 *
 * The topology is the editor from the specification, so a commit touches a
 * capability DAG rather than a flat resource list:
 *
 *   Settings ─────────────────┐ (capability)
 *   Session                   │
 *   └── Workspace             │
 *       ├── Language ─────────┤ (capability)
 *       └── Document × N      │
 *           └── Diagnostics ◀─┘
 *
 * Every scenario reports commit latency (how long the mutation boundary
 * blocks), convergence time (how long the runtime then takes to reach the new
 * desire), how many selector evaluations that cost, and the lifecycle churn it
 * produced. Churn is the number that matters: work the runtime avoids is work
 * an application would otherwise have coordinated by hand.
 */
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Option } from "effect"
import * as Reconciler from "../src/Reconciler.js"
import { idle } from "../test/util.js"

class SettingsService extends Context.Service<
  SettingsService,
  { readonly revision: number }
>()("bench/Settings") {}

class LanguageService extends Context.Service<
  LanguageService,
  { readonly language: string }
>()("bench/Language") {}

class DocumentService extends Context.Service<
  DocumentService,
  { readonly uri: string }
>()("bench/Document") {}

interface Model {
  readonly settingsRevision: number
  readonly user: string
  readonly workspaceId: string
  readonly language: string
  readonly documents: ReadonlyArray<string>
}

interface Counters {
  starts: number
  stops: number
  selectors: number
}

const makeEditor = (counters: Counters) => {
  const started = <A>(value: A) =>
    Effect.gen(function* () {
      counters.starts++
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          counters.stops++
        })
      )
      return value
    })

  return Reconciler.define((define) => {
    const Settings = define.one("Settings", {
      start: (revision: number) => started(Context.make(SettingsService, { revision }))
    })
    const Session = define.one("Session", {
      start: () => started(undefined)
    })
    const Workspace = define.one("Workspace", {
      owner: Session,
      start: () => started(undefined)
    })
    const Language = define.one("Language", {
      owner: Workspace,
      start: (language: string) => started(Context.make(LanguageService, { language }))
    })
    const Document = define.many("Document", {
      owner: Workspace,
      start: (uri: string) => started(Context.make(DocumentService, { uri }))
    })
    const Diagnostics = define.one("Diagnostics", {
      owner: Document,
      requires: { settings: Settings, language: Language },
      start: () =>
        Effect.gen(function* () {
          // Ordinary capability access, as a real dependent would.
          yield* SettingsService
          yield* LanguageService
          yield* DocumentService
          return yield* started(undefined)
        })
    })
    return { Settings, Session, Workspace, Language, Document, Diagnostics }
  })
}

const bindEditor = (editor: ReturnType<typeof makeEditor>, counters: Counters) =>
  editor.bind<Model>((bind) => ({
    settings: bind.one(editor.Settings, (m) => {
      counters.selectors++
      return Option.some(m.settingsRevision)
    }),
    session: bind.one(editor.Session, (m) => {
      counters.selectors++
      return Option.some(m.user)
    }),
    workspace: bind.one(editor.Workspace, (m) => {
      counters.selectors++
      return Option.some(m.workspaceId)
    }),
    language: bind.one(editor.Language, (m) => {
      counters.selectors++
      return Option.some(m.language)
    }),
    documents: bind.many(editor.Document, (m) => {
      counters.selectors++
      return m.documents
    }),
    diagnostics: bind.one(editor.Diagnostics, () => {
      counters.selectors++
      return Option.some(null)
    })
  }))

interface Row {
  readonly documents: number
  readonly scenario: string
  readonly commitMs: number
  readonly convergeMs: number
  readonly selectors: number
  readonly starts: number
  readonly stops: number
}

const rows: Array<Row> = []

const report = () => {
  const header = "| documents | scenario | commit ms | converge ms | selector evals | starts | stops |"
  const divider = "| ---: | :--- | ---: | ---: | ---: | ---: | ---: |"
  const body = rows.map((r) =>
    `| ${r.documents} | ${r.scenario} | ${r.commitMs.toFixed(2)} | ${
      r.convergeMs.toFixed(2)
    } | ${r.selectors} | ${r.starts} | ${r.stops} |`
  )
  console.log(["", header, divider, ...body, ""].join("\n"))
}

const sizes = [100, 1_000, 10_000]

describe("scale", () => {
  for (const size of sizes) {
    it.live(
      `${size} documents`,
      () =>
        Effect.gen(function* () {
          const counters: Counters = { starts: 0, stops: 0, selectors: 0 }
          const editor = makeEditor(counters)
          const controller = yield* Reconciler.make(bindEditor(editor, counters))

          const documents = Array.from({ length: size }, (_, i) => `file:///doc-${i}.ts`)
          const baseline: Model = {
            settingsRevision: 1,
            user: "alice",
            workspaceId: "acme",
            language: "typescript",
            documents
          }

          /** One measured commit: latency, then convergence. */
          const measure = function* (scenario: string, model: Model) {
            counters.starts = 0
            counters.stops = 0
            counters.selectors = 0
            const t0 = performance.now()
            yield* controller.commit(model)
            const t1 = performance.now()
            yield* idle(controller)
            const t2 = performance.now()
            const row: Row = {
              documents: size,
              scenario,
              commitMs: t1 - t0,
              convergeMs: t2 - t1,
              selectors: counters.selectors,
              starts: counters.starts,
              stops: counters.stops
            }
            rows.push(row)
            return row
          }

          // Cold build: Settings, Session, Workspace, Language, and a
          // Document + Diagnostics pair per document.
          const build = yield* measure("build", baseline)
          expect(build.starts).toBe(2 * size + 4)
          expect(build.stops).toBe(0)

          // A — equivalent commit: churn must stay at exactly zero.
          const equivalent = yield* measure("A equivalent commit", { ...baseline })
          expect(equivalent.starts).toBe(0)
          expect(equivalent.stops).toBe(0)

          // B — one Document removed, one added: only that document and its
          // Diagnostics child move, whatever the scale.
          const churned = [...documents.slice(1), "file:///added.ts"]
          const oneChanged = yield* measure("B one document changed", {
            ...baseline,
            documents: churned
          })
          expect(oneChanged.starts).toBe(2)
          expect(oneChanged.stops).toBe(2)
          const afterB: Model = { ...baseline, documents: churned }

          // C — Settings replaced: every Diagnostics is rebound to the new
          // provider generation, and every Document is retained.
          const settings = yield* measure("C settings replaced", {
            ...afterB,
            settingsRevision: 2
          })
          expect(settings.starts).toBe(size + 1)
          expect(settings.stops).toBe(size + 1)
          const afterC: Model = { ...afterB, settingsRevision: 2 }

          // D — Language replaced: the same selective invalidation.
          const language = yield* measure("D language replaced", { ...afterC, language: "tsx" })
          expect(language.starts).toBe(size + 1)
          expect(language.stops).toBe(size + 1)
          const afterD: Model = { ...afterC, language: "tsx" }

          // E — Workspace replaced: the whole owned subtree, worst case.
          const workspace = yield* measure("E workspace replaced", {
            ...afterD,
            workspaceId: "other"
          })
          expect(workspace.starts).toBe(2 * size + 2)
          expect(workspace.stops).toBe(2 * size + 2)

          if (size === sizes[sizes.length - 1]) report()
        }),
      600_000
    )
  }
})
