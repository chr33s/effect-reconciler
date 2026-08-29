# effect-reconciler

**State-reconciled keyed Effect lifetimes.**

When an Effect application's live resources depend on changing state — a
session, the workspaces under it, the documents under those — the coordination
gets written by hand: predicates for what should be running, cancellation for
what should not, provider invalidation when a dependency is replaced, and a set
of tests for the races in between. `effect-reconciler` moves that behind two
declarations.

A Reconciler compiles a static architecture of keyed Effect lifetime families,
lifetime ownership and capability dependencies. A Binding maps immutable
control state into desired keys for those families. Each committed state
atomically replaces desired state, and the Controller asynchronously converges
live Effect Scopes and capability bindings toward that desire.

```sh
npm install effect-reconciler effect
```

`effect` v4 is a **peer** dependency, deliberately: a second copy in the tree
would give you a second runtime identity, and services published by a lifetime
would not be the services your code asks for.

> **Experimental `0.x`.** The kernel and its semantics are specified in
> [`docs/spec.md`](docs/spec.md) and held to the conformance suite (spec §14).
> `Definition`, `Binding`, `commit`, `status`, `snapshot` and `shutdown` are
> the parts meant to be built on. **`retry`, `failures`, `changes`, `events`,
> `diagnostics`, supervision policies, incremental `deps` and observed state
> are unstable** and may change shape within `0.x` — they are specified,
> conformance-tested and measured, but they have not had production mileage
> (spec §16.1).

## The 30-second model

Three things, and nothing else to learn:

| | what it is | when it runs |
| :--- | :--- | :--- |
| **Definition** | the static architecture — which families exist, who owns whom, what requires what | once, at startup |
| **Binding** | pure selectors from *your* state to the keys each family should have | on every commit |
| **Controller** | commit state, read status, retry a failure, shut down | for the life of the app |

Observation splits the same way, and the split is load-bearing: **queries are
authoritative and cannot be missed** (`status`, `snapshot`), **streams explain
and may be missed** (`failures`, `changes`, `events`). Derive application state
from the first; read the second to understand what happened.

```text
commit(state) ─▶ selectors ─▶ desired keys ─▶ reconcile ─▶ live Effect Scopes
                  (pure)       (a snapshot)    (async)      (started, stopped)
```

A lifetime exists **while its key is desired and it is admissible** — its
owner is Running, its providers are Running, and the replacement policy allows
it. Nothing else starts or stops it. There is no `start`, `stop`, `restart` or
`invalidate` to call, and that absence is the design: a lifecycle you cannot
drive by hand is a lifecycle that cannot drift from your state.

A semantic lifetime's identity is **family handle + key + owner path**. Keys
use Effect's `Equal` / `Hash` semantics, so plain objects, arrays and `Data`
values compare structurally without an encoding step. That comes with a real
caller contract:

- **Keys are immutable.** The runtime caches identity hashes; mutating a key
  after it has been desired corrupts the identity under which it was admitted.
- **Equality must be stable across commits.** A reference-compared key — a
  function, or a value wrapped in `Equal.byReference` — must be the same
  reference on each equivalent commit. Rebuilding it intentionally means a
  different lifetime and therefore replacement.
- Put something in the key exactly when changing it should create a different
  semantic lifetime. State a running lifetime should observe without being
  replaced belongs in `observes`, not in its key.

## Usage

```ts
import { Context, Effect, Option } from "effect"
import { Reconciler, Replacement, Supervision } from "effect-reconciler"

// 1. Define the static architecture once (state-independent). The semantic key
//    type is inferred from `start`; identity is Effect's Equal/Hash.
const Editor = Reconciler.define((define) => {
  const Session = define.one("Session", {
    replacement: Replacement.overlap(),
    start: (userId: string) => Effect.succeed(Context.make(SessionService, { userId }))
  })
  const Workspace = define.one("Workspace", {
    owner: Session, // ownership: Workspace never outlives its Session
    start: (workspaceId: string) =>
      Effect.gen(function* () {
        const session = yield* SessionService // ordinary Effect service access
        // acquireRelease / addFinalizer are tied to this lifetime's Scope
      })
  })
  const Document = define.many("Document", {
    owner: Workspace, // `many`: one lifetime per key, reconciled independently
    start: (uri: string) => Effect.log(`open ${uri}`)
  })
  return { Session, Workspace, Document }
})

// 2. Bind any control-state type with pure selectors. Owned selectors receive
//    the semantic owner reference: its key, and its own owner up to the root.
const Bound = Editor.bind<Model>((bind) => ({
  // A root `one` family: `Option<key>` — desired, or not.
  session: bind.one(Editor.Session, (model) => model.user),
  // An owned `one`: the selector runs per live owner and receives it.
  workspace: bind.one(Editor.Workspace, (model, owner) =>
    Option.fromNullable(model.workspacesByUser[owner.key]) // owner.key is the Session key
  ),
  // A `many`: the keys that should exist under this owner. Add one and one
  // starts; drop one and one stops; leave one alone and nothing happens to it.
  documents: bind.many(Editor.Document, (model, owner) =>
    model.openByWorkspace[owner.key] ?? []
  )
}))

// 3. Commit state; the runtime converges asynchronously.
const program = Effect.gen(function* () {
  const controller = yield* Reconciler.make(Bound)
  yield* controller.commit(model) // never awaits startup/shutdown
  // ...
  yield* controller.shutdown // idempotent; awaits structured finalization
})
```

Capability dependencies that are not ownership use `requires`; the provider's
published `Context` becomes ordinary services in the dependent's startup
environment, and provider replacement structurally replaces dependents
(never silent rebinding):

```ts
const Diagnostics = define.one("Diagnostics", {
  owner: Document,
  requires: { settings: Settings, language: Language },
  start: (_: null) =>
    Effect.gen(function* () {
      const settings = yield* SettingsService
      const language = yield* LanguageService
      // ...
    })
})
```

Every semantic API speaks one vocabulary — a `LifetimeRef`: the family handle,
its key, and its owner path. Failures arrive as one, `status` and `retry` take
one:

```ts
// A live Stream of failures, for reacting.
yield* Stream.runForEach(controller.failures, (failure) => {
  failure.lifetime.family.name // "Server"
  failure.lifetime.key // "typescript"
  failure.lifetime.parent?.key // the Workspace it failed beneath
  failure.cause // why startup failed
  return show(failure)
})

// Status is authoritative, for remembering: notifications are lossy under
// overflow, so state that depends on failure stays discoverable here.
const state = yield* controller.status(ref) // Option<Starting|Running|Failed|Stopping>

// The environment gets fixed: retry the same semantic key. No retry nonce in
// the model, no withdrawing and restoring desire.
yield* controller.retry(ref)

// A payload-free prompt: something a `status` read could report has moved.
// Nothing is named, so there is nothing to trust — you re-read what you care
// about. A converged runtime is silent, which is what a timer cannot be.
yield* Stream.runForEach(controller.changes, () => refreshWhateverIsOnScreen)

// The whole tree at one instant, owners before children. Not N status calls:
// those interleave with N-1 chances for the runtime to move, and can show a
// child Running under an owner that has already stopped.
const snapshot = yield* controller.snapshot
for (const { lifetime, status } of snapshot.lifetimes) {
  render(lifetime.family.name, lifetime.key, status._tag)
}
```

Retry exists at two different lifecycle levels:

| API | what another attempt means |
| :--- | :--- |
| `Effect.retry` **inside `start`** | Run the startup operation again inside the **same physical generation and Scope**. The Reconciler continues to report `Starting` and sees only the eventual success or ultimate failure. |
| `Controller.retry(ref)` / `Supervision.restart(schedule)` | After startup has become `Failed`, retire that failed generation and admit a **new physical generation** when its owner, providers and replacement policy permit. The semantic identity — family, key and owner path — does not change. |

In short: `Effect.retry` retries *within startup*; Controller retry and
supervision replace a *failed startup generation*. Neither restarts a lifetime
that is already Running.

For understanding the runtime rather than driving it, there is a diagnostic
half — lossy, never authoritative, and built only while something is watching:

```ts
// Why, which is the one thing `status` cannot tell you. The application
// changed one settings revision; three lifetimes moved, for three reasons
// none of which is written anywhere in the application.
yield* Stream.runForEach(controller.events, (event) => {
  // Retired · Settings:1     (desire)    — the application changed this
  // Retired · Document:a.ts  (provider)  — it captured Settings at admission
  // Retired · Analyzer:null  (owner)     — its owner went, so it went
  return log(event)
})

const { lifetimes, commits, passes, startupFailures } = yield* controller.diagnostics
```

[`examples/devtools`](examples/devtools/README.md) is ~150 lines of assembly
over those three, and prints a live tree.

Expected failures are tagged data, so recovery is ordinary Effect:

```ts
Reconciler.make(Bound).pipe(
  Effect.catchTags({
    AmbiguousProvider: (e) => report(`${e.family.name}.${e.requirement}`),
    MissingBinding: (e) => report(`no selector for ${e.family.name}`)
    // ...
  })
)
```

Startup environments are typed. Whatever a `start` Effect needs beyond its own
Scope, its ancestors' published capabilities and its required providers'
capabilities is a root-environment requirement, and surfaces on
`Reconciler.make`:

```ts
// Res.start yields SettingsService, which no ancestor or provider publishes.
const controller = Reconciler.make(Bound) // Effect<..., Scope | SettingsService>
```

### Policy, incrementality and nesting

Three optional declarations, all off by default, all measured or bounded
rather than assumed:

```ts
// Replace a Failed startup generation on a schedule. This is the second retry
// level described above: unlike `Effect.retry` inside `start`, each scheduled
// attempt gets a new physical generation. Never touches a Running lifetime
// (spec §9.8).
define.one("Server", {
  supervision: Supervision.restart(
    Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 5 }))
  ),
  start: (key: string) => …
})

// Declare what a selector reads, and it is skipped when that is unchanged.
// Opt-in because the runtime cannot check the claim, and *not* a free win:
// ~3x cheaper on unchanged data, ~3x more expensive on data that changes
// (spec §9.9, bench/RESULTS.md).
bind.many(Document, (s, owner) => s.docsByWorkspace[owner.key], {
  deps: (s, owner) => s.docsByWorkspace[owner.key]
})

// A lifetime that runs a Reconciler of its own, over its own state shape and
// its own families. It stops when its host stops, by the ownership closure
// that already exists — there is no second lifecycle (spec §9.10).
define.one("Workspace", {
  owner: Session,
  observes: Reconciler.observed<WorkspaceModel>(),
  start: Reconciler.nested<string>()(workspaceBinding)
})
```

`observes` is also useful on its own: it is the only channel by which a
*running* lifetime sees state change instead of being replaced by it. A key
change still replaces the lifetime; observation cannot start or stop anything.

Each design decision, what it rules out, and where its evidence lives are in
the specification (spec §13).

More complete examples:

- [`examples/editor.ts`](examples/editor.ts) — the full editor topology from
  the spec, bound to two different control planes.
- [`examples/foldkit`](examples/foldkit/README.md) — one Foldkit feature built
  twice, with and without the reconciler, with the coordination it deletes
  counted from the source.
- [`examples/foldkit-migration`](examples/foldkit-migration/README.md) — an
  upstream Foldkit example app migrated onto it, including where that did not
  pay off.
- [`examples/devtools`](examples/devtools/README.md) — a live tree, counters
  and a why-column, assembled from `snapshot` + `events` + `diagnostics` and
  rendered to text so it can be asserted on.
- [`examples/ui`](examples/ui/README.md) — React, Solid and Lit adapters over
  a shared synchronous mirror of `Controller.status`, driven entirely by
  `changes`. This example is why `changes` exists: it was built against a
  polling mirror first, and that is what showed the signal was worth adding.
- [`examples/cli`](examples/cli/README.md) — a REPL as the control plane, with
  real listeners and file watches, so `EADDRINUSE` / `ENOENT` exercise failure,
  `status` and `retry` end to end.

## Semantics proven by the conformance suite

Spec §14 maps each of these to the test file that proves it.

- equal keys retain physical lifetimes; changed keys replace them
- equivalent commits create zero lifecycle churn
- `many` keys reconcile independently (add / retain / remove)
- owner replacement closes all descendants structurally; children wait for
  their owner to be Running; identity is owner-relative
- provider replacement invalidates dependents only; failed providers prevent
  dependent admission; provider generations never mix
- startup is interruptible; late startup completion never resurrects an
  obsolete lifetime
- sequential replacement preserves exclusivity with latest-state coalescing;
  overlap replacement permits safe coexistence
- commits linearize, publish atomically, and never await convergence
- shutdown is idempotent, interrupts startups, awaits structured
  finalization; commits after shutdown fail with `ControllerClosed`
- one Definition binds to multiple state types
- semantic keys are ordinary Effect values compared with `Equal`/`Hash`, so
  structural keys need no encoding and cannot collide
- a failed lifetime holds its slot, so recommitting the same state is not an
  implicit retry; `retry` retires the failed generation under the same key
- owned selectors see the whole semantic owner path, so identical direct-owner
  keys under different ancestors stay distinct
- a commit that returns has published; a commit interrupted before its
  publication point has published nothing
- change signals report every transition `status` can report — `Starting →
  Running` included — stay silent through an equivalent commit, coalesce, and
  prompt a late or racing subscriber exactly once
- a snapshot reports every generation owners-first, answers as `status` does,
  cannot contradict itself mid-transition, and is empty after shutdown
- events name why each generation was retired and retain nothing for a
  Controller nobody is watching; counters are maintained regardless
- supervision is off by default, restarts a failed startup under the same key,
  stops when its schedule is exhausted, and resets once the lifetime runs
- an incremental binding skips exactly the selectors whose declared
  dependencies are unchanged and produces the same desire the full sweep does
- observed state reaches a running lifetime without replacing it, coalesces to
  the latest, and never reaches an obsolete generation; a nested Reconciler
  reconciles on its parent's commits and dies with its host

## Where it sits next to `RcMap` and `LayerMap`

```text
RcMap / LayerMap:    a resource exists while it is referenced
effect-reconciler:   a resource exists while it is desired and admissible
```

Both give you keyed resource lifetimes; only the trigger differs, and the
trigger is the whole question. Reach for `RcMap` or `LayerMap` when the thing
that should keep a resource alive is *someone using it* — that is reference
counting, it is smaller, and this package does not improve on it. Reach for a
Reconciler when the thing that should keep a resource alive is *what your
state says*, and when the coordination around it — ownership, provider
invalidation, replacement, readiness — is what you would otherwise write and
test by hand.

The honest boundary is in [`examples/foldkit-migration`](examples/foldkit-migration/README.md):
migrating a **single flat resource** — no ownership, no dependencies, no keyed
children — made the code 35% *larger*. If that is your shape, a small helper
over `RcMap` is the better answer.

## Foldkit and other control planes

A Reconciler takes a control plane; it is not one. Foldkit is a natural fit —
`Message → update → committed Model`, and the Model goes to the View, to
Commands, and to `controller.commit`. The adapter's whole obligation is one
sentence: only committed Models reach the Reconciler, in the same serialized
order as Foldkit's Model transitions, and the Message loop never awaits
convergence.

Two boundaries are worth internalizing before writing the adapter:

- **Event versus state causality.** "Because X happened, run this finite
  Effect" is a Command. "While the committed state desires identity X, keep
  this lifetime alive" is the Reconciler. Putting the second in a Command is
  how lifecycle state gets back into the Model.
- **Runtime status is not application state.** If the UI needs
  `WorkspaceReady`, have the lifetime dispatch a semantic Message and let
  `update` decide, rather than the View branching on `Starting` / `Running`.

The same holds for a UI framework, a REPL or an HTTP service — see
[`examples/ui`](examples/ui/README.md) and [`examples/cli`](examples/cli/README.md).

## What it guarantees, and what it does not

Three structural invariants carry the value (spec §11):

- **Admission** — a lifetime starts only while its key is desired, its owner
  is Running, its required providers are Running and captured, and the
  replacement policy permits it.
- **Ownership closure** — an obsolete owner makes every descendant obsolete,
  with no child restating the ancestor's condition. This is the
  `if (session && workspace && document)` that leaves your code.
- **Dependency invalidation** — an invalid provider obsoletes exactly its
  bound dependents, and nothing else. Provider generations never mix: a
  dependent captures physical provider instances at admission and is never
  silently rebound.

On concurrency specifically: commits linearize and publish atomically — a
commit that returns has published, and one interrupted before its publication
point has published nothing — and `commit` never awaits startup, shutdown,
finalizers, replacement, provider readiness, retry or convergence. `shutdown`
is idempotent, interrupts startups in flight and awaits structured
finalization. Under `sequential` replacement (the default) a replacement
starts only after the outgoing generation's finalizers have actually run.

It deliberately does **not** guarantee sibling startup or shutdown ordering,
reconciliation traversal order, wall-clock convergence deadlines, fair
scheduling among unrelated lifetimes, materialization of every intermediate
desired state, one physical generation per commit, one event per internal
transition, or stable generation numbers. Depending on any of those is
depending on an implementation detail.

## Non-goals

Supervision is the sharpest example of the boundary. A restart policy here
covers a **startup that became Failed** and nothing else. `Effect.retry` inside
`start` makes another attempt inside the same physical generation and Scope;
`Controller.retry` and `Supervision.restart` retire the Failed generation and
allow a new physical generation under the same semantic identity. Once
`start` returns, the lifetime is Running and whatever it forked inside its
Scope is its own business — supervision here never restarts it.

This does not replace `Effect`, `Scope`, `Layer`, `Context`, `Fiber`, `Stream`,
`RcMap` or `LayerMap` — it coordinates them. Effect answers how work executes,
is interrupted and finalized; the Reconciler answers which lifetime should
exist, who owns it, which provider instances it must use, when it became
obsolete and which desired replacement starts next.

Out of scope entirely, not merely unimplemented: query caching, stale-time
policies, actor mailboxes, durable workflows, distributed orchestration,
remote reconciliation, automatic dependency discovery, arbitrary capability
cycles, renderer, router, forms, HMR and general signal reactivity.

Everything it does remains expressible by hand with ordinary Effect. It earns
its place only by removing application-written lifecycle predicates, owner
tracking, readiness coordination, provider invalidation and race-condition
tests — and if it is not removing those for you, it is not paying for itself.

## Requirements

`effect` v4 (currently `4.0.0-rc.x`) as a peer dependency, and Node 24 LTS or
later.

## Development

Type checking runs TypeScript 7 with [`@effect/tsgo`](https://github.com/Effect-TS/tsgo),
so `tsc` reports Effect language-service diagnostics alongside type errors
(`prepare` patches the local TypeScript install after every `npm install`).

```sh
npm install
npm run check   # tsc --strict + Effect diagnostics; includes type-misuse assertions
npm run lint    # Effect language-service diagnostics on their own
npm test        # @effect/vitest conformance suite
npm run bench   # scale benchmark, 100 / 1k / 10k lifetimes (see bench/RESULTS.md)
npm run build   # dist/: ESM + declarations + maps, from tsconfig.build.json
npm run verify-package   # pack, install into a throwaway project, drive it
```

`prepack` runs check, lint, test and build, so nothing publishes that has not
passed all four. The published tarball carries `dist/` and `src/` — the maps
point at the sources, so a stack trace and a go-to-definition both land in
real code. `src/internal/` is emitted because the public declarations refer to
it, but it is unreachable through `exports`: only the modules named there are
the `0.x` surface.

CI runs check, lint, the conformance suite, the build and `verify-package` on
the minimum supported Node LTS (24) and Node current for every push and pull request. `verify-package` is the
one step nothing above it can stand in for: it packs the tarball, installs it
into a throwaway project with `effect` supplied from outside, and drives the
package through its public entry points — so an `exports` entry pointing at a
file `files` does not ship fails here rather than on someone's install.
