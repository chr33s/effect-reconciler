/**
 * The session: a Controller, the current Model, and the loop that turns one
 * typed line into a commit.
 *
 * This is the whole of the CLI's lifecycle code, and it is the same three
 * moves whatever the commands are:
 *
 * 1. `update` the pure Model and `commit` it — never awaiting convergence, so
 *    the prompt returns immediately even though a port takes a moment to bind;
 * 2. drain `controller.failures` into the terminal, so a failed startup is
 *    reported where the user is looking;
 * 3. answer `status` and `retry` with `LifetimeRef`s built from the Model.
 */
import { Cause, Effect, Option, Ref, Stream, type Scope } from "effect"
import * as Reconciler from "../../src/Reconciler.js"
import type { LifetimeRef } from "../../src/LifetimeRef.js"
import type { LifetimeStatus } from "../../src/Status.js"
import { Bound, Dev, empty, HELP, parse, Term, update, type Model } from "./app.js"

export interface Session {
  /** Runs one typed line. `false` means the user asked to quit. */
  readonly submit: (line: string) => Effect.Effect<boolean>
  readonly model: Effect.Effect<Model>
}

// Semantic references, built from the Model — the same vocabulary `status`,
// `retry` and `failures` speak. The ownership chain is type-checked: a Watch
// reference cannot be built without the Project reference it lives under.
const projectRef = (root: string) => Reconciler.ref(Dev.Project, root, null)
const serverRef = (root: string, port: number) =>
  Reconciler.ref(Dev.Server, port, projectRef(root))
const watchRef = (root: string, file: string) =>
  Reconciler.ref(Dev.Watch, file, projectRef(root))

/** Why a lifetime failed, in one line. */
const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

const show = (status: Option.Option<LifetimeStatus>): string =>
  Option.match(status, {
    // `None` is not "stopped": it means no physical generation exists — not
    // desired, or desired and not yet admissible (no project, no server).
    onNone: () => "—",
    onSome: (live) =>
      live._tag === "Failed" ? `failed — ${reason(live.cause)}` : live._tag.toLowerCase()
  })

const label = (lifetime: LifetimeRef): string =>
  `${lifetime.family.name} ${String(lifetime.key)}`

export const make: Effect.Effect<Session, never, Term | Scope.Scope> = Effect.gen(
  function* () {
    const term = yield* Term
    // A Definition that does not compile is a bug in this file, not a condition
    // the CLI can act on.
    const controller = yield* Effect.orDie(Reconciler.make(Bound))
    const state = yield* Ref.make(empty)

    // Failures of still-desired lifetimes, reported as they happen. `status`
    // stays authoritative — this stream is live-only and lossy by contract.
    yield* Stream.runForEach(controller.failures, (failure) =>
      term.line(`! ${label(failure.lifetime)}: ${reason(failure.cause)}`)
    ).pipe(Effect.forkScoped)

    const status = Effect.gen(function* () {
      const model = yield* Ref.get(state)
      if (Option.isNone(model.root)) return yield* term.line("  no project")
      const root = model.root.value
      yield* term.line(`  Project ${root}: ${show(yield* controller.status(projectRef(root)))}`)
      if (Option.isSome(model.port)) {
        const port = model.port.value
        yield* term.line(
          `  Server  :${port}: ${show(yield* controller.status(serverRef(root, port)))}`
        )
      }
      for (const file of model.watching) {
        yield* term.line(
          `  Watch   ${file}: ${show(yield* controller.status(watchRef(root, file)))}`
        )
      }
    })

    /**
     * The environment was fixed outside the CLI (the port was freed, the file
     * was created). Retry retires the failed generation under the *same* key,
     * so the Model needs no retry nonce and desire is never withdrawn and
     * restored to fake one.
     */
    const retry = (target: string) =>
      Effect.gen(function* () {
        const model = yield* Ref.get(state)
        if (Option.isNone(model.root)) return yield* term.line("  no project")
        const root = model.root.value
        if (target === "project") return yield* controller.retry(projectRef(root))
        if (target === "server") {
          return Option.isSome(model.port)
            ? yield* controller.retry(serverRef(root, model.port.value))
            : yield* term.line("  not serving")
        }
        return model.watching.includes(target)
          ? yield* controller.retry(watchRef(root, target))
          : yield* term.line(`  not watching ${target}`)
      }).pipe(Effect.catchTag("ControllerClosed", () => term.line("  session is closing")))

    const submit = (line: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const command = parse(line)
        switch (command._tag) {
          case "Quit":
            return false
          case "Help":
            yield* term.line(HELP)
            return true
          case "Unknown":
            if (line.trim() !== "") yield* term.line(`  ? ${line.trim()} (try \`help\`)`)
            return true
          case "Status":
            yield* status
            return true
          case "Retry":
            yield* retry(command.target)
            return true
          default: {
            // Every state-changing command is this, and only this.
            const next = yield* Ref.updateAndGet(state, (model) => update(model, command))
            yield* controller.commit(next).pipe(
              Effect.catch((error) => term.line(`  commit rejected: ${error._tag}`))
            )
            return true
          }
        }
      })

    return { submit, model: Ref.get(state) }
  }
)
