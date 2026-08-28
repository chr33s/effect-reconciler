# effect-reconciler

**State-reconciled keyed Effect lifetimes.**

A Reconciler compiles a static architecture of keyed Effect lifetime families,
lifetime ownership and capability dependencies. A Binding maps immutable
control state into desired keys for those families. Each committed state
atomically replaces desired state, and the Controller asynchronously converges
live Effect Scopes and capability bindings toward that desire.

This repository contains the **v0 kernel**: the smallest real implementation
able to falsify the specification in [`docs/spec.md`](docs/spec.md), plus the
conformance suite from the implementation plan (§9). Snapshot API,
diagnostics, supervision/retry, incremental selectors and package polish are
deliberately deferred (plan §3).

## Usage

```ts
import { Context, Effect, Option } from "effect"
import { Key, Reconciler, Replacement } from "effect-reconciler"

// 1. Define the static architecture once (state-independent).
const Editor = Reconciler.define((define) => {
  const Session = define.one("Session", {
    key: Key.string,
    replacement: Replacement.overlap(),
    start: (userId) => Effect.succeed(Context.make(SessionService, { userId }))
  })
  const Workspace = define.one("Workspace", {
    key: Key.string,
    owner: Session, // ownership: Workspace never outlives its Session
    start: (workspaceId) =>
      Effect.gen(function* () {
        const session = yield* SessionService // ordinary Effect service access
        // acquireRelease / addFinalizer are tied to this lifetime's Scope
      })
  })
  return { Session, Workspace }
})

// 2. Bind any control-state type with pure selectors. Owned selectors receive
//    the semantic owner reference: its key, and its own owner up to the root.
const Bound = Editor.bind<Model>((bind) => ({
  session: bind.one(Editor.Session, (model) => model.user),
  workspace: bind.one(Editor.Workspace, (model, owner) =>
    model.workspacesByUser[owner.key] // owner.key is the Session key
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
  key: Key.null,
  owner: Document,
  requires: { settings: Settings, language: Language },
  start: () =>
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
const failures = yield* controller.failures // subscription owned by this Scope
const failure = yield* PubSub.take(failures)
failure.lifetime.family.name // "Server"
failure.lifetime.key // "typescript"
failure.lifetime.parent?.key // the Workspace it failed beneath
failure.cause // why startup failed

// Status is authoritative; notifications are a live convenience that may be
// missed, so state that depends on failure stays discoverable.
const state = yield* controller.status(failure.lifetime) // Failed(cause)

// The environment gets fixed: retry the same semantic key. No retry nonce in
// the model, no withdrawing and restoring desire.
yield* controller.retry(failure.lifetime)
```

Startup environments are typed. Whatever a `start` Effect needs beyond its own
Scope, its ancestors' published capabilities and its required providers'
capabilities is a root-environment requirement, and surfaces on
`Reconciler.make`:

```ts
// Res.start yields SettingsService, which no ancestor or provider publishes.
const controller = Reconciler.make(Bound) // Effect<..., Scope | SettingsService>
```

Design decisions and their evidence are in
[`docs/decisions.md`](docs/decisions.md).

See [`examples/editor.ts`](examples/editor.ts) for the full editor topology
from the spec, bound to two different control planes, and
[`examples/foldkit`](examples/foldkit/README.md) for one real Foldkit feature
implemented with and without the reconciler, with the coordination it deletes
measured.

## Semantics proven by the conformance suite

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
- a failed lifetime holds its slot, so recommitting the same state is not an
  implicit retry; `retry` retires the failed generation under the same key
- owned selectors see the whole semantic owner path, so identical direct-owner
  keys under different ancestors stay distinct
- `Key.struct` composition stays injective under adversarial component
  encodings
- a commit that returns has published; a commit interrupted before its
  publication point has published nothing

## Requirements

`effect` v4 (currently `4.0.0-rc.x`) as a peer dependency.

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
```

CI runs `npm ci && npm run check && npm run lint && npm test` on Node LTS and
current for every push and pull request.
