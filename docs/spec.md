# effect-reconciler — specification

**State-reconciled keyed Effect lifetimes.**

> A Reconciler compiles a static architecture of keyed Effect lifetime
> families, lifetime ownership and capability dependencies. A Binding maps
> immutable control state into desired keys for those families. Each committed
> state atomically replaces desired state, and the Controller asynchronously
> converges live Effect Scopes and capability bindings toward that desire.

This document is the contract of the v0 kernel, the reasoning behind it (§13),
and what has been proven (§14). The conformance suite in `test/` is the
executable form of that contract; where the two disagree, the suite wins and
this document is wrong.

## 1. What it is

### 1.1 The problem

Effect already provides what long-lived runtimes execute on: `Scope`, `Fiber`,
`Layer`, `Context`, `Stream`, interruption, finalization, `RcMap`, `LayerMap`.
What applications keep rewriting is the coordination around them — translating

```text
current control state  →  which keyed Effect lifetimes should exist
```

while handling ownership, readiness, replacement, cancellation, dynamic
capability dependencies, rapid state churn, startup failure and
resource-generation isolation.

Authenticated sessions, workspaces, device connections, language servers,
document runtimes, collaboration sessions, plugin hosts, background workers,
tenant-specific services and dynamically selected databases all have that
shape. The recurring problem is not resource acquisition; it is deciding which
resources should currently exist, and surviving the races on the way there.

### 1.2 Non-goals

`effect-reconciler` does not replace `Effect`, `Scope`, `Layer`, `Context`,
`Fiber`, `Stream`, `RcMap` or `LayerMap`. It coordinates them. Effect answers
how work executes, is interrupted and finalized; the Reconciler answers which
lifetime should exist, who owns it, which provider instances it must use, when
it became obsolete, and which desired replacement starts next.

Everything it does remains expressible by hand with ordinary Effect. It earns
its place only by removing application-written lifecycle predicates, owner
tracking, readiness coordination, provider invalidation and race-condition
tests (§16).

## 2. The public model

Three concepts are public:

```text
Definition        the static architecture, independent of any state type
Binding<State>    pure selectors from one control-state type into desired keys
Controller<State> commit, observe, converge
```

Application code also holds opaque family handles returned by the Definition
builder. Internally the runtime maintains a lifetime ownership tree, a
capability dependency DAG, desired instances and live physical generations —
its *dynamic Effect topology*. That vocabulary is architectural, never
required of a user, and never exposed (§9.4, §13.2).

```ts
const controller = yield* Reconciler.make(Bound)
yield* controller.commit(state)
```

## 3. Definition

A Definition declares the reusable runtime architecture: which families exist,
their cardinality, ownership, capability requirements, startup and replacement
policy. It does not mention any application state type.

### 3.1 Families and cardinality

`define.one` admits at most one keyed instance per owner instance; the instance
may also be absent. `define.many` admits zero or more independently keyed
instances per owner, each reconciled on its own.

```text
Session[alice]                 Workspace[acme]
└── Workspace[acme]            ├── Document[foo]
                               ├── Document[bar]
                               └── Document[baz]
```

The string label is human-readable; the handle object is the identity (§5.4).

### 3.2 Semantic keys

A family declares no key descriptor. The key type is inferred from `start`, and
identity is `Equal.equals` with `Hash.hash` — the convention `RcMap` and the
Effect collections already use.

```ts
define.one("Session", { start: (userId: string) => ... })
```

Primitives work as themselves. Structural keys are ordinary values — a plain
object, an array, an Effect `Data` value — because Effect compares and hashes
all of them structurally. Nothing is serialized, so nothing has to be escaped.

The rule for what belongs in a key is semantic:

> Put a value in the semantic key only when changing it should create a
> different semantic lifetime.

Two further rules are part of the contract and are **not checked at runtime**:

- **Keys are immutable.** Identity is cached per key value, so mutating a key
  after it has been desired corrupts the identity it was admitted under.
- **Keys compare stably.** A reference-compared value — a plain function, or
  anything wrapped in `Equal.byReference` — is a valid key exactly when the
  Binding yields the same value on every commit, and churns the lifetime on
  every commit when it does not.

`start`'s parameter must be annotated so the key type can be inferred;
`(_: null)` names a family whose key carries no information. An un-inferable
key type is a compile error rather than `unknown`, which would let a Binding
desire anything at all for that family.

### 3.3 Ownership

Every family has exactly one owner: the root, or another family.

> A child may never outlive the physical owner instance beneath which it was
> admitted.

Obsolescence is therefore structural: if a Session becomes obsolete, its
Workspaces and their Documents do too, without any child selector restating the
ancestor condition (§11).

### 3.4 Capability requirements and provider resolution

Ownership means "cannot outlive". `requires` means "cannot run without".
Requirements are static and named, so they can be added without disturbing
positional arguments:

```ts
requires: { settings: Settings, language: Language }
```

Requirements may form a DAG but never a cycle. A requirement resolves either to
an **ancestor** instance, or to the unique `one` instance owned by an ancestor
or by the root. A `many` provider is rejected as ambiguous when the Definition
is compiled: with several candidates there is no defensible answer to "which
one?" (§13.7).

Ownership must not be used merely to reach a service. Settings does not become
an ancestor of Diagnostics just to supply its capability; that is what the two
separate relations are for.

### 3.5 Replacement policy

Policies are constructors, not string enums:

```ts
Replacement.sequential()   // default
Replacement.overlap()
```

Their semantics are §7.

### 3.6 Validation at creation

`Reconciler.make` compiles and validates the Definition and the Binding, and
fails with tagged errors (§10) for unknown owners, unknown requirements,
ownership cycles, capability cycles, ambiguous or unresolvable providers, and
handles belonging to another Definition. After a successful compile, internal
reconciliation trusts these invariants.

## 4. Binding

A Binding maps one control-state type into desired instances of a Definition.

### 4.1 Selectors are pure

Selectors receive state and a desired owner reference and return desired keys.
They must not run Effects, read mutable runtime state, acquire resources,
inspect physical generations or dispatch messages. They describe desire; they
do not reconcile.

### 4.2 Root, owned and many selectors

```ts
session:   bind.one(Editor.Session, (model) => model.user),
workspace: bind.one(Editor.Workspace, (model, owner) =>
             model.workspacesByUser[owner.key]),
documents: bind.many(Editor.Document, (model, owner) =>
             model.openDocuments[owner.key])
```

An owned selector receives the semantic owner reference (§5.2) — its key and
its own owner up to the root — not a Scope, a live object, a physical
generation or a runtime service. Selectors are evaluated once per relevant
desired owner identity, which is what makes desired identity owner-relative.

A commit produces one coherent desired snapshot: selectors within a commit
never observe different versions of the state.

### 4.3 Validation

TypeScript rejects most binding mistakes before runtime: a `one` handle used
with `bind.many` and the reverse, wrong key types, an owner-relative selector
typed against the wrong owner, a foreign handle, a missing or duplicated
binding. What can only be discovered dynamically — duplicate equal keys from a
`many` selector, an invalid selector result, a selector that throws — fails the
commit and leaves the previous desire authoritative (§8.2, §10).

### 4.4 Reuse across control planes

> Static Effect architecture must be reusable independently of control-state
> representation.

One Definition binds to a Foldkit Model, to a daemon's config and to a test
fixture, reusing the same ownership, requirements, startup Effects, replacement
policies and key semantics. Only the selectors change. This is the reason
selectors do not live on the family definitions.

### 4.5 Worked example

The editor topology, which exercises root `one`, nested `one`, nested `many`, a
non-ancestral provider, and both replacement policies:

```text
Application
├── Settings
└── Session
    └── Workspace
        ├── Language
        └── Document × N
            └── Diagnostics

Settings ──────┐
Language ──────┼──► Diagnostics
Workspace ─────┘
```

```ts
const Editor = Reconciler.define((define) => {
  const Settings = define.one("Settings", {
    start: (revision: number) => SettingsRuntime.open(revision)
  })
  const Session = define.one("Session", {
    replacement: Replacement.overlap(),
    start: (userId: string) => SessionRuntime.open(userId)
  })
  const Workspace = define.one("Workspace", {
    owner: Session,
    start: (workspaceId: string) => WorkspaceRuntime.open(workspaceId)
  })
  const Language = define.one("Language", {
    owner: Workspace,
    start: (language: string) => LanguageRuntime.open(language)
  })
  const Document = define.many("Document", {
    owner: Workspace,
    start: (uri: string) => DocumentRuntime.open(uri)
  })
  const Diagnostics = define.one("Diagnostics", {
    owner: Document,
    requires: { settings: Settings, language: Language },
    start: (_: null) => DiagnosticsRuntime.open
  })
  return { Settings, Session, Workspace, Language, Document, Diagnostics }
})
```

`examples/editor.ts` binds this Definition to a Foldkit-style `Model` and to a
daemon `Config` without changing it.

## 5. Identity

### 5.1 Semantic identity

A lifetime's semantic identity is

```text
family handle + semantic key + owner semantic path
```

so `Session[alice] → Workspace[acme]` and `Session[bob] → Workspace[acme]` are
different Workspaces despite the equal key.

### 5.2 LifetimeRef

Every semantic API speaks this one vocabulary:

```ts
interface LifetimeRef<H> {
  readonly family: H
  readonly key: KeyOf<H>
  readonly parent: OwnerOf<H> // a LifetimeRef, or null at the root
}
```

The family handle — not its label — is the identity, since two families may
share a display name. The ownership chain is type-checked, so a reference
cannot name a lifetime the Definition could not produce. References are built
with `Reconciler.ref`, arrive with every failure, and are what `status` and
`retry` take. An owned selector receives one as its owner argument, which is
what lets it distinguish two identical direct-owner keys under different
ancestors.

### 5.3 Physical generations

A physical generation is the running instance behind a semantic identity. Two
generations may share a semantic key — the second admitted because a provider
binding changed (§7.4) — and both may briefly exist while one finalizes.
Generation identity is internal: no public API exposes it, and no numeric
generation counter is part of the contract.

### 5.4 Definition identity

A Definition's identity is a per-call object compared by reference; a family's
identity is its handle object. Neither is a name nor a numeric index, so
handles cannot be confused across Definitions that declare families in the same
order, nor across two duplicate installed copies of the package. Numeric family
ids exist internally, as indexes within one Definition.

## 6. Lifecycle

### 6.1 Admission

A new physical lifetime may be admitted only if, at the admission point:

```text
its semantic desire is still current
its owner is still current and Running
all required providers are still current and Running
the Controller is still open
```

If any condition fails, admission is abandoned. Only Running lifetimes satisfy
requirements or admit children.

### 6.2 Startup

```text
desired → owner ready → providers ready → create Scope → Starting
        → run start → publish capabilities → Running
```

`start` is ordinary Effect. Its Scope is the instance's own, so
`acquireRelease` and `addFinalizer` are tied to the lifetime. Transient retry
inside `start` — `Effect.retry` with a schedule — is invisible to the runtime
and stays one physical generation; only ultimate failure produces `Failed`.

Startup environments are typed. Whatever `start` needs beyond its own Scope,
its ancestors' published capabilities and its required providers' capabilities
is a root-environment requirement, and surfaces on `Reconciler.make`'s
requirement channel — so an unmet capability is a compile error rather than a
runtime miss. Root services (a Logger, a Clock, a Filesystem) live for the
Controller's root Scope and need not become reconciled families merely because
dynamic lifetimes use them. Use ordinary static Layers for
application-lifetime infrastructure and reconciled families when existence or
identity changes with committed state.

### 6.3 Capabilities and generation isolation

A `start` Effect that returns a `Context.Context` publishes it to that
lifetime's children and to its declared dependents. Startup executes against
one immutable capability snapshot — owner capabilities, required provider
capabilities, root environment — captured at admission.

A dependent therefore receives one internally consistent provider set, and
**never rebinds**: a live lifetime is not mutated to point at a newer provider
generation. When a provider is superseded, its dependents are structurally
replaced instead (§7.4, §13.5). Overlapping generations may coexist while one
finalizes, and cross-generation mixing is forbidden: descendants of the new
Session never receive the old Session's services.

### 6.4 States

```text
Starting ──► Running ──► Stopping
   ├──────► Failed
   └──────► Stopping
```

Physical absence after finalization is not a durable public state (§9.1).

### 6.5 Obsolescence and late completion

A physical lifetime stays valid only while its semantic desire, its physical
owner and every bound provider instance remain current. When any of those
fails, it becomes obsolete: it admits no new children or reconciler-owned work,
satisfies no new dependents, loses readiness authority, begins Scope closure
and invalidates its dependents' bindings. If it was still Starting, startup is
interrupted. Finalization then proceeds asynchronously.

Startup that completes after its lifetime became obsolete must not publish
capabilities, become Running, admit children, satisfy requirements or resurrect
the lifetime. The result is discarded and the Scope continues closing. This
applies to obsolescence from a key change, owner invalidation, provider
invalidation and shutdown alike.

### 6.6 Startup failure and the failed slot

Startup failure is a normal runtime condition, not a Controller defect. No
children start, no dependents bind, partially acquired resources finalize, and
the failure becomes observable (§9).

The failed generation is not discarded: it **holds its slot**, in `Failed`,
with its cause. That is what stops the runtime spinning on a failing resource,
and what makes "still broken" distinguishable from "not started yet". The slot
is released when desire changes, or when `Controller.retry` retires the
generation (§9.3). It also means recommitting the same state is
lifecycle-idempotent, and therefore never an implicit retry.

## 7. Replacement

### 7.1 Sequential

```text
obsolete → begin shutdown → finalization boundary reached
         → re-read latest desire → start latest replacement
```

The default. Use it for exclusive devices, locks, single-writer resources and
anything that cannot safely overlap. Under sequential replacement a failed
generation's cleanup also completes before another attempt is admitted, so a
partially acquired exclusive resource is released first.

### 7.2 Overlap

The old lifetime moves to Stopping and the new one may start immediately. Use
it for independent sessions, subscriptions, search runtimes, non-exclusive
workers and replaceable clients. Physical overlap never weakens
capability-generation isolation (§6.3).

### 7.3 Latest-state coalescing

If `A` is Running and state desires `B`, then `C` before `B` can start, the
runtime starts `C`. It converges toward the latest committed state;
intermediate desired states need not become physical runtimes.

### 7.4 Replacement caused by a provider

A lifetime may be replaced while its semantic key is unchanged. If
`Diagnostics[foo]` is still desired but Settings is replaced, the old
Diagnostics generation becomes obsolete and a new one starts against the new
Settings. This is exactly why physical generations are distinct from semantic
identity.

If a required provider fails to start, its dependents stay unadmitted — never
started with a missing, stale or partially initialized provider — until a valid
replacement becomes Running.

## 8. Commit and shutdown

### 8.1 Commit semantics

> `commit(state)` evaluates the Binding against `state` and atomically replaces
> the Controller's authoritative desired snapshot.

A successful commit guarantees that the new desire became authoritative. It
guarantees nothing about resources having started or stopped.

### 8.2 Atomicity and linearization

Publication has no ambiguous outcome:

```text
commit returns   ⇒ the new desire is published, exactly once
commit fails     ⇒ nothing is published; the previous desire stays authoritative
commit interrupted before its publication point ⇒ nothing is published
```

The publication point is a small uninterruptible critical section; lifecycle
work outside it stays asynchronous and interruptible, and an interrupted commit
never wedges it. Concurrent commits are linearized into one total publication
order, and the last one to linearize wins. The API does not promise which
unsynchronized caller that is; callers needing domain ordering serialize their
own state updates.

### 8.3 Latency

`commit` never awaits startup, shutdown, finalizers, replacement, provider
readiness, retry or convergence. Control-state latency is not resource
convergence latency.

### 8.4 Equivalent commits

If two states produce equivalent desired snapshots, no lifecycle churn occurs
merely because the state object changed. Equivalence is semantic — definition
structure, owner-relative identity, key equality — not reference equality.

### 8.5 Commit errors

```text
CommitError = ControllerClosed | InvalidDesiredState(reason)
```

Lifetime startup failures never fail `commit` itself.

### 8.6 Shutdown

`shutdown` stops accepting commits, invalidates all desire, marks every live
lifetime obsolete, closes the root Scope and awaits structured finalization. It
interrupts startups in flight and is idempotent. Closing the Controller's own
Scope shuts it down the same way. After shutdown, `commit` fails with
`ControllerClosed`.

## 9. Observation

```ts
interface Controller<State> {
  readonly commit: (state: State) => Effect<void, CommitError>
  readonly retry: (ref: LifetimeRef) => Effect<void, ControllerClosed>
  readonly status: (ref: LifetimeRef) => Effect<Option<LifetimeStatus>>
  readonly snapshot: Effect<Snapshot>
  readonly failures: Stream<LifetimeFailure>
  readonly changes: Stream<void>
  readonly events: Stream<ReconcileEvent>
  readonly diagnostics: Effect<Diagnostics>
  readonly shutdown: Effect<void>
}
```

There is deliberately no `start`, `stop`, `restart`, `pause`, `rebind` or
`invalidate`.

### 9.1 Status is authoritative

```text
Some(Starting | Running | Failed(cause) | Stopping)
None  — no physical generation for that semantic identity
```

`None` covers both "not desired" and "desired but not admitted": what was asked
for lives in the application's own state, and the runtime reports what exists.
`status` cannot be missed, so any application state derived from a failure must
be recoverable from it.

### 9.2 Failures are a lossy stream

`failures` is a live `Stream` of `LifetimeFailure` — a `LifetimeRef` and the
cause — for reacting, never for remembering. Its delivery contract:

- a failure is published only if the semantic desire is still current when
  startup completes; desire withdrawn during startup means no event;
- a superseded generation's failure is never published;
- with no subscriber attached, nothing is retained;
- subscriptions are Scope-owned;
- the buffer is bounded and drops the oldest events under overflow;
- publication never blocks reconciliation.

Because publication must not hold reconciliation up, the stream must be lossy,
and a lossy channel cannot be the authority (§13.9, §13.12).

### 9.3 Retry

```ts
controller.retry(ref)
```

> If the referenced lifetime is still desired and its current physical
> generation is `Failed`, retire that generation and allow a fresh one to be
> admitted when owner and provider conditions permit.

| situation | behaviour |
| :--- | :--- |
| current generation Failed | retire it; a fresh generation is admitted when conditions permit |
| Starting / Running / Stopping | no-op |
| no longer desired | no-op |
| controller closed | fails with `ControllerClosed` |
| provider unavailable | stays unadmitted until the provider is Running |
| sequential cleanup in flight | waits for the failed generation's finalization boundary |
| called repeatedly | idempotent: one retirement, not one per call |

Retry never changes semantic identity: the key, the owner path and therefore
every descendant's identity remain what the Binding already described. A retry
that fails again reports a fresh failure.

### 9.4 What is never exposed

No semantic API exposes a Scope, Fiber, Context, physical generation, reconcile
revision, live slot or instance, mutable internal map, or internal desired
revision.

### 9.5 Changes are a prompt, not a payload

```ts
controller.changes    // Stream<void>
```

> Emits whenever a reconcile pass left something `status` could report
> different from how it found it.

The signal carries nothing. That is what keeps it on the right side of §9.4:
it names no lifetime, no generation and no transition, so a subscriber learns
only that re-reading is worth doing and must go back through `status` — which
stays the sole authority — to learn anything at all. It exists because
`failures` reports failures and nothing else, so `Starting → Running` had no
notification of any kind and an observer had no option but to poll.

Its contract:

- a pass that moved nothing observable emits nothing, so a converged
  controller is silent — this is the property a timer cannot have;
- transitions coalesce freely: several changes may arrive as one signal,
  because a signal means "read again", and reading again answers for all of
  them;
- a new subscription is prompted once if anything has ever been signalled, so
  an observer cannot be left holding a reading it took before a transition it
  had not yet subscribed for;
- a subscriber is never blocked on, and never blocks reconciliation;
- subscriptions are Scope-owned;
- a transition is signalled when it happens, not when the finalizers it
  triggered complete.

It promises nothing about *when* anything converges. §8.3 still holds: commit
does not await convergence, and an edge that says "something moved" says
nothing about how long anything took or will take.

### 9.6 Snapshots

```ts
controller.snapshot    // Effect<Snapshot>
```

> Every generation the runtime is tracking, read at one instant: a
> `(LifetimeRef, LifetimeStatus)` for each, plus which generation it is and
> which generation owns it, owners before children.

A snapshot adds almost no vocabulary — every entry is the pair a single
`status` call already produces, and the generation tokens beside it say only
*that* two entries are different generations, never anything about what a
generation is — so §9.4 is untouched. What it adds is *coherence*. N separate
`status` calls interleave with N−1 opportunities for the runtime to move
underneath them, and a tree assembled from them can show a child Running
beneath an owner that has already stopped. A snapshot is taken under the same
serialization the reconciler mutates under, so it cannot.

Generations that are `Stopping` appear: they exist, and a view that omitted
them would show a slot as free while the resource in it is still draining.
That is also why an entry carries its own `generation` and its `owner`'s. A
`LifetimeRef` names a lifetime, and under `Replacement.overlap()` one lifetime
has two generations in the same snapshot — so a tree that grouped children by
the owner's reference would draw each child under both of them and show each
generation the other's children. Grouping by `owner` is exact.
`snapshot.get(ref)` answers exactly as `status` did at that instant: for the
generation currently holding the identity, falling back to one still draining.

It is a value, not a view. It does not update; take another when `changes`
says something moved. The cost is one pass over live generations, paid when
asked and never as part of reconciliation; the index behind `get` is built on
the first lookup, so a snapshot that is only rendered never pays for one.

### 9.7 Diagnostics

```ts
controller.events        // Stream<ReconcileEvent>
controller.diagnostics   // Effect<Diagnostics>
```

**Both are for understanding the runtime, never for driving it.** `status` and
`snapshot` remain the only authorities; anything derived from events
recreates the second source of truth §13.9 forbids.

`events` reports what the reconciler did — a commit published, a generation
admitted, started, failed, retired or stopped, a pass completed. A retirement
carries its **reason**: `desire`, `owner`, `provider`, `retry` or `shutdown`.
That reason is the one thing no query can answer, and the reason to have the
channel at all: `status` will say a lifetime is Running, and cannot say that
it restarted because a provider three levels up was replaced.

Its delivery contract is weaker than the failure stream's, deliberately:

- events are **constructed only while something is subscribed**, so a
  Controller nobody is watching does not pay to build a `LifetimeRef` per
  transition;
- delivery begins where the subscription does, and what happened in between
  is not seen — the channel is lossy at its start as well as under overflow;
- the buffer is bounded and drops the oldest;
- publication never blocks reconciliation.

`diagnostics` is cumulative counters plus the current lifecycle census. Unlike
events they are always maintained, being integer increments on paths already
walked, and they are what a health endpoint or the §15 "reconsider when"
trigger actually wants. Every counter is monotone, so two readings subtract to
give a rate — which is why the selector counts are read from the evaluator
under the serialization rather than copied at commit time: evaluation happens
outside it, and a copy taken there can be published out of order by two
concurrent commits. They count evaluation performed, including for a commit
later rejected as invalid; `commits` counts only commits that published.

### 9.8 Supervision

```ts
define.one("Server", {
  supervision: Supervision.restart(
    Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 5 }))
  ),
  start: (key: string) => …
})
```

> A policy for a startup that **failed**: retire the failed generation and let
> a fresh one be admitted, on a schedule.

The default is `Supervision.manual()` and stays the default: a runtime that
retries by itself turns a configuration error into an unbounded stream of
connection attempts nobody asked for.

The narrowness is the design. A lifetime *is* its Scope; once `start` returns
the lifetime is Running, and supervising what happens inside it is what
`Effect.retry` and `Schedule` are already for — inside `start`, where the code
that knows what failed lives. The one thing an application cannot express for
itself is a startup that never completed, in a slot the runtime owns, under a
key the runtime assigned.

A policy does exactly what §9.3's `retry` does, on a schedule instead of on a
call, and changes semantic identity no more than `retry` does. Its schedule is
driven per semantic identity — so it counts *across* generations, which is
the whole point — and resets when the question it was asking changes: the
lifetime reaches Running, its desire is withdrawn, its owner or a provider
replaces it, or `Controller.retry` is called for it. It does not reset on its
own attempts, or it could never reach its own limit.

An exhausted schedule stops. The generation stays Failed, which is a state and
not a dead end: `status` reports it, `retry` still works, changing desire still
replaces it.

### 9.9 Incremental bindings

```ts
bind.many(Document, (state, owner) => state.docsByWorkspace[owner.key], {
  deps: (state, owner) => state.docsByWorkspace[owner.key]
})
```

> Optional: what a selector reads. Unchanged by `Equal.equals` since the last
> commit for the same owner means the selector is not called, and the keys and
> semantic identities it produced are reused.

Binding evaluation is O(N) per commit by default and stays that way (§15). The
cost that is not free is a family owned by a `many` family, whose selector
runs once per live owner: ten thousand documents means ten thousand calls per
commit, most returning what they returned last time.

The contract is the caller's to keep, and the runtime cannot check it:

> If `deps` is unchanged, the selector must return the same keys.

Break it and a lifetime will not start or stop when it should. That is why it
is opt-in, and why correctness never depends on it: writing nothing gives the
full sweep, which is always right.

It is not a free win, and `bench/RESULTS.md` measures both directions. On
unchanged data it is about three times cheaper end to end — mostly through
reused identities, whose hashes are already cached, rather than through the
skipped calls. On data that changes on most commits it is a pessimization: a
miss pays for the `deps` call and a memo probe on top of the work it could not
avoid. And it wants the whole owner chain: a memo keyed by an owner identity
that was itself just rebuilt pays a full structural hash on every probe, which
measured *worse* than no memo at all.

### 9.10 Observed state and nested Reconcilers

```ts
define.one("Workspace", {
  owner: Session,
  observes: Reconciler.observed<WorkspaceModel>(),
  start: Reconciler.nested<string>()(workspaceBinding)
})
```

> A family may declare a *shape of state* it observes. Every Binding must then
> project that shape out of its own state, and each running generation is
> handed a `SubscriptionRef` of the projection — seeded at admission, updated
> on every commit that changes it.

This is the only channel by which a *running* lifetime sees state change
rather than being replaced by it, and it is narrow on purpose. A key change
still replaces the lifetime; desire is still, and only, the keys the selectors
produce. Observation cannot start or stop anything.

A Definition is state-independent (§4.4), so it names a shape rather than the
application's state type. The three ways to get the declaration wrong are all
settled at `Reconciler.make` rather than left to fail inside a startup Effect:
a `start` marked `Reconciler.requiresObservation` on a family that does not
declare `observes` is `ObservationRequired`; a Binding with no projection for
a family that needs one is `MissingObservation`; a projection for a family
that observes nothing is `UnexpectedObservation` (§4.3). The type system
catches the shape of a projection that *is* supplied, and cannot catch the
other two: with no `observes` there is nothing for the observed type to be
inferred from, and the observation parameter's type collapses to `never`,
which every argument type satisfies. Nor is the arity of `start` a witness —
a `start` may declare a second parameter it ignores, and a two-parameter
helper reused as `start` is a valid family — which is why the first of the
three is a declaration by the function's own author rather than something
inferred about it. Projections coalesce to the latest exactly as desire does (§7.3,
§11) and are compared with `Equal.equals`, so a rebuilt state object with an
equivalent projection is not news. An obsolete generation is never updated.

`Reconciler.nested` is the three lines that fall out of it: a lifetime whose
`start` creates a Controller of its own in its own Scope and commits the
projection to it. Its first commit is made inline, so a child Definition or
Binding that cannot accept the initial projection fails *startup* — visibly, as
a Failed lifetime. A later projection that the child's own selectors reject is
an application bug of the class §13.11 calls a defect: it is fatal to the
forwarding loop, and it is logged explicitly, because the host lifetime stays
Running — its own resources are healthy — while its child stops following the
parent's state, and no query can say so. It buys **modularity of the Definition** — a feature ships
its own families, Binding and state shape, and an application mounts the whole
thing under an owner. The child stops when its host stops, by the same
ownership closure that governs every other resource a lifetime holds (§11),
with no second lifecycle to reason about.

The trade is real, which is why it is a helper and not the default. Two
Controllers are two reconcile loops: the child's families cannot own, require
or be required by the parent's; the parent's `status` and `snapshot` say
nothing about the child's lifetimes; and convergence across the boundary is
two asynchronous steps rather than one. Nest a subtree that is genuinely a
separate concern with its own state shape. Do not nest to organize a
Definition that would work flat.

## 10. Errors

Expected failures are Effect-style tagged data carrying the family they
concern, so recovery is ordinary `catchTag` / `catchTags`:

```text
DefinitionError = ForeignOwner | OwnershipCycle | ForeignRequirement
                | CapabilityCycle | AmbiguousProvider | UnresolvableProvider
                | ObservationRequired

BindingError    = ForeignHandle | MissingBinding | MissingObservation
                | UnexpectedObservation | DuplicateBinding
                | CardinalityMismatch

CommitError     = ControllerClosed | InvalidDesiredState
```

`InvalidDesiredState` carries a discriminated reason:

```text
DuplicateDesiredKey | InvalidSelectorResult | SelectorFailed | UnstableKey
```

Message formatting is presentation, not structure. States made impossible by
this package's own invariants are defects, not members of these unions.

## 11. Invariants and non-guarantees

Three structural invariants carry most of the value:

- **Admission** — the four conditions of §6.1 hold at the admission point.
- **Ownership closure** — an obsolete owner makes every physical descendant
  obsolete, without any child binding restating the ancestor condition. This is
  what deletes `if session && workspace && document …` from application code.
- **Dependency invalidation** — an invalid provider binding obsoletes exactly
  its bound dependents. Replacing Settings may replace Diagnostics while
  Document, Workspace and Language are retained.

Unless stated otherwise, the runtime does **not** guarantee sibling startup or
shutdown ordering, reconciliation traversal order, wall-clock convergence
deadlines, fair scheduling among unrelated lifetimes, materialization of every
intermediate desired state, one physical generation per commit, one event per
internal transition, stable generation or revision numbers, or global finalizer
ordering beyond Scope semantics. Depending on any of these is depending on an
implementation detail.

## 12. Relationship to Effect and Foldkit

### 12.1 Scope, Context, Layer

Scope remains the lifetime model, Context the capability model, and Layer the
way to build application-lifetime infrastructure. A lifetime's Scope is an
ordinary Effect Scope; its published capabilities are an ordinary `Context`.

### 12.2 Layer interoperability

A lifetime may build a Layer in its own instance Scope, which is preferable to
inventing Reconciler-specific Layer semantics:

```ts
start: (key) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    return yield* Layer.buildWithScope(makeLayer(key), scope)
  })
```

A `Reconciler.fromLayer` helper may follow if repeated integration proves
cumbersome — after real usage evidence, not before.

### 12.3 RcMap and LayerMap

```text
RcMap / LayerMap:    a resource exists while referenced
effect-reconciler:   a resource exists while desired and admissible
```

Both solve keyed resource lifetimes; only the trigger differs. The
implementation may use them internally, and the public abstraction should not
duplicate what they already do.

### 12.4 Foldkit

Foldkit is a natural control plane: `Message → update → committed Model`, and
the Model goes to the View, to Commands, and to `controller.commit`. The
adapter's obligation is narrow:

> Only committed Models are passed to the Reconciler, and in the same
> serialized order as Foldkit's Model transitions.

The Message loop must not await convergence. Two further boundaries matter:

- **Event versus state causality.** "Because X happened, run this finite
  Effect" is a Command. "While the committed state desires identity X, maintain
  this lifetime" is the Reconciler.
- **Stale outputs.** Cancellation cannot retract a Message already dispatched.
  Generation safety protects runtime execution; reducer-level identity or
  version validation protects committed domain state.

Runtime status is not application state. If the UI needs `WorkspaceReady` or
`LanguageServerUnavailable`, the lifetime should dispatch a semantic Message
and let `update` decide, rather than the View reading `Starting`/`Running`
directly.

## 13. Design decisions

Why the runtime is shaped this way: what each decision rules out, and where the
evidence lives.

**13.1 Definition and Binding are separate.** The architecture of an
application's dynamic resources does not change when its state shape does.
Separation lets one Definition serve a Foldkit Model, a daemon config and a
test fixture without restating the topology. It rules out a fused
"resource description + state selector" object, which would be unusable outside
the state type it was born in. *Evidence:* `test/identity.test.ts`,
`examples/editor.ts`.

**13.2 Topology is internal vocabulary.** Applications write `owner:` and
`requires:` and never name the ownership tree, capability DAG, reconcile pass,
slots or generations. Every internal structure an application can name becomes
a compatibility obligation, and the runtime must stay free to change how it
converges. It rules out public topology inspection, ordering guarantees between
unrelated families, and DevTools built on internal identity.

**13.3 Semantic key, not physical generation.** Applications reason about what
should exist; the runtime reasons about what does exist. Conflating them is
what forces retry nonces and generation counters into domain state.
*Evidence:* §5, `test/identity.test.ts`.

**13.4 Ownership and capability dependency are different relations.**
Collapsing them would force either a spurious tree — a resource cannot have two
owners — or a spurious DAG, in which a child must die with its parent, which a
dependency does not imply. *Evidence:* `test/ownership.test.ts`,
`test/dependencies.test.ts` prove the two invalidation behaviours differ.

**13.5 Provider replacement replaces dependents; it never rebinds them.** A
dependent captured one internally consistent provider set at admission.
Rebinding it mid-life would let a resource observe two generations of its
provider — the exact race applications write by hand and get wrong.
*Evidence:* `test/environmentIsolation.test.ts`, `test/dependencies.test.ts`.

**13.6 Commit is non-blocking and non-convergent.** A Foldkit Message or an
HTTP handler must not be held open by resource latency; convergence happens
after. It rules out an `awaitConvergence` in the commit path — applications
that need to know whether something is up ask `status`. *Evidence:*
`test/commit.test.ts`, including the linearization-point tests.

**13.7 Ambiguous `many` providers are rejected.** With a `many` provider there
is no single defensible answer to "which one?", and inventing one — first,
newest, matching key — would bake a selection policy into the kernel before any
real workload asked for it. *Reconsider when* a real migration repeatedly needs
`Document[foo] requires LanguageServer[typescript]`; an explicit selection
mechanism is then the answer, not a default (§16). *Evidence:*
`test/dependencies.test.ts`.

**13.8 Retry is explicit, never key pollution.** The alternatives all put
operational state into domain identity: a retry nonce in the key, withdrawing
and restoring desire, or an unrelated model change. The comparison in
`examples/foldkit` measures this precisely — the hand-written version threads a
`serverAttempt` counter into its resource requirements; the reconciler version
needs nothing. *Evidence:* §6.6, §9.3, `test/retry.test.ts`,
`examples/foldkit/scenario.test.ts`.

**13.9 Observability is semantic, and status outranks events.** An application
that turns a failure into UI state must be able to recover that state after a
missed notification, or the notification becomes a second source of truth that
can drift. Publication must never block reconciliation, which forces the stream
to be lossy — so it cannot be the authority. *Evidence:* §9.2,
`test/observation.test.ts`.

**13.10 Semantic keys are ordinary Effect values.** The earlier design made
every family declare an injective string encoding, which put escaping and
collision-safety on the user: two adversarial component encodings could collide
and silently merge two lifetimes. With structural identity there is no encoding
to collide inside, and a key is just a value. It rules out serialization as the
primary identity mechanism. An earlier draft also rejected function keys
outright as `UnstableKey`; that was removed, because a function carrying
`Equal`/`Hash` is a perfectly good structural key and the check caught only one
member of a class of user error it could not detect in general. *Evidence:*
§3.2, `test/identity.test.ts`, `test/misuse.test-d.ts`, `bench/RESULTS.md`.

**13.11 Expected failures are tagged data; defects stay defects.** A caller
recovering from "this provider is ambiguous" should not be matching on a
string. Tagged cases make `catchTags` exhaustive and give each case its own
fields; formatting becomes presentation. Implementation bugs remain defects
rather than joining a broad recoverable error. *Evidence:* §10,
`test/errors.test.ts` handles the whole algebra in one `catchTags`.

**13.12 `None` is not an error.** `status` returning `None` deliberately covers
both "not desired" and "not yet admitted": what was asked for is in the
application's own state, and duplicating it in the runtime would create a
second copy to keep in sync. *Evidence:* §9.1, `test/observation.test.ts`.

**13.13 A change signal carries nothing.** Every richer design for
`changes` — the lifetime that moved, its old and new status, a reconciliation
event log — makes the stream a second source of truth, and a lossy one, which
§13.9 has already ruled out for failures for exactly the same reason. A
payload-free edge cannot drift from `status`, because it says nothing `status`
could contradict; it cannot leak topology, because it names nothing; and it
can coalesce without losing information, because "read again" answers for any
number of transitions at once. What it buys is the whole difference between an
observer that polls and one that does not, which is a UI adapter's single
largest cost. The one concession is the prompt replayed to a new subscriber:
without it, subscribing and taking a first reading cannot be ordered safely,
and an observer could sit forever on a reading taken a moment too early.
*Evidence:* §9.5, `test/observation.test.ts`, `examples/ui/mirror.ts`.

**13.14 Observation is a query, diagnosis is a stream.** Everything an
application may *depend on* is a query — `status`, `snapshot` — and everything
that explains how it got there is a stream — `failures`, `changes`, `events`.
The split is not stylistic. A stream that reconciliation must not block on has
to be lossy, and a lossy channel cannot be an authority (§13.9); a query taken
under the reconciler's own serialization is coherent and cannot be missed. So
the streams are allowed to say the one thing queries cannot — *why* — and are
never allowed to say *what*. A retirement reason is safe on a stream for
exactly this reason: no application state can be derived from it, because the
state it would be derived from is already on `status`. *Evidence:* §9.6, §9.7,
`test/snapshot.test.ts`, `test/diagnostics.test.ts`,
`examples/devtools/panel.ts`.

**13.15 Supervision covers the gap the application cannot reach.** A restart
policy that supervised a *running* lifetime would be reimplementing
`Effect.retry` a level away from the code that knows what failed, and worse
than it. The gap Effect cannot close is the other one: a startup that never
completed, in a slot the runtime owns, under a key the runtime assigned — no
application-level retry can retire that generation or decide when its
successor may be admitted. So the policy covers exactly that and nothing else,
it is the same transition `retry` performs, and it is off by default because a
runtime that retries uninstructed converts a configuration error into an
unbounded stream of attempts. *Evidence:* §9.8, `test/supervision.test.ts`.

**13.16 Incrementality is opt-in, unchecked, and measured.** The runtime
cannot verify that a selector reads only what its `deps` say, so an incorrect
declaration produces a lifetime that does not start when it should — the worst
failure this design has. That is affordable only because it is opt-in and the
default sweep is always right (§15). It also turned out not to be a
straightforward win: measured, it is ~3× cheaper on unchanged data and ~3×
more expensive at the commit boundary on data that changes, and applying it to
one level of an owner chain without the level above it was *worse* than not
applying it at all. A memo whose key is expensive to compute is not a memo.
Shipping the measurement alongside the feature is the point. *Evidence:*
§9.9, §15, `bench/RESULTS.md`, `test/incremental.test.ts`.

**13.17 A nested Reconciler is a lifetime, not a new concept.** The
alternative was composing Definitions — sub-families merged into the parent's
identity space — which would have meant one identity scheme spanning
independently authored features, cross-Definition ownership and requirement
resolution, and no way to keep a feature's state shape its own. Nesting
instead makes the child an ordinary resource of an ordinary lifetime: it is
finalized by the ownership closure that already exists (§11), it needs no new
shutdown rule, and the only genuinely new primitive is observation — one
`SubscriptionRef` that cannot start or stop anything. The price is that the
two runtimes do not share an identity space, and that price is stated rather
than hidden. *Evidence:* §9.10, `test/nested.test.ts`.

**13.18 Optimization waits for measured pressure.** See §15.

## 14. Conformance

`test/` is the executable contract. It proves:

- equal keys retain physical lifetimes; changed keys replace them
  (`identity.test.ts`);
- equivalent commits create zero lifecycle churn (`identity.test.ts`);
- `many` keys reconcile independently — add, retain, remove
  (`identity.test.ts`);
- owner replacement closes all descendants structurally, children wait for
  their owner to be Running, and identity is owner-relative
  (`ownership.test.ts`);
- provider replacement invalidates dependents only, failed providers prevent
  dependent admission, and provider generations never mix
  (`dependencies.test.ts`, `environmentIsolation.test.ts`);
- startup is interruptible, and late startup completion never resurrects an
  obsolete lifetime (`ownership.test.ts`, `shutdown.test.ts`);
- sequential replacement preserves exclusivity with latest-state coalescing;
  overlap replacement permits safe coexistence (`replacement.test.ts`);
- commits linearize, publish atomically, and never await convergence
  (`commit.test.ts`);
- shutdown is idempotent, interrupts startups and awaits structured
  finalization; commits after shutdown fail with `ControllerClosed`
  (`shutdown.test.ts`);
- one Definition binds to multiple state types (`identity.test.ts`);
- semantic keys are ordinary Effect values compared with `Equal`/`Hash`, so
  structural keys need no encoding and cannot collide (`identity.test.ts`);
- a failed lifetime holds its slot, so recommitting the same state is not an
  implicit retry, and `retry` retires the failed generation under the same key
  (`failure.test.ts`, `retry.test.ts`);
- owned selectors see the whole semantic owner path, so identical direct-owner
  keys under different ancestors stay distinct (`identity.test.ts`);
- startup environments are typed, and type-level misuse is rejected
  (`misuse.test-d.ts`);
- change signals report every transition `status` can report and stay silent
  through an equivalent commit, coalesce under a one-slot subscription, and
  prompt a late or racing subscriber exactly once (`observation.test.ts`);
- a snapshot reports every generation owners-first, answers as `status` does,
  cannot contradict itself mid-transition, and is empty after shutdown
  (`snapshot.test.ts`);
- events name why each generation was retired, report one generation's
  lifecycle in order, and retain nothing for a Controller nobody is watching;
  counters are maintained regardless (`diagnostics.test.ts`);
- supervision is off by default, restarts a failed startup under the same key,
  stops when its schedule is exhausted, ends when desire is withdrawn, and
  resets once the lifetime runs (`supervision.test.ts`);
- an incremental binding skips exactly the selectors whose declared
  dependencies are unchanged, produces the same desire the full sweep does
  across a sequence of commits, and forgets owners that went away
  (`incremental.test.ts`);
- observed state reaches a running lifetime without replacing it, coalesces to
  the latest, and never reaches an obsolete generation; all three ways to
  misdeclare it are rejected at `make`; a nested Reconciler reconciles on its
  parent's commits, dies with its host, and treats a commit that loses the
  teardown race as teardown rather than as a fault (`nested.test.ts`);
- ordinary Effect stays ordinary inside `start`: transient retry schedules and
  Layer building work unchanged (`effectNative.test.ts`).

Concurrency tests use deterministic Effect synchronization — `Deferred`,
`Semaphore`, explicit gates, a test-only convergence barrier — rather than
sleeps. Real-time windows appear only where the *absence* of an event must be
observed and no stronger synchronization exists.

## 15. Performance

Binding evaluation and the reconcile sweep are O(N) per commit. There are no
dirty-slot queues, dirty-family queues, incremental selector graphs or reverse
invalidation schedulers.

The benchmark (`bench/RESULTS.md`, 100 / 1k / 10k lifetimes) shows churn is
already scale-invariant and selective: zero churn on an equivalent commit, two
starts and two stops for one changed document whether there are 100 or 10,000.
What scales with N is selector evaluation — at 10,000 lifetimes a no-op commit
is ~8 ms at p50 and ~19 ms at p95, paid at the caller's boundary rather than
holding the controller, with ~22 ms of background convergence behind it. At
editor scale, hundreds to low thousands, commit is under a millisecond.

Effect-native key identity costs 10–25% against the encoded-string scheme it
replaced, at identical churn; three snapshot-local memoizations closed an
initial 2× gap without adding incremental dependency tracking. Adding
incremental machinery now would trade a simple, provably correct pass for
cache-invalidation bugs against no measured need.

*Reconsider when* a real workload shows selector evaluation or the reconcile
sweep consuming a meaningful share of its frame or latency budget — the p95
commit column is the one to watch, not the median. Correctness must never
depend on such an optimization: the semantic contract stays
full-snapshot-equivalent.

Incremental bindings (§9.9) are that reconsideration, taken and measured. They
are opt-in for the reason above — a Binding that declares its dependencies
wrongly produces a lifetime that does not start, and the runtime cannot check
the declaration — and the default remains the full sweep, which is always
right. What the measurement says is not what "add a memo" usually implies:
about three times cheaper end to end on unchanged data, about three times more
expensive at the commit boundary on data that changes, and *worse than nothing*
when applied to one level of an owner chain without the level above it,
because a memo keyed by a freshly rebuilt identity pays a full structural hash
on every probe. The saving is mostly the reused identities, not the skipped
calls. `bench/RESULTS.md` has both directions and the guidance that follows
from them.

## 16. Scope boundary and the decision

### 16.1 What is now in, and what is still out

Everything v0 deferred has been built: the snapshot API (§9.6), diagnostics
and the reconciliation event stream (§9.7, with `examples/devtools` as the
panel over them), a supervision policy DSL (§9.8), incremental selectors
(§9.9), and nested Reconcilers (§9.10).

Three of them changed shape on the way in, and the shapes are the interesting
part:

- **The event stream is diagnostic, and says so.** It reports *why*, never
  *what* — the authority stays on `status` and `snapshot`, because a channel
  reconciliation must not block on has to be lossy (§13.14).
- **Supervision covers startup failure only.** Supervising a running lifetime
  would be a worse `Effect.retry` placed further from the code that knows what
  failed (§13.15).
- **Incremental selectors are opt-in and were not a free win.** Measured, they
  are ~3× cheaper on unchanged data and ~3× more expensive on changed data;
  the measurement ships with the feature (§13.16, `bench/RESULTS.md`).

Still out, and now for reasons rather than for lack of time: composing
Definitions into one identity space (§13.17 takes nesting instead), and
supervision of running lifetimes.

Out of scope entirely: query caching, stale-time policies, actor mailboxes,
durable workflows, distributed orchestration, remote reconciliation, automatic
dependency discovery, arbitrary capability cycles, renderer, router, forms,
HMR and general signal reactivity. For every proposed feature the question is
whether it is necessary for *state-reconciled keyed Effect lifetimes*.

Pressure worth tracking before adding anything: `many`-provider selection,
cross-owner provider selection, and dynamic provider matching (§13.7).

### 16.2 What has been validated

The kernel passes the conformance suite against real Effect interruption and
finalization, and `examples/foldkit` builds one editor-diagnostics feature
twice — idiomatic Foldkit against a Reconciler Definition, same backend, same
race tests — measuring coordination SLOC −57%, lifecycle-only Model fields
5→0, lifecycle-only Message variants 5→2 and app-owned race tests 5→0.
`examples/foldkit-migration` moves an upstream Foldkit example app onto the
runtime and reports that on a *single flat resource* — no ownership, no
dependencies, no keyed children — the migration is 35% larger.

`examples/ui` adds a third kind of evidence: three adapters (React, Solid,
Lit) over one shared mirror of `Controller.status`, none of which required the
mirror to change. It is also the only example that has changed the kernel. It
was built against a runtime with no change notification, so its mirror polled;
that made the cost of the missing signal concrete rather than hypothetical,
and `Controller.changes` (§9.5) is the result. The order matters as a method:
the adapter came first, the kernel change second, and the example now asserts
that no read happens across an idle window.

Each is honest about its limits. The first feature was written for the
comparison; the second is exactly the shape this design does not claim to
improve; the third exercises observation and commit but no deep ownership.
None of them substitutes for migrating a keyed or nested feature of a
production application, which is what the decision below turned on.

### 16.3 GO / SHRINK / STOP

**Decided: GO.**

The criteria were: lifecycle-only Model state and Messages materially
decreasing, manual provider invalidation disappearing, generic race logic
moving into the runtime, same-key retry working without domain-state
pollution, application code remaining ordinary Effect with few escape hatches,
reasonable adoption cost, acceptable scale, and users understanding
Definition + Binding + Controller without learning internal mechanics — with a
30–50% reduction in lifecycle-specific application code as the target, and a
much larger reduction in manual race-handling rules.

The production migration this document had been waiting for was carried out on
a keyed feature and reported positive against those criteria; the maintainer's
call on that evidence is recorded here as the decision. What is reproducible in
this repository is the examples above, and they are what a reader should judge
the claim by — the migration itself is not public, so no numbers from it are
quoted as if they were.

Two findings from the examples are worth carrying forward as the known adoption
costs, neither of which changed the decision:

- **A flat, unowned, dependency-free resource is not worth migrating.** The
  runtime charges a Definition and a Binding for coordination that such a
  resource does not need. `RcMap` or `LayerMap` plus a small helper is the
  better answer there, and §12.3 says so.
- **There is still no way to use a lifetime's published services from outside
  a lifetime.** Both `examples/foldkit-migration` and `examples/ui` hit it and
  work around it with a holder `Ref`. It remains deliberately unaddressed: a
  caller holding a service whose generation has been retired is exactly what
  §6.3 exists to prevent, and no design has yet been found that gives outside
  access without giving that away. Until one is, the rule is: render and
  decide off `status`, act through `commit` and `retry`.

The SHRINK and STOP branches remain the ones to re-read if that changes — if
most of the value turns out to live inside one control plane, if lifecycle
bookkeeping merely moves rather than disappears, if escape hatches become
frequent, or if failure and status synchronization starts to be a second
application-state system. The goal was never to justify the abstraction at all
costs.

### 16.4 Publication

Done, on the strength of §16.3:

- package metadata — `exports` (the public modules and the root; nothing under
  `internal/` is reachable through it), `types`, `files`, `sideEffects`,
  `repository`, `license`, `keywords`, `engines`, `publishConfig`;
- an intentional build output: `tsconfig.build.json` emits ESM, declarations,
  declaration maps and source maps to `dist/`, and the tarball ships `src/`
  alongside so both kinds of map resolve to real code. `prepack` runs check,
  lint, test and build, so nothing publishes that has not passed all four;
- Effect stays a **peer** dependency. A second copy in a consumer's tree is a
  second runtime identity, and services published by a lifetime would not be
  the services the consumer's code asks for;
- an experimental `0.x` release. `Definition`, `Binding`, `commit`, `status`,
  `snapshot` and `shutdown` are what the README tells a reader to build on;
  `retry`, `failures`, `changes`, `events`, `diagnostics`, supervision
  policies, incremental `deps` and observed state are named unstable and may
  change shape within `0.x`;
- documentation covering the 30-second mental model, root `one`, ownership,
  `many`, capability dependencies, failure and retry, control-plane
  integration including Foldkit, the comparison with `RcMap`/`LayerMap`, the
  non-goals, and the concurrency guarantees together with the non-guarantees.

What `0.x` does not carry, and what a `1.0` would have to answer for, is the
two adoption costs in §16.3 and the newest surface's own lack of production
mileage: §9.6–§9.10 are specified, conformance-tested and measured, but they
have not yet been through what §16.3 put the kernel through.
