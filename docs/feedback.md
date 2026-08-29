# effect-reconciler — Next Steps After Layer + Effect Atom Review

> **Implemented as an architectural experiment (2026-08-29).** The direct
> Layer + Atom baseline, parity helper, conformance scenarios, 100 / 1k / 10k
> benchmark and findings are in
> [`experiments/layer-atom`](../experiments/layer-atom/README.md). The result is
> provisional: direct Layer + Atom does not provide sequential finalization or
> keyed generation capture by itself; Atom and Layer do subsume enough reactive
> and capability machinery to justify a smaller REBASE prototype. Feature
> expansion remains frozen while that is evaluated.

## Context

Feedback from an Effect author raised the right architectural challenge:

> Layer already handles dependency graphs, and Effect Atom adds reactivity.

That changes the next question for `effect-reconciler`.

The project should no longer ask only:

> Does a state-reconciled Effect runtime solve a real problem?

The stronger question is:

> **How much of `effect-reconciler` should exist after using current Effect `Layer` + Effect Atom as the underlying machinery?**

The core problem still appears real:

```text
immutable control state
        ↓
desired keyed lifetimes
        ↓
correct ownership
provider generations
replacement
failure
cleanup
```

But current Effect already provides substantial parts of the mechanism:

```text
Layer
→ service dependency graph
→ Context construction
→ scoped acquisition
→ memoization / sharing

Effect Atom
→ reactive dependency graph
→ automatic invalidation
→ effect-backed reactive lifetimes
→ dependency tracking
→ subscriptions
→ keyed families
→ disposal
```

The next phase should therefore be a **SHRINK / REBASE experiment**, not feature expansion.

---

# Executive plan

```text
Freeze new reconciler features
        ↓
Build Layer + Atom baseline
        ↓
Run reconciler conformance scenarios against it
        ↓
Measure code + semantics + performance
        ↓
Identify irreducible reconciler kernel
        ↓
KEEP / SHRINK / REBASE / STOP
```

The decisive deliverable is:

> **A Layer + Effect Atom implementation of the editor DAG that is tested against the same lifecycle invariants as `effect-reconciler`.**

---

# 1. Freeze feature expansion

Until the Layer + Atom comparison is complete, do not add more runtime concepts.

Freeze development on:

```text
incremental binding machinery
observed-state extensions
nested Reconciler extensions
change-stream extensions
UI-reactivity helpers
new cache/invalidation mechanisms
many-provider selection
new supervision policies
DevTools expansion
```

Existing code can remain.

The goal is to avoid strengthening machinery that Effect may already provide.

Only fix:

```text
correctness bugs
documentation bugs
test failures
API inconsistencies required by the experiment
```

---

# 2. Build a Layer + Atom reference implementation

Create a new experimental directory, for example:

```text
experiments/layer-atom/
```

or:

```text
bench/layer-atom/
```

Do not modify the reconciler implementation to make the competitor look worse or better.

The baseline should use current Effect primitives directly:

```text
Layer
Effect Atom
Scope
Context
Effect
Schedule
```

Small generic helpers are allowed and should be counted.

The goal is to answer:

> How much generic orchestration code is still necessary after using Layer + Atom idiomatically?

---

# 3. Use the richest existing editor topology

Reproduce this topology:

```text
Application
├── Settings
└── Session[user]
    └── Workspace[id]
        ├── Language[language]
        ├── Document[foo]
        │   └── Diagnostics[foo]
        └── Document[bar]
            └── Diagnostics[bar]

Diagnostics requires:
- its Document
- current Workspace
- current Session
- current Settings
- current Language
```

This scenario is important because it contains both:

```text
ownership tree
+
capability dependency DAG
```

Do not use a flat-resource example as the primary comparison.

The repository already established that a flat resource is not the target use case.

---

# 4. First implementation: use Layer for capability construction

Try to model dynamic providers as Layers rather than manually assembling Context.

Target direction:

```ts
const SettingsLayer =
  (revision: number) =>
    Layer.effect(Settings, ...)

const SessionLayer =
  (userId: string) =>
    Layer.scoped(Session, ...)

const DiagnosticsLayer =
  (...) =>
    Layer.effect(Diagnostics, ...)
```

Investigate whether family declarations can become conceptually:

```ts
define.one("Server", {
  layer: key => Server.layer(key)
})
```

instead of:

```ts
requires: { ... },
start: (...) => Context
```

Questions to answer:

1. Can Layer express all static capability requirements?
2. Can Layer memoization correctly share collateral providers?
3. Can one physical provider generation be captured immutably by a dependent?
4. What happens when the Layer selected for a provider changes?
5. Does rebuilding a Layer implicitly produce the correct dependent invalidation?
6. Does Layer remove the need for the reconciler's explicit `requires` graph?

Record where Layer succeeds and where explicit reconciliation metadata remains necessary.

---

# 5. Second implementation: use Atom for desire and invalidation

Represent changing control state through Atom.

Investigate:

```text
Model atom
→ derived desired-key atoms
→ keyed Atom.family resources
→ dependent atoms
```

Use Atom's real dependency tracking rather than manually reproducing Binding `deps`.

Target properties:

```text
selector reads state
→ dependency automatically recorded

state changes
→ only affected reactive nodes invalidate
```

Questions:

1. Can `Atom.family` naturally represent keyed lifetime families?
2. Can desired `many` children be created/disposed without a custom map controller?
3. Can parent/child dependency reads reproduce ownership invalidation?
4. Can provider reads reproduce dependency invalidation?
5. Does Atom automatically solve the current incremental-selector problem?
6. Does Atom remove the need for `Controller.changes`?
7. Does Atom remove the need for `observes`?
8. Can UI integrations read Atom directly rather than mirror Controller status?

---

# 6. Run exact identity tests

The Layer + Atom implementation must pass:

## Equal key retention

```text
desired Session["alice"]
commit equivalent state
→ same physical Session lifetime
```

No unnecessary stop/start.

## Changed key replacement

```text
Session["alice"]
→ Session["bob"]
```

must replace the physical lifetime.

## Owner-relative identity

These must remain distinct:

```text
Organization[A]
└── Workspace[main]

Organization[B]
└── Workspace[main]
```

A child under one must never be confused with the other.

## Dynamic many

For:

```text
Document[foo]
Document[bar]
```

changing only `foo` must retain `bar`.

---

# 7. Run exact ownership tests

The Layer + Atom implementation must prove:

```text
owner obsolete
→ every descendant obsolete
```

Specifically:

```text
Session removed
→ Workspace stops
→ Language stops
→ Documents stop
→ Diagnostics stop
```

And:

```text
child startup in flight
owner replaced
old child startup completes late
→ old child cannot become current
```

The key question:

> Does Atom dependency invalidation provide the same guarantee as physical Scope ownership?

If not, identify the missing mechanism precisely.

---

# 8. Run provider-generation tests

Required scenario:

```text
Settings#1
Language#1
Diagnostics#1
```

Then replace Settings only:

```text
Settings#2
```

Expected:

```text
Workspace retained
Document retained
Language retained
Diagnostics#1 obsolete
Diagnostics#2 starts with Settings#2
```

Must prove:

```text
Diagnostics never observes:
Settings#1 + Language#2
or
Settings#2 + stale owner generation
```

The critical invariant is:

> **A dependent uses one immutable, internally consistent provider-generation set for its physical lifetime.**

If Layer + Atom can prove this directly, that removes a large part of the custom Reconciler justification.

If not, document exactly why.

---

# 9. Test sequential replacement

This is likely the most important differentiator.

Scenario:

```text
A Running

desire B

A begins finalization
A finalizer blocks

desire changes again to C
```

Required sequential semantics:

```text
B never starts
C does not start while A finalizer is blocked
A finalizer completes
C starts
```

This tests:

```text
latest-state coalescing
+
finalization-before-replacement
```

Do not accept:

```text
old finalizer launched asynchronously
new generation starts immediately
```

as sequential parity.

Questions:

1. Does Atom wait for async Scope closure before recomputing?
2. Does Layer memoization wait for release boundaries?
3. Can the behavior be implemented with a small generic helper?
4. How many lines of generic coordination does it require?

This result may define the irreducible `effect-reconciler` kernel.

---

# 10. Test overlap replacement

Also prove:

```text
A Running
→ desired B

A Stopping
B may start immediately
```

while maintaining:

```text
generation isolation
```

If Layer + Atom already gives this naturally, record it.

---

# 11. Test latest-state coalescing

Scenario:

```text
A
→ B
→ C
```

while A is still stopping.

Expected under sequential policy:

```text
B may be skipped
C starts when admission becomes possible
```

Measure whether Atom naturally recomputes latest state or whether custom scheduling is required.

---

# 12. Test startup failure

Provider startup fails:

```text
Language Failed
```

Expected:

```text
Diagnostics never starts
```

The system must make failure queryable.

Compare models:

### Effect Atom

Potentially:

```text
AsyncResult.Failure
```

### Reconciler

```text
LifetimeStatus.Failed
```

Evaluate whether the reconciler's explicit status model adds meaningful value or duplicates Atom's result state.

---

# 13. Test same-key retry

Failure:

```text
Language["typescript"] Failed
```

Then retry without changing semantic key.

Required:

```text
same semantic identity
→ fresh physical generation
```

Try idiomatic Atom mechanisms first:

```text
Atom.refresh
AtomResultFn reset/refresh
reactive invalidation
```

Questions:

1. Does refresh produce a clean fresh Scope?
2. Can it enforce sequential cleanup first?
3. Can retry remain generation-safe under dependent resources?
4. Does the caller need retry nonces?
5. Is any custom generic helper required?

If Atom's refresh semantics provide correct same-key replacement, `Controller.retry` may be reducible to a thin wrapper.

---

# 14. Test desire independent of subscribers

This is a key philosophical distinction.

`effect-reconciler` means:

```text
state desires resource
→ resource exists
```

Atom commonly means:

```text
resource is mounted / observed / depended upon
→ resource exists
```

Construct a scenario where a resource must remain alive despite no UI or consumer currently reading it.

Examples:

```text
background workspace watcher
device connection
collaboration session
language server
```

Try:

```text
Atom.mount
keepAlive
root desired atom
```

Measure the amount of glue required to turn demand-driven Atom semantics into state-desired semantics.

If this is trivial, the distinction is weak.

If it recreates a reconciliation controller, that is important evidence.

---

# 15. Test service access from finite Effects

Existing migrations found an adoption issue:

```text
a finite Command needs to use a service owned by a live reconciled lifetime
```

The current workaround uses an external holder `Ref`.

Test whether Layer + Atom naturally solves this through:

```text
AtomRuntime
runtime.fn
runtime.atom
runtime.use / service access
```

Compare with a possible reconciler primitive such as:

```ts
controller.run(ref, effect)
```

Required safety:

```text
Effect runs under exact live generation Scope
generation closes
→ Effect is interrupted
```

Do not accept returning a raw service that can outlive its generation.

This experiment may reveal that AtomRuntime already provides the structured-borrow behavior missing from `effect-reconciler`.

---

# 16. Compare incremental reactivity

Current `effect-reconciler` supports:

```ts
deps: (state, owner) => ...
```

with the contract:

```text
if deps unchanged
selector must return same keys
```

This is unchecked and can become incorrect if declared wrongly.

Atom tracks dependencies automatically through `get`.

Run a benchmark with:

```text
10,000 Documents
one document changes
```

Measure:

```text
selector executions
hash operations
atom recomputations
lifetime starts/stops
commit/write latency
convergence latency
```

Decision rule:

> If Atom provides correct automatic incrementality at comparable cost, remove or de-emphasize manual Binding `deps`.

---

# 17. Compare observed-state behavior

Current Reconciler:

```text
observes
+
Binding.observe
+
SubscriptionRef
```

Atom naturally allows reactive dependencies inside a long-lived graph.

Reimplement one existing `observes` scenario using Atom.

Measure:

```text
API surface
lines of glue
lifecycle correctness
coalescing behavior
type safety
```

Decision rule:

> If Atom expresses this directly, `observes` should probably not remain a core Reconciler primitive.

---

# 18. Compare nested feature modularity

Current Reconciler offers nested Controllers to isolate:

```text
Definition
Binding
state shape
identity space
```

Try expressing the same modular feature as:

```text
Atom subgraph
+
Layer runtime
```

Questions:

1. Can independent feature atom graphs compose without sharing identity space?
2. Can they inherit parent services safely?
3. Does disposal happen structurally?
4. Is there still a need for nested Controller semantics?

If Atom composition solves this more naturally, consider removing nested Reconciler from the stable direction.

---

# 19. Metrics to collect

For each implementation record:

## Application code

```text
whole scenario SLOC
coordination SLOC
lifecycle-specific Model state
lifecycle-specific Messages/events
manual invalidation rules
manual owner checks
manual readiness checks
manual retry state
```

## Generic infrastructure

```text
new helper SLOC
new concepts
new runtime mutable state
custom scheduling logic
custom dependency indexes
```

## Correctness

Count how many invariants require custom code:

```text
ownership closure
provider invalidation
generation isolation
late-start suppression
sequential finalization
overlap
latest-state coalescing
same-key retry
failure admission blocking
```

## Performance

Record:

```text
update/commit p50
update/commit p95
convergence p50
convergence p95
memory
allocations if practical
selector / atom evaluations
starts
stops
```

Use:

```text
100
1,000
10,000
```

desired children where practical.

---

# 20. Compare four architectures explicitly

The final report should compare:

```text
A. direct Effect + manual controller

B. current effect-reconciler

C. Layer + Atom + application glue

D. Layer + Atom + smallest generic reconciliation helper
```

This is more useful than only comparing current Reconciler to Layer + Atom.

The key question is whether architecture D collapses into:

```text
current Reconciler
```

or into something much smaller.

---

# 21. Identify the irreducible kernel

After the experiments, classify every current Reconciler feature.

## Likely Effect-owned

Candidate features to delegate to Effect if experiments confirm:

```text
service dependency graph
Context construction
Layer memoization
reactive dependency tracking
incremental recomputation
subscriptions
change notification
reactive state observation
UI binding
effect-backed reactive results
```

## Potential Reconciler-owned

Candidate irreducible semantics:

```text
state-desired existence
owner-relative semantic identity
exact physical owner-generation closure
sequential finalization-before-replacement
overlap replacement policy
latest-desire coalescing
generation-safe dependent invalidation
coherent lifetime-generation inspection
```

Only keep features that survive this classification.

---

# 22. Prototype a rebased architecture

If Layer + Atom covers most machinery but misses some lifecycle guarantees, build an experimental rebase.

Target conceptual architecture:

```text
Application state
        ↓
      Atom
        ↓
desired keyed identities
        ↓
small reconciler policy
        ↓
dynamic Layer generations
        ↓
Effect Scopes
```

Responsibilities:

### Atom

```text
state reactivity
dependency tracking
incremental invalidation
subscriptions
UI integration
```

### Layer

```text
capability graph
Context
resource construction
shared service memoization
```

### Reconciler

```text
semantic desire
physical generation ownership
replacement ordering
coalescing
generation safety
```

Measure whether this substantially reduces:

```text
controller implementation SLOC
public API
tests
diagnostics machinery
custom mutable state
```

---

# 23. Challenge the `requires` API

The current API explicitly declares:

```ts
requires: {
  settings: Settings,
  language: Language
}
```

Test whether Layer can infer/encode these requirements instead.

Potential future direction:

```ts
define.one("Diagnostics", {
  layer: key => Diagnostics.layer(key)
})
```

or:

```ts
start: key =>
  Layer.build(...)
```

Questions:

1. Can dynamic provider-family identity be mapped to Layer requirements?
2. Does Layer know *which keyed provider generation* is intended?
3. Is explicit family-level `requires` still necessary for generation invalidation?
4. Could the Reconciler compile provider families into the Layer graph automatically?

Do not remove `requires` until generation identity is proven equivalent.

---

# 24. Challenge Controller observability

Compare:

```text
Reconciler.status
Reconciler.snapshot
Reconciler.changes
Reconciler.failures
Reconciler.events
```

against:

```text
Atom AsyncResult
AtomRegistry nodes
Atom subscriptions
Layer/Scope lifecycle
```

Classify each Reconciler API as:

```text
application-authoritative
diagnostic convenience
duplicated by Atom
needed only because Reconciler owns hidden runtime state
```

If rebasing makes runtime state naturally observable through Atom values, shrink Controller.

---

# 25. Challenge supervision

Current Reconciler supervision handles startup failure across physical generations.

Compare with:

```text
Atom.refresh
Effect.retry
Schedule
AsyncResult
```

Keep custom supervision only if it uniquely coordinates:

```text
new generation
+
old generation cleanup
+
owner/provider admission
+
semantic identity preservation
```

Avoid duplicating Effect retry policy.

---

# 26. Update documentation only after the experiment

Do not immediately rewrite the README to claim that Layer + Atom replaces or validates the design.

Add a temporary development note/issue:

```text
Investigating relationship with Effect Layer + Atom
```

Then update the architecture based on measured results.

The final README should eventually state clearly:

```text
what Layer owns
what Atom owns
what effect-reconciler uniquely owns
```

---

# 27. Ask the Effect community with concrete evidence

The author's suggestion to post in Discord is worth following, but do it after building the comparison far enough to ask a precise question.

Avoid:

> Is this library useful?

Prefer:

> I implemented the same keyed dynamic resource topology using both
> `effect-reconciler` and `Layer + Effect Atom`.
>
> Layer + Atom handles X/Y/Z directly. The remaining custom semantics are
> sequential generation replacement, owner-generation closure, and
> latest-desire coalescing.
>
> Is there an existing Effect primitive/pattern that already guarantees those?

Include:

```text
minimal code snippets
conformance tests
benchmark table
specific failing Layer+Atom scenarios
```

This gives maintainers something concrete to correct.

---

# 28. Decision framework

## KEEP

Keep the current standalone runtime if Layer + Atom:

- requires a controller of comparable complexity;
- cannot provide exact owner-generation safety cleanly;
- cannot provide sequential replacement without recreating the runtime;
- cannot preserve provider-generation isolation without explicit generation bookkeeping;
- still leaves substantial application coordination that `effect-reconciler` removes.

## SHRINK

Shrink the package if Layer + Atom covers:

```text
reactivity
incrementality
observation
UI integration
dependency tracking
service graph
```

while only a small custom generation/replacement kernel remains.

Likely result:

```text
smaller public API
smaller controller
fewer diagnostics APIs
fewer custom caches
Layer-native family definitions
Atom-native control state
```

## REBASE

Rebase the implementation on Layer + Atom if the semantics remain valuable but the custom machinery is mostly redundant.

Target:

> `effect-reconciler` becomes a policy/compiler over Effect primitives rather than a parallel runtime.

This is currently the most interesting possible outcome.

## STOP

Stop the standalone project if:

- Layer + Atom + a very small helper reproduces all important semantics;
- the helper is easy to write per application;
- sequential/generation guarantees turn out to already exist in Effect;
- the current Reconciler adds mostly vocabulary and observability around existing Effect mechanisms.

---

# 29. Minimum decisive test matrix

Before deciding, the Layer + Atom baseline must pass all of:

```text
[x] equal-key retention
[x] changed-key replacement
[x] owner-relative identity
[x] dynamic many add/retain/remove
[x] owner closure
[x] late startup suppression
[x] provider-only invalidation
[x] immutable provider-generation capture
[x] no generation mixing
[x] sequential finalization-before-replacement
[x] overlap replacement
[x] A → B → C coalescing
[x] failed provider blocks dependents
[x] same-key retry
[x] state-desired lifetime survives without external subscribers
[x] finite Effect can safely use live dynamic capability
[x] 1k / 10k selective churn
```

Any failed item should be documented with:

```text
why Layer + Atom does not provide it
minimum generic code required to add it
whether that code recreates existing Reconciler machinery
```

---

# 30. Immediate execution order

## Step 1

Freeze feature expansion and open an architectural experiment branch.

## Step 2

Implement the editor DAG using Layer + Atom with no reusable helper beyond trivial utilities.

## Step 3

Port the Reconciler conformance scenarios to the Layer + Atom implementation.

## Step 4

Identify failures.

## Step 5

Add the **smallest possible generic helper** required to make each failure pass.

## Step 6

Measure final generic helper size and complexity.

## Step 7

Compare:

```text
current Reconciler
vs
Layer + Atom + helper
```

## Step 8

Prototype a rebased Reconciler if the helper contains a coherent kernel.

## Step 9

Post the concrete findings to Effect Discord / maintainers.

## Step 10

Make KEEP / SHRINK / REBASE / STOP decision.

---

# Next milestone definition

The next milestone is complete when:

```text
Layer + Atom editor DAG exists
+
all relevant Reconciler conformance scenarios have been attempted
+
every semantic gap is documented
+
minimum generic glue is implemented
+
code-size / correctness / performance comparison exists
+
the irreducible lifecycle kernel is identified
```

The decision question is:

> **After using Effect's own Layer and Atom machinery, what semantics remain that are both important and expensive enough to deserve `effect-reconciler`?**

That answer should determine the project's architecture before any further feature investment.
