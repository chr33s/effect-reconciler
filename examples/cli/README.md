# devctl — a CLI reconciled

A sketch of the smallest control plane there is: a REPL. Each typed command
produces a new immutable `Model`, the Model is committed, and the live process
tree — an `http` listener and `fs.watch` handles — follows.

The resources are real, so the failures are real: a taken port fails with
`EADDRINUSE`, a missing file with `ENOENT`, and both are recovered with
`controller.retry` once the environment is fixed.

```sh
npx vitest run examples/cli      # the scripted transcript below, asserted
npx tsx examples/cli/main.ts     # interactive (tsx is not a dependency of this repo:
                                 # `src` is TypeScript with `.js` specifiers, which
                                 # plain `node` type-stripping will not resolve)
```

## The tree

```text
Project (one, key = directory)      stat the directory; publishes its root
├── Server  (one, key = port)       binds 127.0.0.1:<port>; sequential replacement
└── Watch   (many, key = file)      fs.watch → server.reload
    └── requires: Server
```

`Watch` is *owned* by `Project` but *requires* `Server`. Ownership says a
watcher never outlives the project; the requirement says it never outlives the
particular server generation it reloads — so `serve 46000` replaces the
watchers rather than silently re-pointing them at a new listener.

`Server` spells out `Replacement.sequential()` (the default) because a port is
exclusive: the old listener must reach its finalization boundary before the
replacement binds. That is the one property a hand-written version of this CLI
usually gets wrong.

## What the CLI itself has to write

The whole of it, in [`app.ts`](app.ts) and [`session.ts`](session.ts):

```ts
// desire is a pure function of the CLI's state
export const Bound = Dev.bind<Model>((bind) => ({
  project: bind.one(Dev.Project, (model) => model.root),
  server: bind.one(Dev.Server, (model) => model.port),
  watch: bind.many(Dev.Watch, (model) => model.watching)
}))

// every state-changing command, in full
const next = yield* Ref.updateAndGet(state, (model) => update(model, command))
yield* controller.commit(next)
```

`update` is pure and total: `stop` is `port: Option.none()`, and that is the
entire implementation of stopping a server. There is no "is one already
running", no closing the old watcher before opening the new one, and no
starting/stopping/failed flags in the Model — the runtime owns what is live,
and `controller.status` answers for it.

Three integration points beyond `commit`, all in `session.ts`:

- `controller.failures` drains into the terminal, so a failed startup is
  reported where the user is looking;
- `controller.status(ref)` backs the `status` command — authoritative, where a
  failure notification is live-only and lossy;
- `controller.retry(ref)` backs `retry`, so recovering needs no retry nonce in
  the Model and no withdrawing and restoring desire.

The references those take are built from the Model with `Reconciler.ref`, and
their ownership chain is type-checked: a `Watch` reference cannot be built
without the `Project` reference it lives under.

`Term` — where the CLI writes — is required by the startup Effects and
published by nobody, so it is a *root* requirement: it appears on
`Reconciler.make`'s environment and is provided once, by whoever runs the
session. `main.ts` provides stdout; the test provides a recorder.

## A real transcript

Produced by `main.ts`, project path shortened:

```text
$ npx tsx examples/cli/main.ts
devctl — a CLI reconciled by effect-reconciler
open /tmp/demo
opened /tmp/demo
serve 45999
serving /tmp/demo on http://127.0.0.1:45999
watch a.ts
watching a.ts → :45999
status
  Project /tmp/demo: running
  Server  :45999: running
  Watch   a.ts: running
                                    # a.ts edited in another window
reload a.ts → :45999
serve 46000                         # re-bind: dependents first, then the listener
unwatched a.ts
stopped :45999
serving /tmp/demo on http://127.0.0.1:46000
watching a.ts → :46000
stop                                # withdrawing desire for the server
unwatched a.ts
stopped :46000
status
  Project /tmp/demo: running
  Watch   a.ts: —                   # desired, not admissible: no server
quit
closed /tmp/demo
```

`—` is `Option.none()` from `controller.status`: no physical generation exists
for that identity. It is not "stopped" — it means either not desired, or
desired and not yet admissible, which is exactly the distinction a hand-rolled
`Map<string, Fiber>` cannot make.

Commits never await convergence, which is visible if you paste the whole
script at once: `status` can answer before the port has finished binding. The
prompt comes back immediately; the tree catches up.

## What the test proves

[`session.test.ts`](session.test.ts) runs the transcript against real ports and
a real temp directory, and asserts the parts a reader would otherwise take on
faith:

- a watcher desired before any project is simply not admissible — no error, and
  nothing to clean up when the project does open;
- after `serve <b>` reports the new listener, `<a>` is genuinely no longer
  accepting connections (sequential replacement), and the watcher was replaced,
  not re-pointed;
- a squatted port fails with `EADDRINUSE`, the failure is *remembered* by
  `status`, and re-committing the same state is not an implicit retry — the
  failed generation keeps its slot until `retry` retires it;
- leaving the session's Scope closes the listener and awaits finalization.

## What this sketch does not show

Ownership deeper than one level, one Definition bound to two different control
planes, and `many` families with structural keys — those are in
[`examples/editor.ts`](../editor.ts). Coordination code counted before and
after a migration is in [`examples/foldkit`](../foldkit/README.md).
