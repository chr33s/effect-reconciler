/**
 * `devctl` — a CLI whose *control plane* is the reconciler.
 *
 * A REPL is a control plane like any other: each command produces a new
 * immutable state, and live resources are supposed to follow. Written by hand
 * that becomes a pile of "is a server already running on the old port?"
 * bookkeeping inside the command handlers. Here the command handlers are pure
 * (`parse` → `update`), the process tree is declared once, and the only
 * integration is `controller.commit(model)` after every command.
 *
 * The resources are real: a listening `http` server and `fs.watch` handles, so
 * the failure stories are real too — a taken port fails with `EADDRINUSE`, a
 * missing file fails with `ENOENT`, and both are recovered with
 * `controller.retry` once the environment is fixed.
 *
 *     Project (one, key = directory)          the opened project
 *     ├── Server (one, key = port)            binds a port; exclusive
 *     └── Watch  (many, key = file) ──────────┘ requires the Server
 *
 * `Watch` is owned by `Project` but *requires* `Server`, so watchers exist
 * only while a server is up, and re-binding the port replaces every watcher
 * rather than silently re-pointing it at a new generation.
 */
import { Context, Data, Effect, Option } from "effect"
import * as fs from "node:fs"
import { stat } from "node:fs/promises"
import * as http from "node:http"
import * as path from "node:path"
import * as Reconciler from "../../src/Reconciler.js"
import * as Replacement from "../../src/Replacement.js"

// --- Services ----------------------------------------------------------------

/**
 * Where the CLI writes. No family publishes it, so it is a *root* requirement
 * and lands on `Reconciler.make`'s environment — the terminal is wired in once,
 * by whoever runs the session (`main.ts` writes to stdout, the test collects
 * lines).
 */
export class Term extends Context.Service<Term, {
  readonly line: (text: string) => Effect.Effect<void>
}>()("devctl/Term") {}

export class ProjectService extends Context.Service<ProjectService, {
  readonly root: string
}>()("devctl/Project") {}

export class ServerService extends Context.Service<ServerService, {
  readonly port: number
  readonly reload: (file: string) => Effect.Effect<void>
}>()("devctl/Server") {}

// Startup failures are ordinary tagged errors; they arrive on
// `controller.failures` and are remembered by `controller.status`.
export class NotAProject extends Data.TaggedError("NotAProject")<{
  readonly root: string
}> {
  get message(): string {
    return `${this.root} is not a directory`
  }
}

export class ListenFailed extends Data.TaggedError("ListenFailed")<{
  readonly port: number
  readonly reason: string
}> {
  get message(): string {
    return `cannot bind :${this.port} (${this.reason})`
  }
}

export class WatchFailed extends Data.TaggedError("WatchFailed")<{
  readonly file: string
  readonly reason: string
}> {
  get message(): string {
    return `cannot watch ${this.file} (${this.reason})`
  }
}

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? String(error)

const close = (server: http.Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    server.closeAllConnections()
    server.close(() => resume(Effect.void))
  })

const listen = (root: string, port: number): Effect.Effect<http.Server, ListenFailed> =>
  Effect.callback<http.Server, ListenFailed>((resume, signal) => {
    const server = http.createServer((_request, response) => {
      response.end(`devctl is serving ${root}\n`)
    })
    const onError = (error: Error) =>
      resume(Effect.fail(new ListenFailed({ port, reason: errorCode(error) })))
    server.once("error", onError)
    server.listen({ port, host: "127.0.0.1", signal }, () => {
      server.removeListener("error", onError)
      resume(Effect.succeed(server))
    })
    // If the lifetime is retired before `listening`, acquireRelease never
    // receives the server and therefore cannot install its normal finalizer.
    // The callback cleanup owns that narrow window.
    return Effect.andThen(
      Effect.sync(() => server.removeListener("error", onError)),
      close(server)
    )
  })

// --- The process tree, declared once -----------------------------------------

export const Dev = Reconciler.define((define) => {
  const Project = define.one("Project", {
    start: (root: string) =>
      Effect.gen(function* () {
        const term = yield* Term
        const info = yield* Effect.tryPromise({
          try: () => stat(root),
          catch: () => new NotAProject({ root })
        })
        if (!info.isDirectory()) return yield* new NotAProject({ root })
        yield* term.line(`opened ${root}`)
        yield* Effect.addFinalizer(() => term.line(`closed ${root}`))
        // Published to children and dependents as an ordinary service.
        return Context.make(ProjectService, { root })
      })
  })

  const Server = define.one("Server", {
    owner: Project,
    // A port is exclusive: the old listener must reach its finalization
    // boundary before the replacement binds. This is the default, spelled out
    // because it is the reason `serve 4000` after `serve 3999` cannot race.
    replacement: Replacement.sequential(),
    start: (port: number) =>
      Effect.gen(function* () {
        const term = yield* Term
        const project = yield* ProjectService
        yield* Effect.acquireRelease(
          listen(project.root, port),
          (server) => Effect.andThen(close(server), term.line(`stopped :${port}`))
        )
        yield* term.line(`serving ${project.root} on http://127.0.0.1:${port}`)
        return Context.make(ServerService, {
          port,
          reload: (file) => term.line(`reload ${path.basename(file)} → :${port}`)
        })
      })
  })

  const Watch = define.many("Watch", {
    owner: Project,
    // Not ownership: a watcher is only useful while a server is up, and a
    // re-bound port replaces every watcher instead of re-pointing it.
    requires: { server: Server },
    start: (file: string) =>
      Effect.gen(function* () {
        const term = yield* Term
        const project = yield* ProjectService
        const server = yield* ServerService
        const target = path.resolve(project.root, file)
        // The watch callback is not inside the fiber, so it runs its Effect
        // with this lifetime's own services.
        const run = Effect.runForkWith(yield* Effect.context<Term>())
        yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              fs.watch(target, () => {
                run(server.reload(target))
              }),
            catch: (error) => new WatchFailed({ file, reason: errorCode(error) })
          }),
          (watcher) =>
            Effect.andThen(
              Effect.sync(() => watcher.close()),
              term.line(`unwatched ${file}`)
            )
        )
        yield* term.line(`watching ${file} → :${server.port}`)
      })
  })

  return { Project, Server, Watch }
})

// --- The control state: what the commands edit --------------------------------

export interface Model {
  readonly root: Option.Option<string>
  readonly port: Option.Option<number>
  readonly watching: ReadonlyArray<string>
}

export const empty: Model = {
  root: Option.none(),
  port: Option.none(),
  watching: []
}

/**
 * The whole integration: desire is a pure function of the CLI's state. Nothing
 * here knows what is currently live.
 */
export const Bound = Dev.bind<Model>((bind) => ({
  project: bind.one(Dev.Project, (model) => model.root),
  server: bind.one(Dev.Server, (model) => model.port),
  watch: bind.many(Dev.Watch, (model) => model.watching)
}))

// --- Commands ----------------------------------------------------------------

export type Command = Data.TaggedEnum<{
  readonly Open: { readonly root: string }
  readonly Close: {}
  readonly Serve: { readonly port: number }
  readonly Stop: {}
  readonly Watch: { readonly file: string }
  readonly Unwatch: { readonly file: string }
  readonly Status: {}
  readonly Retry: { readonly target: string }
  readonly Help: {}
  readonly Quit: {}
  readonly Unknown: { readonly line: string }
}>

export const Command = Data.taggedEnum<Command>()

export const parse = (line: string): Command => {
  const [verb, ...rest] = line.trim().split(/\s+/)
  const argument = rest.join(" ")
  switch (verb) {
    case "open":
      return argument === "" ? Command.Unknown({ line }) : Command.Open({ root: argument })
    case "close":
      return Command.Close()
    case "serve": {
      const port = Number(argument)
      return Number.isInteger(port) && port > 0 && port < 65536
        ? Command.Serve({ port })
        : Command.Unknown({ line })
    }
    case "stop":
      return Command.Stop()
    case "watch":
      return argument === "" ? Command.Unknown({ line }) : Command.Watch({ file: argument })
    case "unwatch":
      return argument === "" ? Command.Unknown({ line }) : Command.Unwatch({ file: argument })
    case "status":
      return Command.Status()
    case "retry":
      return argument === "" ? Command.Unknown({ line }) : Command.Retry({ target: argument })
    case "help":
    case "?":
      return Command.Help()
    case "quit":
    case "exit":
      return Command.Quit()
    default:
      return Command.Unknown({ line })
  }
}

/**
 * The pure part of every command handler. Note what is *not* here: no "is a
 * server already running", no stopping the old watcher before starting the new
 * one, no starting/stopping/failed flags. `stop` is `port: none`, and that is
 * the entire implementation of stopping a server.
 */
export const update = (model: Model, command: Command): Model => {
  switch (command._tag) {
    case "Open":
      // A different directory: the whole tree beneath it is replaced.
      return { ...model, root: Option.some(path.resolve(command.root)) }
    case "Close":
      return { ...model, root: Option.none() }
    case "Serve":
      return { ...model, port: Option.some(command.port) }
    case "Stop":
      return { ...model, port: Option.none() }
    case "Watch":
      return model.watching.includes(command.file)
        ? model
        : { ...model, watching: [...model.watching, command.file] }
    case "Unwatch":
      return { ...model, watching: model.watching.filter((file) => file !== command.file) }
    default:
      return model
  }
}

export const HELP = [
  "  open <dir>       open a project (replaces everything under the old one)",
  "  close            close it",
  "  serve <port>     bind a port (sequential: the old listener closes first)",
  "  stop             stop serving",
  "  watch <file>     watch a file, reloading the server on change",
  "  unwatch <file>   stop watching it",
  "  status           what the runtime knows about each desired lifetime",
  "  retry <target>   retry a failed lifetime: `server`, or a watched file",
  "  quit"
].join("\n")
