/**
 * The process: stdin lines in, stdout lines out, one Scope around the whole
 * session so that quitting — or Ctrl-C — closes every server and watcher
 * through the same structured finalization.
 *
 * Nothing about the reconciler appears here. Everything it needs from the
 * process is the `Term` service, which is the root requirement its startup
 * Effects declared.
 */
import { Effect, Stream } from "effect"
import * as readline from "node:readline"
import { HELP, Term } from "./app.js"
import * as Session from "./session.js"

const stdout: typeof Term.Service = {
  line: (text) =>
    Effect.sync(() => {
      process.stdout.write(`${text}\n`)
    })
}

const lines = Stream.unwrap(
  Effect.sync(() =>
    Stream.fromAsyncIterable(
      readline.createInterface({ input: process.stdin, terminal: false }),
      (error) => error as Error
    )
  )
)

const main = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* Session.make
    yield* stdout.line("devctl — a CLI reconciled by effect-reconciler")
    yield* stdout.line(HELP)
    yield* lines.pipe(
      Stream.mapEffect((line) => session.submit(line)),
      Stream.takeWhile((keepGoing) => keepGoing),
      Stream.runDrain
    )
    // Leaving the Scope shuts the controller down: the listener closes, the
    // watchers close, and their finalizers are awaited.
  })
).pipe(
  Effect.provideService(Term, stdout),
  Effect.catchCause((cause) => Effect.logError(cause))
)

Effect.runFork(main)
