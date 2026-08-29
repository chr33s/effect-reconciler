import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeProbe, type Model } from "../editor.js"
import { make } from "./editor.js"

interface Sample {
  readonly writeMs: number
  readonly convergeMs: number
  readonly starts: number
  readonly stops: number
}

interface Row {
  readonly documents: number
  readonly scenario: string
  readonly samples: ReadonlyArray<Sample>
}

const rows: Array<Row> = []
const sizes = [100, 1_000, 10_000]
const samplesPerScenario = 5
const percentile = (values: ReadonlyArray<number>, p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!
}

const report = (): void => {
  console.log([
    "",
    "| documents | scenario | write p50 | write p95 | converge p50 | converge p95 | starts | stops |",
    "| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => {
      const last = row.samples.at(-1)!
      return `| ${row.documents} | ${row.scenario} | ${percentile(row.samples.map((s) => s.writeMs), 50).toFixed(2)} | ${percentile(row.samples.map((s) => s.writeMs), 95).toFixed(2)} | ${percentile(row.samples.map((s) => s.convergeMs), 50).toFixed(2)} | ${percentile(row.samples.map((s) => s.convergeMs), 95).toFixed(2)} | ${last.starts} | ${last.stops} |`
    }),
    ""
  ].join("\n"))
}

describe("rebased Atom → kernel → Layer scale", () => {
  for (const size of sizes) {
    it.live(`${size} documents`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const probe = makeProbe()
          const editor = yield* make(probe)
          const documents = Array.from({ length: size }, (_, index) => `file:///doc-${index}.ts`)
          const baseline: Model = {
            settingsRevision: 1,
            session: "alice",
            workspace: "acme",
            language: "typescript",
            documents
          }

          const once = function* (model: Model) {
            const starts = probe.events.filter((event) => event.type === "start").length
            const stops = probe.events.filter((event) => event.type === "stop").length
            const t0 = performance.now()
            yield* editor.commit(model)
            const t1 = performance.now()
            yield* editor.idle
            return {
              writeMs: t1 - t0,
              convergeMs: performance.now() - t1,
              starts: probe.events.filter((event) => event.type === "start").length - starts,
              stops: probe.events.filter((event) => event.type === "stop").length - stops
            } satisfies Sample
          }

          const build = yield* once(baseline)
          rows.push({ documents: size, scenario: "build", samples: [build] })
          expect(build.starts).toBe(2 * size + 4)

          const scenario = function* (name: string, there: Model, back: Model) {
            yield* once(there)
            yield* once(back)
            const samples: Array<Sample> = []
            for (let round = 0; round < samplesPerScenario; round++) {
              samples.push(yield* once(there))
              yield* once(back)
            }
            rows.push({ documents: size, scenario: name, samples })
            return samples.at(-1)!
          }

          const equivalent = yield* scenario(
            "equivalent",
            { ...baseline, documents: [...documents] },
            baseline
          )
          expect(equivalent.starts).toBe(0)
          expect(equivalent.stops).toBe(0)

          const changed = yield* scenario(
            "one document changed",
            { ...baseline, documents: [...documents.slice(1), "file:///added.ts"] },
            baseline
          )
          expect(changed.starts).toBe(2)
          expect(changed.stops).toBe(2)

          const settings = yield* scenario(
            "settings replaced",
            { ...baseline, settingsRevision: 2 },
            baseline
          )
          expect(settings.starts).toBe(size + 1)
          expect(settings.stops).toBe(size + 1)

          if (size === sizes.at(-1)) report()
        })
      ), 600_000)
  }
})
