/**
 * Verify the package a consumer would actually install.
 *
 * `npm run check` type-checks the sources; it cannot see the two things that
 * only exist in the published artefact: whether `exports` points at files
 * `files` ships, and whether the emitted JavaScript runs at all under a plain
 * Node resolver with `effect` supplied from the outside. Both are silent
 * failures — the repository stays green and the install is broken.
 *
 * So this packs the tarball, installs it into a throwaway project alongside
 * `effect`, and drives the package through its public entry points: the root
 * export, one submodule export, and enough of the runtime to prove the build
 * is not just importable but working. It also asserts that `internal/` stays
 * unreachable through `exports`, since that boundary is a published promise.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

const repo = process.cwd()
const dir = mkdtempSync(join(tmpdir(), "effect-reconciler-pack-"))

/** The program the throwaway project runs. Deliberately plain JavaScript: a
 * consumer's build tooling is not what is under test here. */
const main = `
import { Effect, Option, Queue, Stream } from "effect"
import { Reconciler, ControllerClosed } from "effect-reconciler"
import * as Status from "effect-reconciler/Status"

const assert = (ok, what) => {
  if (!ok) {
    console.error("FAIL:", what)
    process.exit(1)
  }
  console.log("ok:", what)
}

assert(typeof Reconciler.make === "function", "root export resolves")
assert(typeof ControllerClosed === "function", "error classes are exported")
assert(typeof Status === "object", "submodule export resolves")

let unreachable = false
try {
  await import("effect-reconciler/internal/controller.js")
  unreachable = true
} catch {}
assert(!unreachable, "internal/ is unreachable through exports")

// The real thing: define, bind, commit, converge, observe, shut down.
const opened = []
const Def = Reconciler.define((define) => ({
  Res: define.many("Res", {
    start: (key) => Effect.sync(() => { opened.push(key) })
  })
}))
const binding = Def.bind((bind) => ({ res: bind.many(Def.Res, (state) => state.keys) }))

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* Reconciler.make(binding)
      const ref = Reconciler.ref(Def.Res, "a", null)

      // Wait on the change signal rather than a timer, which also proves the
      // published build carries §9.5.
      const changes = yield* Stream.toQueue(controller.changes, { capacity: 16 })
      yield* controller.commit({ keys: ["a", "b"] })

      let status = Option.none()
      for (let i = 0; i < 20 && Option.isNone(status); i++) {
        yield* Effect.timeoutOption(Effect.result(Queue.take(changes)), 2000)
        status = yield* controller.status(ref)
      }
      assert(Option.isSome(status), "status reports a live lifetime")
      yield* controller.shutdown
      const closed = yield* Effect.result(controller.commit({ keys: [] }))
      assert(closed._tag === "Failure", "commit after shutdown fails")
    })
  )
)
assert(opened.length === 2, "both lifetimes started (" + opened.join(", ") + ")")
console.log("package verified")
`

try {
  const packed = run("npm", ["pack", "--pack-destination", dir], repo).trim().split("\n").pop()
  const tarball = join(dir, packed)
  const project = join(dir, "consumer")
  mkdirSync(project)
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2)
  )
  writeFileSync(join(project, "main.js"), main)
  // `effect` comes from the consumer, not from the tarball: that is what the
  // peer dependency means, and installing it here is what tests it.
  run("npm", ["install", "--no-audit", "--no-fund", tarball, "effect"], project)
  try {
    process.stdout.write(run("node", ["main.js"], project))
  } catch (error) {
    // The child's own diagnostics are the useful part; the wrapper's stack is
    // not, and hiding them behind it is what makes a CI failure unreadable.
    process.stdout.write(String(error.stdout ?? ""))
    process.stderr.write(String(error.stderr ?? ""))
    process.exitCode = 1
    throw new Error("consumer verification failed")
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
