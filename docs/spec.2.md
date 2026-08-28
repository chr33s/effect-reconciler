# effect-reconciler — Next Actions Roadmap

## Current status

`effect-reconciler` has moved beyond feasibility. The kernel, controlled Foldkit migration, and scale benchmarks provide credible evidence that the architecture works and can materially reduce application-written lifecycle coordination.

Current position:

```text
Kernel architecture:        validated
Controlled Foldkit value:   validated
Scale viability:            provisionally validated
Production adoption value:  not yet validated
Stable public API:          not yet validated
```

The next phase should focus on **semantic completeness and real adoption evidence**, not feature expansion.

```text
retry semantics
+
semantic failure identity
+
failure-delivery contract
+
real existing Foldkit migration
+
CI verification
+
publication hardening
        ↓
GO / SHRINK / STOP
```

---

# 1. Define same-key retry semantics

## Problem

A desired lifetime may fail:

```text
LanguageServer["typescript"]
        ↓
      Failed
```

Recommitting the same state should remain lifecycle-idempotent, so it cannot be used as an implicit retry.

Avoid workarounds such as:

```text
retry nonce in semantic key
withdraw desire then restore it
unrelated domain-state changes
```

These pollute domain identity with operational generation state.

## Recommended API

Conceptually:

```ts
yield* controller.retry(ref)
```

Meaning:

> If the referenced semantic lifetime is still desired and its current physical generation is Failed, retire the failed generation and allow a fresh generation to be admitted when owner/provider conditions permit.

Retry must not change semantic identity.

```text
semantic key
≠
physical retry generation
```

## Desired behavior

- **Current + Failed:** retire failed generation and admit a fresh one.
- **Running/Starting/Stopping:** no-op.
- **No longer desired:** no-op or benign typed result.
- **Controller closed:** fail with `ControllerClosed`.
- **Provider unavailable:** remain unadmitted until provider becomes Running.
- **Sequential cleanup in progress:** wait for the failed generation's required finalization boundary.
- **Repeated retry:** idempotent.

## Required tests

1. failed root lifetime retries with the same key;
2. failed owned lifetime retries with the same key;
3. retry after owner is no longer current;
4. retry while provider is unavailable;
5. retry after provider becomes Running;
6. repeated retry is idempotent;
7. retry after shutdown;
8. sequential retry waits for partial-resource cleanup;
9. retry does not restart a healthy Running lifetime;
10. retry preserves semantic path/key identity.

---

# 2. Introduce a stable semantic lifetime reference

## Problem

Failure observation currently relies too much on human-readable family names. The Definition model says opaque handles are authoritative family identity; labels are only display names.

Two families can plausibly share the same label:

```ts
define.one("Worker", ...)
define.one("Worker", ...)
```

A string-only family identity is therefore insufficient for retry, status, or failure APIs.

## Goal

Introduce a pure semantic reference representing:

```text
family identity
+
semantic key
+
semantic owner path
```

Conceptually:

```ts
interface LifetimeRef<H = AnyHandle> {
  readonly family: H
  readonly key: KeyOf<H>
  readonly owner: unknown
}
```

The exact type can differ.

## Must not expose

```text
Scope
Fiber
Context
physical generation
reconcile revision
mutable live slot/instance
```

## Desired uses

The same semantic reference should support:

```text
failure observation
retry
future status/snapshot lookup
diagnostics
```

A failure could become conceptually:

```ts
interface LifetimeFailure {
  readonly lifetime: LifetimeRef
  readonly cause: Cause.Cause<unknown>
}
```

with display convenience such as:

```ts
failure.lifetime.family.name
```

---

# 3. Decide whether startup-failure observation may be lossy

## Current concern

A bounded sliding live failure stream is:

```text
non-blocking
bounded
Scope-owned
live-only
potentially lossy
```

This is fine for diagnostics but may be insufficient when application correctness depends on observing failure.

The Foldkit experiment turns a lifetime failure into UI/domain state such as:

```text
serverUnavailable = true
```

A missed event could therefore produce stale UI state.

## Decide the model

### Option A — Event only

Use only if failures are explicitly best-effort diagnostics.

### Option B — Queryable state only

Expose:

```ts
controller.status(ref)
```

or:

```ts
controller.snapshot
```

so current `Failed` state is always discoverable.

### Option C — Queryable state + live notifications

Most robust direction:

```text
authoritative semantic status
+
convenient live notifications
```

Recommended principle:

> If application state depends on failure, the failure should remain discoverable even if a notification is missed.

## Tests if the failure stream remains public

1. report only failures whose semantic desire is still current;
2. suppress stale-generation failure;
3. report failure again after an explicit retry fails;
4. subscription is Scope-owned;
5. document behavior with no subscribers;
6. document overflow semantics;
7. failure publication never blocks reconciliation.

Do not freeze the current failure API until this contract is explicit.

---

# 4. Migrate one existing Foldkit feature/application

## Why

The controlled comparison already showed strong reduction in lifecycle coordination, but it was purpose-built for the experiment. The next proof should come from code that existed before `effect-reconciler`.

## Choose a feature with several of

```text
ManagedResource
Subscription
readiness fields
acquired/released Messages
nested runtime conditions
manual provider invalidation
per-key child resources
rapid churn
failure UI
race-condition tests
```

Avoid a single flat resource or a new toy example.

## Capture baseline before editing

Measure:

### Model
- total fields;
- lifecycle-only fields;
- duplicated readiness state.

### Messages
- total variants;
- lifecycle-only variants.

### Commands
- lifecycle-related commands.

### Existing resource primitives
- ManagedResources;
- Subscriptions;
- manual Scope/Fiber supervision.

### Manual coordination
- owner predicates;
- readiness checks;
- provider invalidation;
- coalescing;
- cleanup/replacement gates.

### Tests
- domain tests;
- generic lifecycle/race tests.

### SLOC
- whole feature;
- lifecycle/coordination subset.

### Adoption friction
- files touched;
- migration diff size;
- new concepts introduced;
- test rewrite effort;
- review complexity;
- required escape hatches.

## Migration style

Keep integration minimal:

```text
committed Model
→ controller.commit(model)
```

plus the smallest failure/status bridge required.

Do not design a generalized Foldkit adapter package first.

---

# 5. Add a real user-visible retry scenario to the Foldkit migration

After same-key retry exists, validate:

```text
language server startup fails
↓
UI shows unavailable
↓
environment/problem is fixed
↓
user presses Retry
↓
same semantic key remains desired
↓
server starts successfully
↓
UI clears failure
↓
dependents start
```

Required properties:

- no retry nonce enters Model;
- semantic key remains unchanged;
- failed physical generation is replaced;
- retry can fail again and report a fresh failure;
- success clears domain failure through normal application logic;
- stale old-generation failures cannot win afterward.

Treat this as a release-gating scenario.

---

# 6. Verify GitHub Actions actually runs

A workflow file is not enough; confirm real successful runs.

Verify:

```text
Actions enabled
push to main triggers workflow
PR triggers workflow
Node LTS job runs
Node current job runs
npm ci succeeds
npm run check succeeds
npm run lint succeeds
npm test succeeds
```

If no runs appear, inspect:

```text
repository Actions permissions
workflow path
branch trigger
workflow enablement
commit visibility
```

Once successful runs exist, consider branch protection requiring the kernel CI checks.

---

# 7. Clean up commit-interruption test naming

The deterministic tests now prove:

```text
interrupted before publication
→ nothing published

returned commit
→ definitely published
```

Keep those as the normative contract tests.

An older uncontrolled-race test that accepts either outcome is still useful as an atomicity stress test, but rename/reframe it to something like:

> uncontrolled interruption preserves atomicity and controller consistency

This avoids confusing atomicity with the stronger linearization-point guarantee.

---

# 8. Keep reconciliation unoptimized until real data requires it

Current benchmarks show understood O(N) costs in:

```text
Binding evaluation
full reconcile sweep
```

while lifecycle churn remains selective and correct.

Do not add yet:

```text
dirty-slot queues
dirty-family queues
incremental selector dependency graphs
complex reverse invalidation schedulers
```

During the real migration, record:

```text
actual desired instance count
commit frequency
commit latency
convergence time
memory/GC pressure
startup/finalizer workload
```

Optimize only when real workloads show that full selector evaluation or reconcile scanning consumes meaningful latency/frame budget.

---

# 9. Replace numeric Definition identity before publication

## Problem

A global `Symbol.for` brand plus module-local numeric builder IDs can theoretically collide across duplicate installed copies of the package.

## Direction

Use an unforgeable per-Definition runtime identity:

```ts
const definitionIdentity = {}
```

Every handle captures that identity, and foreign-handle checks use object identity.

Keep numeric family IDs only as indexes within one Definition.

## Tests

- foreign handles are rejected;
- equality does not depend solely on numeric IDs;
- if practical, simulate handles from isolated module/package instances.

This is not blocking private experimentation, but it should be fixed before publication.

---

# 10. Stabilize the error algebra before public release

Current string-oriented errors are acceptable for the private kernel.

Before publication, move toward discriminated cases such as:

```ts
type DefinitionError =
  | UnknownOwner
  | ForeignHandle
  | OwnershipCycle
  | CapabilityCycle
  | AmbiguousProvider
  | UnresolvableProvider
  | InvalidCardinality
```

and:

```ts
type BindingError =
  | MissingBinding
  | DuplicateBinding
  | CardinalityMismatch
  | ForeignHandle
```

Keep these semantic layers separate:

```text
DefinitionError
BindingError
CommitError
lifetime startup failure
internal defect
```

Do not block the real-app migration on this polish unless it exposes missing categories.

---

# 11. Track pressure for `many` provider selection

The current v0 provider rule is intentionally conservative:

```text
ancestor provider
or
unique one-cardinality collateral provider
```

A `many` provider is rejected as ambiguous.

During the real migration, watch for genuine needs like:

```text
Document[foo]
requires
LanguageServer[typescript]
```

where the provider family is itself `many`.

If this recurs, an explicit selection mechanism may eventually be needed, e.g. conceptually:

```ts
requires: {
  server: require(LanguageServer, {
    key: (_, document) => document.language
  })
}
```

Do **not** add this without real pressure.

Track:

```text
many-provider selection
cross-owner selection
dynamic provider matching
```

as major scope signals.

---

# 12. Decide stable observability after the real migration

Do not build DevTools yet.

After the migration, decide whether stable public inspection needs:

```ts
controller.snapshot
```

or:

```ts
controller.status(ref)
```

Potential semantic information:

```text
family handle
semantic key
semantic owner path
Starting
Running
Failed
Stopping
startup failure cause
```

Avoid exposing:

```text
physical generation number
Fiber
Scope
Context
desired revision
reconcile ordering
internal slot state
```

Stable observation should answer:

```text
Why is this desired resource unavailable?
Which semantic lifetime is Failed?
Is this semantic lifetime Running?
```

without creating compatibility dependencies on internals.

---

# 13. Update the specification only after retry/failure semantics are proven

Do not write a large new spec revision first.

Implement and test:

```text
LifetimeRef
Controller.retry
failure identity
failure delivery/status semantics
```

Then update the main spec with behavior that has implementation evidence.

Expected spec changes:

```text
Controller.retry
LifetimeRef
retry idempotence
same-key retry
failed-slot semantics
failure observation guarantees
event vs status semantics
```

Remove retry from the unresolved list only after tests pass.

---

# 14. Publication hardening — only after real-app validation

If the production-style migration is positive:

## Package metadata

Add/verify:

```text
exports
types
files
sideEffects
repository
license
keywords
engines
publishConfig
```

## Build

Create an intentional build/output strategy.

## Effect dependency

Keep Effect as a peer dependency to reduce duplicate runtime identity issues.

## Versioning

Release experimentally under `0.x`.

Clearly document unstable areas such as:

```text
retry
observability
diagnostic APIs
```

until proven stable.

## Documentation

Before a public experimental release, include:

1. 30-second mental model;
2. root `one` example;
3. ownership example;
4. `many` example;
5. capability dependency example;
6. failure + retry example;
7. Foldkit integration;
8. comparison with `RcMap` / `LayerMap`;
9. explicit non-goals;
10. concurrency guarantees.

---

# 15. Keep the product boundary narrow

Do not add adjacent features merely because they are useful elsewhere:

```text
actor mailboxes
durable workflows
query caching
stale-time policies
distributed orchestration
automatic retry policies
large supervision DSLs
renderer
forms
router
general signals
remote topology
```

For every feature ask:

> Is this necessary for state-reconciled keyed Effect lifetimes?

If not, keep it outside the package.

---

# 16. Maintain a decision log

Create a concise document such as:

```text
docs/decisions.md
```

or ADRs covering at least:

1. Definition/Binding separation;
2. topology as internal vocabulary;
3. semantic key vs physical generation;
4. ownership vs capability dependency;
5. dependent replacement instead of provider rebinding;
6. non-blocking/non-convergent commit;
7. current rejection of ambiguous `many` providers;
8. explicit retry instead of key pollution;
9. semantic observability without generation IDs;
10. optimization deferred until measured pressure.

This will reduce semantic drift as more contributors/users arrive.

---

# Recommended execution order

## Immediate kernel work

1. Design `LifetimeRef`.
2. Change `LifetimeFailure` to use semantic identity.
3. Implement `Controller.retry(ref)`.
4. Add full same-key retry conformance tests.
5. Decide and document failure-stream loss/status semantics.
6. Clean up the old interruption-test wording.

## Infrastructure

7. Verify GitHub Actions runs successfully.
8. Add branch-required checks after green runs exist.
9. Replace numeric cross-package Definition identity with object identity.

## Product validation

10. Select one existing Foldkit feature/application.
11. Capture baseline coordination/adoption metrics.
12. Migrate with minimal integration.
13. Add the user-visible same-key retry scenario.
14. Capture before/after metrics and migration friction.
15. Record actual runtime scale and commit frequency.

## Decision point

16. Make an explicit **GO / SHRINK / STOP** decision.

## Only if GO

17. Stabilize semantic observability.
18. Stabilize public error algebra.
19. Update the spec with proven retry/failure semantics.
20. Add package build/exports metadata.
21. Add public docs/examples.
22. Prepare an experimental `0.x` release.
23. Optimize only where real benchmark data justifies it.
24. Consider DevTools only after semantic observability is stable.

---

# GO / SHRINK / STOP criteria

## GO

Continue toward a public standalone package if the existing-app migration shows:

- lifecycle-only Model state materially decreases;
- lifecycle-only Messages materially decrease;
- manual provider invalidation disappears;
- generic race logic moves into the runtime;
- same-key retry works without domain-state pollution;
- application code remains ordinary Effect code;
- few or no escape hatches are needed;
- migration/adoption cost is reasonable;
- scale remains acceptable;
- users can understand Definition + Binding + Controller without learning internal topology mechanics.

## SHRINK

Reduce scope toward Foldkit-specific infrastructure or a smaller Effect helper if:

- most value appears only inside Foldkit;
- reusable Definition/Binding separation adds little in practice;
- generic capability DAGs are rare;
- retry/observation significantly complicate the generic API;
- direct `RcMap` / `LayerMap` plus a smaller helper removes most real coordination.

## STOP

Stop the standalone project if:

- existing application code is not clearly simpler;
- lifecycle bookkeeping merely moves rather than disappears;
- many escape hatches are required;
- failure/status synchronization creates a second application-state system;
- service typing becomes less Effect-native;
- common use cases force actor/workflow scope;
- runtime complexity exceeds the coordination it removes.

---

# Next milestone definition

The next milestone is complete when:

```text
semantic LifetimeRef exists
+
same-key retry is implemented and tested
+
failure identity uses semantic family identity
+
failure delivery/status semantics are explicit
+
CI is confirmed running
+
one existing Foldkit feature is migrated
+
before/after metrics and migration costs are recorded
+
a real user-visible retry scenario passes
```

Then answer:

> **Has `effect-reconciler` proven both semantic completeness and enough real-world application value to justify an experimental public package?**
