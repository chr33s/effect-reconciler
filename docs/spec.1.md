# effect-reconciler — Recommended Next Steps

## Current assessment

The v0 kernel is already substantial. It implements the core Definition/Binding model, real Effect Scope ownership, `one`/`many`, capability dependencies, immutable provider-generation capture, startup cancellation, sequential/overlap replacement, coalescing, atomic non-blocking commits, shutdown, type-level misuse checks, and race-heavy conformance tests.

The next question is no longer whether the architecture can be implemented. It is:

> **Does `effect-reconciler` remove enough real application coordination to justify a standalone runtime abstraction?**

The next milestone should be:

```text
Kernel hardening
      ↓
real Foldkit migration
      ↓
before/after coordination metrics
      ↓
scale benchmark
      ↓
GO / SHRINK / STOP
```

Do not prioritize DevTools, supervision, package polish, or more spec work before this milestone.

---

# Phase 1 — Fix four contract holes

## 1. Owner-relative binding must preserve the semantic owner path

### Problem

Runtime identity includes:

```text
lifetime handle
+
semantic key
+
owner semantic path
```

but an owned selector currently receives only the direct owner key.

Example:

```text
Organization[A]
└── Workspace[main]
    └── Document[...]

Organization[B]
└── Workspace[main]
    └── Document[...]
```

A Document selector receives `"main"` in both cases and cannot distinguish `A/main` from `B/main` unless ancestor identity is redundantly embedded into the Workspace key.

### Recommended direction

Pass a **pure semantic owner reference/path** to owned selectors.

Conceptually:

```ts
bind.many(
  Document,
  (state, owner) => {
    owner.key
    owner.parent?.key
  }
)
```

Requirements:

- no Scope
- no services
- no physical generation
- no mutable runtime state
- strongly typed where practical

### Required test

Create two distinct ancestor paths with the same direct-owner key and prove child desire can differ beneath them.

---

## 2. Define startup-failure observation before the Foldkit migration

### Problem

Startup failure is correctly handled internally, but `Controller` currently exposes only:

```ts
commit
shutdown
```

A real control plane cannot learn that a desired lifetime is `Failed`.

### Goal

Provide the **smallest stable mechanism** needed for application-level failure handling.

Do not jump directly to a full diagnostic event system.

Candidate approaches:

- minimal stable snapshot
- narrow lifecycle/failure observer
- explicit startup-outcome bridge

### Acceptance criterion

A Foldkit feature must be able to surface states such as:

```text
Language server failed
Workspace unavailable
Connection failed
```

without exposing physical generations or reconciler internals.

---

## 3. Tighten commit interruption semantics

### Problem

The desired contract is:

```text
commit succeeds
→ new desired snapshot definitely published

commit fails
→ new desired snapshot definitely not published
```

The caller should not face a `maybe committed` outcome.

### Recommended contract

Use a precise linearization point:

> Before the publication point, interruption publishes nothing. Once publication begins, it completes exactly once.

Keep the atomic/uninterruptible region as small as practical.

Conceptually:

```text
evaluate selectors
      ↓
validate snapshot
      ↓
[atomic publication region]
  check open
  replace desired
  wake reconciler
      ↓
return
```

### Required tests

Add controlled barriers around:

- before publication
- at the publication boundary
- after publication

and assert deterministic outcomes.

---

## 4. Make `Key.struct` composition collision-safe

### Problem

Custom `Key.encode` values may contain arbitrary strings. Direct concatenation inside `Key.struct` can create collisions even when the individual encoders are injective.

### Recommended implementation

Frame each component encoding.

For example:

```ts
JSON.stringify([
  ["fieldA", fieldA.encode(value.fieldA)],
  ["fieldB", fieldB.encode(value.fieldB)]
])
```

with canonical field order.

### Required test

Use adversarial encodings containing:

```text
quotes
commas
colons
braces
field-name-like text
slashes
pipes
```

and prove distinct structures do not collide.

---

# Phase 2 — Add CI

Continuously enforce the kernel contract before adding features.

For every push and pull request:

```sh
npm ci
npm run check
npm run lint
npm test
```

Initially keep the matrix small, for example:

```text
Node current LTS
Node latest stable
```

The important thing is that strict TypeScript checks, Effect diagnostics, misuse assertions, and runtime conformance tests become mandatory.

---

# Phase 3 — Reduce timing-based test flakiness

Current polling/sleep-based helpers are acceptable for early experimentation but should not become the long-term concurrency test strategy.

Prefer:

```text
Deferred
Semaphore
explicit startup gates
explicit finalizer gates
test-only barriers
```

over:

```text
sleep
settle windows
```

Prioritize hardening tests for:

- concurrent commits
- sequential replacement
- overlap replacement
- late startup completion
- shutdown during startup
- provider invalidation during startup
- failed-start cleanup

A private test-only “controller idle” barrier may be useful if it observes controller bookkeeping without changing production semantics.

---

# Phase 4 — Migrate one real Foldkit feature

This is the primary product-validation experiment.

## Integration

Do not design a Foldkit-specific abstraction first.

Use the thinnest integration:

```text
Foldkit commits Model
        ↓
controller.commit(model)
```

Conceptually:

```ts
const Bound = Editor.bind<Model>(...)
const controller = yield* Reconciler.make(Bound)
```

After each committed Model:

```ts
yield* controller.commit(model)
```

Foldkit must not await runtime convergence inside its Message transaction.

## Feature selection

Choose a genuinely non-trivial feature involving several of:

```text
ManagedResource
Subscription
nested lifetime conditions
operational readiness fields
provider-dependent resources
rapid key churn
startup failure
child resource lifetimes
```

Do not validate the project using only a single flat resource.

---

# Phase 5 — Measure before/after coordination

Judge the project by **application coordination deleted**, not framework code added.

Record these metrics before and after migration.

## Lifecycle-only Model fields

Examples:

```text
sessionReady
workspaceReady
languageReady
resourceAvailable
resourceStarting
```

Distinguish true domain/UI state from operational runtime bookkeeping.

## Lifecycle-only Messages

Examples:

```text
ResourceAcquired
ResourceReleased
WorkspaceReady
LanguageStarted
RetryAcquire
```

Keep Messages with genuine application semantics.

## Duplicated lifetime predicates

Count conditions such as:

```text
session exists
AND workspace exists
AND language ready
AND document exists
```

These should largely disappear when lifetime dominance is structural.

## Manual provider invalidation

Count application code that reacts to provider changes and explicitly restarts dependents.

## Race-condition tests

Count application tests whose purpose is mainly proving generic lifecycle behavior:

```text
old startup cannot win
child cannot outlive owner
provider change restarts dependent
latest key wins
sequential cleanup blocks replacement
```

These should move into the reconciler conformance suite.

## SLOC

Measure:

```text
application orchestration SLOC before
application orchestration SLOC after
integration SLOC
```

A strong result would be roughly a **30–50% reduction** in lifecycle-specific application code, with an even larger reduction in manual coordination rules.

---

# Phase 6 — Add a scale benchmark before optimizing

The current implementation correctly favors semantics over incremental optimization.

Measure before adding indexes.

Run at:

```text
100 Documents
1,000 Documents
10,000 Documents
```

## Scenario A — Equivalent commit

Same desired set.

Measure:

- commit latency
- selector evaluations
- reconcile CPU
- lifecycle churn, which must remain zero

## Scenario B — One Document change

Remove one and add one.

Measure unnecessary work.

## Scenario C — Settings replacement

Expected:

```text
Diagnostics restart
Documents retained
```

Measure provider invalidation cost and unrelated work.

## Scenario D — Language replacement

Same selective invalidation pattern.

## Scenario E — Workspace replacement

Invalidate the full owned subtree.

Measure worst-case structural replacement.

Only add:

```text
reverse dependency indexes
dirty-slot queues
dirty-family queues
incremental binding invalidation
```

when benchmark data shows they are necessary.

---

# Phase 7 — Let the migration drive the observation API

After the Foldkit migration, decide whether the stable public API needs:

```text
snapshot
status query
failure observer
semantic lifecycle events
```

Stable observation may expose:

```text
semantic family
semantic key/path
Starting
Running
Failed
Stopping
startup failure cause
```

It should not expose:

```text
numeric generations
desired revision counters
Scope
Fiber
Context internals
reconciliation queue details
scheduler ordering
```

---

# Phase 8 — Stabilize errors before publication

The current broad string-based errors are sufficient for a private kernel but not ideal as a stable API.

Before publishing, move toward discriminated cases.

Conceptually:

```ts
type DefinitionError =
  | UnknownOwner
  | ForeignHandle
  | OwnershipCycle
  | CapabilityCycle
  | AmbiguousProvider
  | UnresolvableProvider
```

and:

```ts
type BindingError =
  | MissingBinding
  | DuplicateBinding
  | CardinalityMismatch
  | ForeignHandle
```

Keep these layers distinct:

```text
definition misuse
binding misuse
commit failure
lifetime startup failure
internal defect
```

---

# Phase 9 — GO / SHRINK / STOP decision

After the hardening fixes, CI, Foldkit migration, and scale benchmark, make an explicit investment decision.

## GO

Continue toward a standalone package if:

- lifecycle-only Model state drops materially
- lifecycle-only Messages drop materially
- duplicated predicates disappear
- provider invalidation code disappears
- generic race tests move out of application code
- ordinary Effect service access remains natural
- scale behavior is reasonable
- the runtime stays narrowly focused
- migrated application code is clearly easier to understand

## SHRINK

Shrink toward a Foldkit-specific abstraction or smaller Effect helper if:

- the main benefit appears only inside Foldkit
- generic Definition/Binding reuse is rarely valuable
- `RcMap` / `LayerMap` plus a small helper achieves most of the benefit
- capability DAGs are uncommon in real applications
- most users need only nested ownership

## STOP

Stop the standalone project if:

- application code is not clearly simpler
- lifecycle bookkeeping merely moves rather than disappears
- users frequently need escape hatches
- service typing becomes harder than ordinary Effect
- failure observation creates a second application-state system
- runtime scope expands toward actors/workflows/query caching
- common workloads require disproportionate runtime complexity

---

# Recommended execution order

## Immediate

1. Fix owner semantic-path binding.
2. Fix `Key.struct` framing.
3. Tighten commit interruption semantics.
4. Determine the minimum startup-failure observation needed for Foldkit.
5. Add CI.

## Next

6. Replace timing-heavy race assertions with explicit synchronization where practical.
7. Migrate one non-trivial Foldkit feature.
8. Capture before/after coordination metrics.
9. Run 100 / 1,000 / 10,000 instance scale benchmarks.

## Only after validation

10. Decide GO / SHRINK / STOP.
11. If GO, stabilize snapshot/failure observation.
12. Stabilize typed public errors.
13. Add package build/export/publishing setup.
14. Add diagnostics/DevTools after stable semantic observation exists.
15. Optimize reconciliation only where benchmarks justify it.

---

# Next milestone definition

The next milestone is complete when:

```text
four known contract holes are resolved
+
CI enforces the conformance suite
+
one real Foldkit feature is migrated
+
before/after coordination metrics exist
+
scale behavior is measured
```

At that point answer:

> **Does `effect-reconciler` eliminate enough real application-written coordination to justify becoming a standalone Effect library?**
