# Workspace diagnostics — a Foldkit feature, twice

This is the experiment `docs/spec.1.md` Phases 4 and 5 call for: one non-trivial
[Foldkit](https://github.com/foldkit/foldkit) feature implemented **with** and
**without** `effect-reconciler`, running against the same backend, checked by
the same tests, and measured on how much application coordination each one
needs.

```sh
npm test                    # both versions, same scenarios (scenario + race tests)
npm run example:metrics     # the Phase 5 table below
```

## The feature

An editor's diagnostics pipeline:

```text
Session (signed-in user)
└── Workspace (open project)
    └── LanguageServer (per language, expensive, can fail to start)
        ├── diagnostics stream          (push events into the update loop)
        └── Analyzer × open document    (also depends on Settings)

Settings (revision) ──────────────────► Analyzer
```

It was chosen because it carries every trait Phase 4 asks for:

| trait | where it shows up |
| :--- | :--- |
| ManagedResource | the language server connection: acquire, release, re-acquire |
| Subscription | diagnostics pushed from the live connection |
| nested lifetime conditions | analyzers exist only under a live server, under a workspace, under a session |
| operational readiness fields | the "before" Model tracks which server and analyzers are live, starting, stopping |
| provider-dependent resources | analyzers capture a server generation *and* a settings revision |
| rapid key churn | documents open and close faster than analyzers start |
| startup failure | `cobol` has no server; the UI must say so |
| child resource lifetimes | one analyzer per open document, owned by the connection |

## The two versions

**`before/app.ts` — the application coordinates.** Idiomatic Foldkit: the
server is a `ManagedResource`, diagnostics are a `Subscription`, and the
per-document analyzers — which Managed Resources cannot express, being
single-instance — are supervised by hand from `update` through Commands. Every
line that exists only because lifetimes must be coordinated is marked
`@lifecycle`.

**`after/app.ts` — the reconciler coordinates.** The Model carries domain state
only, `update` is pure domain transitions with no Commands, and the ownership
and capability story is stated once as a `Reconciler.define`. The integration
is `controller.commit(model)` after every update, plus a drain of
`controller.failures` into one Message.

Both are driven by `driver.ts`, a headless stand-in for the parts of the
Foldkit runtime this comparison needs (Message loop, Commands, Managed
Resources, Subscriptions). The real runtime mounts into a DOM document, and the
view layer is irrelevant to what is being measured; the app modules are still
written as real Foldkit values, so they would run unchanged under it.

## What the tests show

`scenario.test.ts` runs the same editor story against both versions and asserts
against the **backend**, not the Model: which servers and analyzers exist after
each user action, that a settings change rebinds analyzers without touching the
connection, that a language change replaces the connection and everything under
it, and that an unsupported language surfaces as a failure the UI can show.
Both versions pass identically — the migration preserved behaviour.

`race.test.ts` runs five generic lifecycle races against both:

1. an analyzer that starts against a superseded connection cannot win
2. no analyzer outlives the connection it belongs to
3. a settings change during startup never leaves a stale analyzer
4. the latest desired language wins after rapid changes
5. a document reopened during cleanup never runs two analyzers

For the "before" version these five test **application code**: every rule is
hand-written in `before/app.ts` and a real project would maintain them forever.
For the "after" version the application contains no lifetime rules at all, so
the same scenarios pass against behaviour the kernel's own conformance suite
already proves. That is what Phase 5 means by race tests moving out of the
application.

## Phase 5 measurement

Counted from the source by `metrics.mjs`, not asserted in prose:

```text
metric                                  before   after    delta
---------------------------------------------------------------
Model fields, total                         11       7     -36%
Model fields, lifecycle-only                 4       0    -100%
Message variants, total                     14      10     -29%
Message variants, lifecycle-only             5       1     -80%
Lifecycle-marked lines                      25       0    -100%
Manual provider invalidation sites           1       0    -100%
Commands (lifecycle)                         2       0    -100%
Domain branches running the supervisor      13       0    -100%
Coordination SLOC                          135      67     -50%
  reconciler integration SLOC                0      26      +26
Application SLOC, whole feature            215     167     -22%
Lifecycle race tests owned by the app        5       0    -100%
```

Reading the rows against the Phase 5 categories:

- **Lifecycle-only Model fields** (`server`, `analyzers`, `analyzersStarting`,
  `analyzersStopping`) go to zero. The remaining seven fields are things the
  user changed or the UI shows.
- **Lifecycle-only Messages** go from five to one. The survivor is
  `LifetimeFailed`, which is a genuine application fact — the UI says "language
  server unavailable" — rather than bookkeeping.
- **Duplicated lifetime predicates** disappear. In the "before" version the
  "session and workspace and live server" condition is stated in the Managed
  Resource requirements *and* restated in the supervisor, and thirteen domain
  update branches have to remember to re-run that supervisor. In the "after"
  version ownership is structural: `owner: Workspace` says it once.
- **Manual provider invalidation** disappears. Comparing each analyzer's
  captured `serverId` and `settingsRevision` against the current ones becomes
  `requires: { settings: Settings }`.
- **Race tests** move out of the application entirely.
- **Coordination SLOC** halves: 135 hand-written lines become a 67-line
  Definition and Binding, of which 26 are the integration wiring that any app
  pays once regardless of how many families it declares.

The 30–50% target in `docs/spec.1.md` §14 is met on lifecycle-specific code
(−50%), while the whole feature shrinks by a more modest 22% — the domain half
of the app is untouched, which is what should happen.

## What this does and does not establish

It establishes that the abstraction fits a real Foldkit-shaped feature, that
the migration preserves observable behaviour under adversarial timing, and that
the coordination code it deletes is the code a competent hand-written version
actually needs — the "before" version passes every race test, so this is not a
comparison against a strawman.

It does **not** substitute for migrating an existing production application.
The feature here was written for the comparison, so its "before" version is as
good as I could make it rather than as bad as real code drifts; a real
migration also carries costs this example cannot show (learning the model,
rewriting existing tests, reviewing a diff nobody asked for). The
GO / SHRINK / STOP decision in Phase 9 still needs a real project's numbers.
