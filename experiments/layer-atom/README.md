# Layer + Atom rebase experiment

This directory implements the SHRINK / REBASE experiment proposed in
[`docs/feedback.md`](../../docs/feedback.md). It uses Effect 4's current
`Layer`, `Atom`, `AtomRegistry`, `Scope`, `Context` and `Effect` APIs directly.
It does not call `effect-reconciler`.

This is evidence, not a replacement API. No package architecture has been
changed on the strength of one experiment.

## Implementations

### C — direct Layer + Atom

[`direct.ts`](direct.ts) is the idiomatic no-helper baseline (55 code SLOC):

```text
model Atom
→ dynamic Layer selected by AtomRuntime
→ mounted Context
```

Its characterization tests establish three important facts:

1. AtomRuntime builds the Layer selected by reactive state.
2. A state change starts the replacement Layer without awaiting a blocked old
   finalizer. This is valid overlap, but not sequential replacement.
3. Merely writing state starts nothing. One application-owned root mount is
   enough to make the resource state-desired; under the default registry the
   built runtime remains cached until registry disposal.

This baseline is intentionally allowed to fail reconciler parity. The failures
are the experiment's useful output.

### D — Layer + Atom + lifecycle helper

[`editor.ts`](editor.ts) implements the full editor DAG:

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

Diagnostics captures Settings + Session + Workspace + Language + Document.
```

Atom owns model reactivity and derived desire. Layer owns typed capability
construction, Context assembly inside each family Layer, scoped acquisition and
release. The added helper owns physical slots, generations, owner links,
provider bindings, finalization boundaries, replacement ordering and the
latest-desire wake loop.

The file is 882 code SLOC including services, probes, Layer definitions, Atom
selectors, the concrete topology and its public test harness. The lifecycle
portion is concentrated around `slotFor`, `closeInstance`, `beginStop`,
`retire`, `start`, `invalidate`, `admit` and `pass`. It is smaller than the
current generic runtime's 1,332 internal code SLOC, but it supports one fixed
topology and omits Definition/Binding compilation, snapshots, events,
diagnostics, supervision schedules, observations, nested controllers and the
public type algebra. It therefore is **not** evidence of an 882-vs-1,332
library win.

## Experimental characterization coverage

Run:

```sh
npm run experiment:layer-atom
```

The helper currently covers the following targeted scenarios. This checklist
is **not** a claim of full package parity: experimental tests run separately
from package conformance and prepack, and the prototype omits supported public
APIs and validation paths.

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
[x] finite Effect can safely use a live dynamic capability
[x] 100 / 1k / 10k selective churn
```

The direct baseline does **not** pass sequential replacement or state-desired
existence without a root mount. `Atom.refresh` invalidates reactive work, but
its cancellation path does not await an asynchronous Layer finalizer before
starting the replacement. Adding the finalization deferred, slot retirement
set and wake loop is what makes these characterization tests pass.

### Startup-completion race

Atom desire publication is synchronous while lifecycle reconciliation is
asynchronous. A startup can therefore finish after new desire was published but
before the pass that retires its stale live indexes. Checking only `Starting`
and slot-current state incorrectly lets that completion publish `Running`.

Both experimental kernels now validate completion directly against the latest
desired identity, physical owner and captured provider generations. The late
startup test publishes replacement desire and releases the blocked startup
immediately—without first waiting for a retirement event. The same exact race
is permanently covered in the package conformance suite via a test-only
commit-before-wake hook. The current kernel applies the same recursive
owner/provider validation before publishing either startup success or failure.

## Layer findings

### What Layer removes

- Family startup can be expressed as ordinary typed Layers.
- Scope-bound acquisition and release need no reconciler-specific resource API.
- Capability construction and Context values remain Effect-native.
- Within one static Layer graph, memoization and sharing work as designed.

### What Layer does not identify

A Layer requirement says which **service tag** is needed. It does not say which
keyed physical provider generation should satisfy a dynamic dependent. The
experiment still has to select exact `Settings#n` and `Language#n` generations,
capture their Contexts at admission and retire Diagnostics when either binding
changes.

Rebuilding the dynamic Layer is an invalidation signal, not a proof of:

```text
old generation finalization complete
→ latest desired replacement may now acquire
```

Layer therefore does not remove explicit dynamic provider metadata by itself.
A future Layer-native family API could replace `start => Context` with
`layer(key)`, but it cannot remove `requires` until keyed generation selection
is represented somewhere else.

## Atom findings

### What Atom removes or weakens

- Derived desire and structural equality are direct Atom values.
- `Atom.family` provides structural keyed memoization; including the owner path
  in its argument gives owner-relative identities.
- Reactive dependency tracking makes manual Binding `deps` unnecessary for
  state computation.
- AsyncResult is a credible queryable startup result.
- Atom subscriptions can replace change prompts and UI status mirrors when the
  authoritative runtime state itself is represented as atoms.
- A running feature can observe state through Atom dependencies without a
  bespoke `observes + Binding.observe + SubscriptionRef` declaration.
- `AtomRuntime.fn` provides the structured-borrow behavior finite Effects need:
  the characterization test proves an in-flight function is interrupted when
  its captured runtime Layer changes.
- Independent feature graphs compose more naturally as Atom subgraphs than as
  nested Controllers when they do not need cross-graph physical ownership.

### What Atom does not remove

- `Atom.family` memoizes atom objects; it does not reconcile a changing set of
  mounted family members.
- Reactive invalidation does not encode physical owner-generation closure.
- Refresh does not provide sequential finalization-before-replacement.
- A provider result does not by itself identify the exact physical generation
  captured by a dependent.
- Dynamic many still needs a root process that diffs desire and owns mounts.
- `AtomRuntime.fn` solves borrowing *once the correct runtime atom is known*;
  routing a call to the exact current member of a dynamic keyed family remains
  a generation-selection problem. `editor.runDocument` is the helper version
  of that routing and has the same interruption guarantee. Returning the raw
  service value would remain unsafe.

The state-desired/demand-driven distinction is therefore mixed. A single root
mount is trivial. Maintaining the dynamic set of mounts, replacement slots and
owner/provider generation edges is the controller-shaped part.

## Retry and supervision

The hierarchy remains:

```text
Effect.retry inside Layer acquisition
→ another attempt in one startup generation

Atom refresh / Controller-style retry after Failure
→ a new physical generation
```

AsyncResult makes failure queryable and Atom refresh is a useful trigger, but
refresh alone has overlap semantics. Same-key retry with sequential cleanup,
owner/provider admission and dependent invalidation still needs the lifecycle
helper. Custom supervision is justified only as scheduling around that exact
transition; retry policy itself should stay in Effect `Schedule`.

## Observability classification

| current API | experiment classification |
| :--- | :--- |
| `status` | application-authoritative; AsyncResult can represent most of it if every physical slot is an atom |
| `snapshot` | still needed for one coherent view of overlapping/Stopping physical generations |
| `changes` | duplicated when authoritative state is directly subscribable as Atom values |
| `failures` | convenience over AsyncResult transitions |
| `events` | diagnostic convenience; not supplied by Atom/Layer lifecycle values |
| `diagnostics` | needed only while hidden generation machinery remains |

A rebase should attempt to make slot status an Atom value first, then remove
streams that merely announce that value changed.

## Scale measurement

Run:

```sh
npm run experiment:layer-atom:bench
```

Recorded 2026-08-29 on Node v24.18.1, darwin arm64, Apple M5 Max. Five samples
per transition after one warmup:

| documents | scenario | write p50 | write p95 | converge p50 | converge p95 | atom evals | starts | stops |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | build | 0.29 | 0.29 | 5.93 | 5.93 | 6 | 204 | 0 |
| 100 | equivalent | 0.01 | 0.01 | 0.01 | 0.01 | 5 | 0 | 0 |
| 100 | one document changed | 0.01 | 0.02 | 0.20 | 0.22 | 6 | 2 | 2 |
| 100 | settings replaced | 0.01 | 0.02 | 1.76 | 2.55 | 6 | 101 | 101 |
| 1,000 | build | 0.13 | 0.13 | 26.20 | 26.20 | 6 | 2,004 | 0 |
| 1,000 | equivalent | 0.00 | 0.01 | 0.01 | 0.01 | 5 | 0 | 0 |
| 1,000 | one document changed | 0.01 | 0.02 | 0.50 | 3.43 | 6 | 2 | 2 |
| 1,000 | settings replaced | 0.02 | 0.03 | 17.17 | 22.76 | 6 | 1,001 | 1,001 |
| 10,000 | build | 0.46 | 0.46 | 209.22 | 209.22 | 6 | 20,004 | 0 |
| 10,000 | equivalent | 0.00 | 0.01 | 0.06 | 0.07 | 5 | 0 | 0 |
| 10,000 | one document changed | 0.01 | 0.03 | 4.27 | 4.79 | 6 | 2 | 2 |
| 10,000 | settings replaced | 0.04 | 0.06 | 177.95 | 194.07 | 6 | 10,001 | 10,001 |

The write column is not directly comparable with Reconciler `commit`. Atom
publishes a compact Desired value and the helper performs its O(N) map walk in
`converge`; current Binding evaluation constructs all desired nodes before
`commit` returns. The meaningful results are:

- automatic desire computation stays at five or six atom evaluations;
- selective churn is exact and scale-invariant;
- one-document convergence still scales with the helper's full live-map walk
  (0.20 → 0.50 → 4.27 ms);
- provider replacement is dominated by the required N generation restarts.

Atom removes unchecked selector dependency declarations. It does **not** make
the generation reconciliation sweep disappear. A rebase should move compact
reactive dirty sets into the lifecycle helper rather than compare the write
columns as though the boundaries were identical.

## Four-architecture comparison

| architecture | evidence | result |
| :--- | :--- | :--- |
| A. direct Effect + manual controller | `examples/foldkit/before` | Correct with application lifecycle state and 143 coordination SLOC for that scenario |
| B. current Reconciler | `examples/foldkit/after`, `src/internal` | Generic parity, 62 application coordination SLOC; 1,332 internal code SLOC plus public modules |
| C. Layer + Atom + application glue | `direct.ts` | 55 code SLOC, but overlap-only replacement and mount/registry-driven existence |
| D. Layer + Atom + lifecycle helper | `editor.ts` | Targeted lifecycle matrix for one topology; 882 code SLOC total, with controller-shaped generation machinery still present |
| E. Atom → kernel → Layer REBASE | `rebase/` | Generic 540-SLOC lifecycle kernel; lazy Atom status, no duplicated notification/controller surfaces, exact 10k churn |

Architecture D does not collapse to the 55-line baseline. It also does not yet
prove the current standalone runtime should remain unchanged: Atom clearly
subsumes manual incrementality, observation and much UI notification work, and
Layer is a better family construction boundary.

## REBASE prototype

The provisional direction is now implemented in [`rebase/kernel.ts`](rebase/kernel.ts)
and [`rebase/editor.ts`](rebase/editor.ts):

```text
Model Atom
→ derived Atom<DesiredNode[]>
→ generation/replacement kernel
→ Layer family generations
→ lazy Atom status values
```

The generic kernel is 540 code SLOC. The editor policy adapter is 185 code SLOC,
excluding the shared service tags, probes and Layer definitions in `editor.ts`.
For comparison, the current generic runtime internals are 1,332 code SLOC. That
is meaningful evidence of SHRINK, but not yet an apples-to-apples library
replacement: the prototype deliberately omits the Definition/Binding compiler,
rich validation, schedules, diagnostic events and compatibility APIs.

Eleven rebased tests cover the targeted lifecycle subset, including
owner-relative identity, exact two-provider capture, both replacement policies,
coalescing, failure/retry, lazy reactive status and scoped finite work. They do
not establish full compatibility with the package conformance suite. The rebased scale
benchmark also passes exact churn at 10,000 documents. A representative run:

| documents | scenario | write p50 | converge p50 | starts | stops |
| ---: | :--- | ---: | ---: | ---: | ---: |
| 10,000 | equivalent | 3.07 ms | 0.09 ms | 0 | 0 |
| 10,000 | one document changed | 3.74 ms | 5.46 ms | 2 | 2 |
| 10,000 | settings replaced | 6.78 ms | 196.09 ms | 10,001 | 10,001 |

Two implementation details proved essential:

1. asynchronous startup/finalizer completions must be batched before the next
   full desired scan, or a large completion wave causes O(n²) reconciliation;
2. semantic `Ref` values must be interned by owner and key. Applying structural
   hashing to freshly allocated full owner paths caused a 10k run to exhaust
   the heap. Atom remains authoritative for desire and status, but efficient
   canonical identity remains part of the irreducible kernel.

The prototype removes change/failure streams, observation plumbing, Binding
`deps`, nested controllers and diagnostic allocation from its core. Status is
an authoritative Atom created only when requested; snapshots remain a physical
generation inspection operation. Structured finite work is still routed by
the kernel because selecting the exact current keyed generation is the part
`AtomRuntime.fn` cannot infer.

## Irreducible kernel found

The experiment supports keeping these semantics somewhere:

```text
state-desired dynamic membership
owner-relative semantic identity
physical owner-generation closure
exact provider-generation capture
sequential finalization boundary
optional overlap
latest-desire coalescing
same-key failed-generation replacement
routing to the exact current keyed generation
coherent inspection of overlapping generations
```

It supports delegating these to Effect:

```text
Layer: Context and scoped capability construction
Atom: state reactivity, dependency tracking, subscriptions, observed state,
      structured runtime functions, UI integration and most change notification
Effect/Schedule: retry attempts and backoff policy
```

## Implemented direction

**REBASE satisfies the prototype-level SHRINK criterion. Keep the stable package
implementation in place until the remaining type-safety/compiler questions are
resolved.**

The prototype demonstrates that Atom-owned desire and status plus Layer-owned
construction can remove duplicated Controller surfaces while retaining the
hard lifecycle guarantees in a 540-SLOC generic kernel. It also confirms that
identity interning, physical slots, generations, finalization boundaries and a
coalesced wake loop cannot simply be delegated away.

The next gate is no longer another lifecycle proof. It is a typed family
compiler that preserves Effect environment inference without restoring the
removed Binding/Controller complexity. `RefCache` already canonicalizes
owner-relative identities with Effect Equal / Hash semantics for structural
keys; the unresolved constraint is the generic kernel's dynamic Context
assembly and resulting loss of Layer environment inference. Do not replace
`src/` until that compiler passes the same matrix and package compatibility
tests.

## Question for Effect maintainers

Concrete question produced by the experiment:

> A dynamic Layer selected by AtomRuntime correctly invalidates and rebuilds,
> but starts the replacement before an asynchronously blocked old Layer
> finalizer completes. The lifecycle helper adds a per-semantic-slot retiring set,
> a completion Deferred and a latest-desire wake loop. Is there an existing
> Layer/Atom primitive that provides finalization-before-latest-replacement
> while retaining exact keyed provider-generation capture?

If there is, the remaining kernel can shrink substantially. If there is not,
this experiment identifies the boundary the package should own.
