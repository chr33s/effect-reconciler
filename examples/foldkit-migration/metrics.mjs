/**
 * What the migration deleted from, and added to, the upstream application.
 *
 * Counts come from the two sources. Classifications that need judgement — is
 * this field domain state or lifecycle bookkeeping? — are listed by name here
 * rather than inferred, so they can be argued with.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const read = (path) => readFileSync(join(here, path), "utf8")

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

const count = (source, pattern) => (source.match(pattern) ?? []).length

const before = read("before/main.ts")
const after = read("after/main.ts")

// Messages that exist only to carry a resource's lifecycle back into the
// Model, rather than to record something the user or the domain did.
const beforeLifecycleMessages = ["StartedEngine", "StoppedEngine", "FailedStartEngine"]
const afterLifecycleMessages = ["LifetimeFailed"]

// Model state that describes the runtime rather than the domain. Upstream
// `engine: EngineState` is a four-state machine; the migrated `engineWanted`
// is the user's intent and `maybeEngineFailure` is what the UI shows.
const beforeLifecycleFields = ["engine"]
const afterLifecycleFields = []

const modelFields = (source, marker) =>
  between(source, marker, "\n}").split("\n").filter((line) => line.includes("readonly ")).length

const messageVariants = (source) =>
  count(between(source, "defineMessageUnion({", "\n})"), /^\s*(\/\*\*.*\*\/\s*)?[A-Z][A-Za-z]*:/gm)

const rows = [
  ["Model fields, total", modelFields(before, "export interface Model {"), modelFields(after, "export interface Model {")],
  ["Model fields, lifecycle-only", beforeLifecycleFields.length, afterLifecycleFields.length],
  ["Lifecycle state-machine variants", count(between(before, "defineTaggedUnion({", "\n})"), /^\s*[A-Z][A-Za-z]*:/gm), 0],
  ["Message variants, total", messageVariants(before), messageVariants(after)],
  ["Message variants, lifecycle-only", beforeLifecycleMessages.length, afterLifecycleMessages.length],
  ["Resource-availability handling in commands", count(before, /catchTag\('ResourceNotAvailable'|catchTag\("ResourceNotAvailable"/g), 0],
  ["Definition + Binding SLOC", 0, sloc(between(after, "// LIFETIMES", "\n// INTEGRATION"))],
  ["Integration SLOC (holder, wiring, retry)", 0, sloc(between(after, "export class EngineHolder", "// MODEL")) + sloc(between(after, "// INTEGRATION", "\n// END"))],
  ["Application SLOC, whole feature", sloc(before), sloc(after)]
]

const pad = (value, width) => String(value).padStart(width)
const label = (value) => value.padEnd(44)

console.log("")
console.log(`${label("metric")}${pad("before", 8)}${pad("after", 8)}`)
console.log("-".repeat(60))
for (const [name, beforeValue, afterValue] of rows) {
  console.log(`${label(name)}${pad(beforeValue, 8)}${pad(afterValue, 8)}`)
}
console.log("")
