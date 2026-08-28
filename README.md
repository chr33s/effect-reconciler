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

// 2. Bind any control-state type with pure selectors.
const Bound = Editor.bind<Model>((bind) => ({
  session: bind.one(Editor.Session, (model) => model.user),
  workspace: bind.one(Editor.Workspace, (model, _userId) => model.workspaceId)
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

Startup environments are typed. Whatever a `start` Effect needs beyond its own
Scope, its ancestors' published capabilities and its required providers'
capabilities is a root-environment requirement, and surfaces on
`Reconciler.make`:

```ts
// Res.start yields SettingsService, which no ancestor or provider publishes.
const controller = Reconciler.make(Bound) // Effect<..., Scope | SettingsService>
```

See [`examples/editor.ts`](examples/editor.ts) for the full editor topology
from the spec, bound to two different control planes.

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
```
