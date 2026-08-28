/**
 * Phase 5 measurement: what the migration deleted from the application.
 *
 * Counts are derived from the two app modules rather than asserted in prose.
 * Lines that exist only to coordinate lifetimes are marked `@lifecycle` in the
 * source; lines that exist only because the reconciler is being used are
 * marked `@integration`. Run with `npm run example:metrics`.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const read = (path) => readFileSync(join(here, path), "utf8")

/** Source lines: no blanks, no comment-only lines. */
const sloc = (source) =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("//") &&
        !line.startsWith("/*") &&
        !line.startsWith("*") &&
        !line.startsWith("*/")
    ).length

const between = (source, start, end) => {
  const from = source.indexOf(start)
  if (from === -1) return ""
  const to = source.indexOf(end, from)
  return source.slice(from, to === -1 ? source.length : to)
}

const countMatches = (source, pattern) => (source.match(pattern) ?? []).length

/** SLOC of the regions bracketed by `@<name>-begin` / `@<name>-end`. */
const region = (source, name) => {
  const lines = source.split("\n")
  const collected = []
  let inside = false
  for (const line of lines) {
    if (line.includes(`@${name}-begin`)) {
      inside = true
      continue
    }
    if (line.includes(`@${name}-end`)) {
      inside = false
      continue
    }
    if (inside) collected.push(line)
  }
  return sloc(collected.join("\n"))
}

/**
 * Fields of the exported `Model` interface, split by marker. A marker counts
 * whether it sits on the field line or in the comment above it.
 */
const modelFields = (source) => {
  const block = between(source, "export interface Model {", "\n}")
  let total = 0
  let lifecycle = 0
  let carried = false
  for (const line of block.split("\n")) {
    if (line.includes("@lifecycle")) carried = true
    if (!line.includes("readonly ")) continue
    total++
    if (carried) lifecycle++
    carried = false
  }
  return { total, lifecycle }
}

/** Variants of the Message union, split by marker. */
const messageVariants = (source) => {
  const block = between(source, "defineMessageUnion({", "\n})")
  const lines = block.split("\n")
  let total = 0
  let lifecycle = 0
  let carried = false
  for (const line of lines) {
    const marked = line.includes("@lifecycle") || line.includes("@integration")
    if (marked) carried = true
    if (/^\s*(\/\*\*.*\*\/\s*)?[A-Z][A-Za-z]*:\s*\{/.test(line)) {
      total++
      if (marked || carried) lifecycle++
      carried = false
    }
  }
  return { total, lifecycle }
}

const before = read("before/app.ts")
const after = read("after/app.ts")
const raceTests = read("race.test.ts")

const beforeModel = modelFields(before)
const afterModel = modelFields(after)
const beforeMessages = messageVariants(before)
const afterMessages = messageVariants(after)

const raceScenarios = countMatches(raceTests, /\n\s{6}it\.live\(/g)

// Coordination code: hand-written lifetime rules in the Foldkit version, the
// Definition plus Binding in the reconciler version.
const beforeCoordination = region(before, "coordination")
const afterCoordination = region(after, "coordination")
const afterIntegration = region(after, "integration")
/** Domain update branches that have to re-run the supervisor. */
const supervisorCallSites = countMatches(before, /reconcileAnalyzers\(\{/g)

const rows = [
  ["Model fields, total", beforeModel.total, afterModel.total],
  ["Model fields, lifecycle-only", beforeModel.lifecycle, afterModel.lifecycle],
  ["Message variants, total", beforeMessages.total, afterMessages.total],
  ["Message variants, lifecycle-only", beforeMessages.lifecycle, afterMessages.lifecycle],
  ["Lifecycle-marked lines", countMatches(before, /@lifecycle/g), countMatches(after, /@lifecycle/g)],
  ["Manual provider invalidation sites", countMatches(before, /Manual provider invalidation/g), 0],
  ["Retry nonce fields in the Model", countMatches(before, /serverAttempt:/g) > 0 ? 1 : 0, 0],
  ["Commands (lifecycle)", countMatches(before, /name: "(Start|Stop)Analyzer"/g), 0],
  ["Domain branches running the supervisor", supervisorCallSites, 0],
  ["Coordination SLOC", beforeCoordination, afterCoordination],
  ["  reconciler integration SLOC", 0, afterIntegration],
  ["Application SLOC, whole feature", sloc(before), sloc(after)],
  ["Lifecycle race tests owned by the app", raceScenarios, 0]
]

const pad = (value, width) => String(value).padStart(width)
const label = (value) => value.padEnd(38)

console.log("")
console.log(`${label("metric")}${pad("before", 8)}${pad("after", 8)}${pad("delta", 9)}`)
console.log("-".repeat(63))
for (const [name, beforeValue, afterValue] of rows) {
  const delta =
    beforeValue === 0
      ? afterValue === 0 ? "—" : `+${afterValue}`
      : `${Math.round(((afterValue - beforeValue) / beforeValue) * 100)}%`
  console.log(`${label(name)}${pad(beforeValue, 8)}${pad(afterValue, 8)}${pad(delta, 9)}`)
}
console.log("")
