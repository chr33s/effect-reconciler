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
      start: (_key: string) => started(undefined)
    })
    const Workspace = define.one("Workspace", {
      owner: Session,
      start: (_key: string) => started(undefined)
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
      start: (_: null) =>
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

interface Sample {
  readonly commitMs: number
  readonly convergeMs: number
  readonly selectors: number
  readonly starts: number
  readonly stops: number
}

interface Row {
  readonly documents: number
  readonly scenario: string
  readonly samples: ReadonlyArray<Sample>
}

const rows: Array<Row> = []

/** Nearest-rank percentile; with few samples a mean would hide the tail. */
const percentile = (values: ReadonlyArray<number>, p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]!
}

const report = () => {
  const header =
    "| documents | scenario | commit p50 | commit p95 | converge p50 | converge p95 | selector evals | starts | stops |"
  const divider = "| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  const body = rows.map((row) => {
    const commits = row.samples.map((sample) => sample.commitMs)
    const converges = row.samples.map((sample) => sample.convergeMs)
    const last = row.samples[row.samples.length - 1]!
    return `| ${row.documents} | ${row.scenario} | ${percentile(commits, 50).toFixed(2)} | ${
      percentile(commits, 95).toFixed(2)
    } | ${percentile(converges, 50).toFixed(2)} | ${
      percentile(converges, 95).toFixed(2)
    } | ${last.selectors} | ${last.starts} | ${last.stops} |`
  })
  console.log(["", header, divider, ...body, ""].join("\n"))
}

const sizes = [100, 1_000, 10_000]
/** Samples per scenario after a warm-up round, so the numbers are not one throw of the dice. */
const samplesPerScenario = 7

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

          /** One commit: latency at the caller's boundary, then convergence. */
          const once = function* (model: Model) {
            counters.starts = 0
            counters.stops = 0
            counters.selectors = 0
            const t0 = performance.now()
            yield* controller.commit(model)
            const t1 = performance.now()
            yield* idle(controller)
            const t2 = performance.now()
            const sample: Sample = {
              commitMs: t1 - t0,
              convergeMs: t2 - t1,
              selectors: counters.selectors,
              starts: counters.starts,
              stops: counters.stops
            }
            return sample
          }

          /**
           * A scenario is a transition, so it is measured by going `there`
           * repeatedly and returning via `back` in between. One warm round is
           * discarded before sampling, and only the `there` direction counts.
           */
          const scenario = function* (name: string, there: Model, back: Model) {
            yield* once(there)
            yield* once(back)
            const samples: Array<Sample> = []
            for (let round = 0; round < samplesPerScenario; round++) {
              samples.push(yield* once(there))
              yield* once(back)
            }
            rows.push({ documents: size, scenario: name, samples })
            return samples[samples.length - 1]!
          }

          // Cold build: Settings, Session, Workspace, Language, and a
          // Document + Diagnostics pair per document. Measured once, because
          // there is only ever one cold start.
          const build = yield* once(baseline)
          rows.push({ documents: size, scenario: "build (cold, one sample)", samples: [build] })
          expect(build.starts).toBe(2 * size + 4)
          expect(build.stops).toBe(0)

          // A — equivalent commit: churn must stay at exactly zero.
          const equivalent = yield* scenario("A equivalent commit", { ...baseline }, {
            ...baseline
          })
          expect(equivalent.starts).toBe(0)
          expect(equivalent.stops).toBe(0)

          // B — one Document removed, one added: only that document and its
          // Diagnostics child move, whatever the scale.
          const churned = [...documents.slice(1), "file:///added.ts"]
          const oneChanged = yield* scenario(
            "B one document changed",
            { ...baseline, documents: churned },
            baseline
          )
          expect(oneChanged.starts).toBe(2)
          expect(oneChanged.stops).toBe(2)

          // C — Settings replaced: every Diagnostics is rebound to the new
          // provider generation, and every Document is retained.
          const settings = yield* scenario(
            "C settings replaced",
            { ...baseline, settingsRevision: 2 },
            baseline
          )
          expect(settings.starts).toBe(size + 1)
          expect(settings.stops).toBe(size + 1)

          // D — Language replaced: the same selective invalidation.
          const language = yield* scenario(
            "D language replaced",
            { ...baseline, language: "tsx" },
            baseline
          )
          expect(language.starts).toBe(size + 1)
          expect(language.stops).toBe(size + 1)

          // E — Workspace replaced: the whole owned subtree, worst case.
          const workspace = yield* scenario(
            "E workspace replaced",
            { ...baseline, workspaceId: "other" },
            baseline
          )
          expect(workspace.starts).toBe(2 * size + 2)
          expect(workspace.stops).toBe(2 * size + 2)

          if (size === sizes[sizes.length - 1]) report()
        }),
      600_000
    )
  }
})
