# effect-reconciler

## Runtime Specification v0.9

> v0.8 added §92–§96: semantic lifetime references, same-key retry, failed-slot
> semantics, the failure observation contract and Definition identity.
> v0.9 adds §97–§99: Effect-native key identity, the tagged error algebra and
> the observation surface. Each was implemented, tested and — for key identity
> — benchmarked before being written down, per `docs/spec.2.md` §13 and
> `docs/spec.3.md` §52.

## 1. Thesis

Effect already provides the execution primitives required for sophisticated long-lived runtimes:

```text
Scope
Fiber
Layer
Context
Stream
Resource
interruption
finalization
RcMap
LayerMap
```

Applications still repeatedly need coordination logic around those primitives when runtime resources depend on changing application state.

Typical examples include:

```text
authenticated sessions
workspaces
device connections
language servers
document runtimes
collaboration sessions
plugin hosts
background workers
tenant-specific services
dynamically selected databases
```

The recurring problem is not resource acquisition itself.

It is translating:

```text
current control state
```

into:

```text
which keyed Effect lifetimes should exist
```

while correctly handling:

```text
ownership
readiness
replacement
cancellation
dynamic capability dependencies
rapid state churn
startup failure
resource-generation isolation
```

`effect-reconciler` provides:

> **A Reconciler that defines static families of keyed Effect lifetimes and their ownership/capability relationships. A Binding maps arbitrary control state into desired instances. Committing state atomically updates desire; the Reconciler asynchronously converges the Effect runtime.**

The public model is:

```text
Reconciler Definition
        ↓
Binding<State>
        ↓
Controller.commit(state)
        ↓
Effect lifetimes
```

The internal architectural model is:

```text
compiled lifetime ownership tree
+
capability dependency DAG
+
desired instances
+
live physical generations
```

This internal structure may be described as a **dynamic Effect topology**.

Topology is an implementation and architectural concept, not the primary public API vocabulary.

---

## 2. Product thesis

Sophisticated Effect applications repeatedly implement small stateful controllers that coordinate:

```text
desired keyed resources
nested Scope lifetimes
resource readiness
provider availability
replacement races
stale startup cancellation
dependent invalidation
generation-safe environments
latest-state coalescing
```

These controllers can be implemented manually with ordinary Effect.

The opportunity is not new computational capability.

The opportunity is:

> **Move recurring dynamic-resource coordination obligations from application code into reusable Effect-native infrastructure.**

The intended value is practical compression:

```text
before:
application-specific lifecycle controller

after:
static lifetime definitions
+
pure state bindings
```

`effect-reconciler` is therefore a coordination abstraction rather than a new Effect execution model.

---

## 3. Non-goal: a new Effect execution model

`effect-reconciler` does not replace:

```text
Effect
Scope
Layer
Context
Fiber
Stream
RcMap
LayerMap
```

It coordinates them.

Effect answers:

```text
How does work execute?
How is it interrupted?
How are resources acquired?
How are finalizers run?
How are services represented?
```

The Reconciler answers:

```text
Which lifetime should exist?
Who owns it?
Which provider instances must it use?
When has it become obsolete?
Which desired replacement should start next?
```

---

## 4. Public concepts

The stable public model should remain deliberately small.

The primary concepts are:

```text
Definition
Binding<State>
Controller
```

Application code also uses opaque lifetime handles returned by the Definition builder.

The public API should not require normal users to manipulate concepts named:

```text
Topology
DesiredTopology
Desire
ProcessSpec
ProcessGeneration
TopologyRevision
LiveProcess
```

Those concepts may exist internally.

They are not required as first-class user vocabulary.

---

## 5. Package

The standalone package is conceptually:

```text
effect-reconciler
```

The package exposes the generic Effect-native Reconciler.

Foldkit integration should consume the same package and the same lifetime handles.

A separate runtime identity system must not be introduced by adapters.

Conceptually:

```text
application
├── effect
├── effect-reconciler
└── foldkit
```

If a dedicated Foldkit integration package becomes necessary, it should depend on `effect-reconciler` as a peer dependency rather than bundling an independent copy.

---

## 6. Architecture

```text
                     CONTROL STATE

              Foldkit Model / Config /
              State Machine / other state
                        │
                        ▼
                  Binding<State>
                        │
                        │ pure selection
                        ▼
                Desired Instances
                        │
                        │ atomic publication
                        ▼
                    Controller
                   /          \
                  /            \
                 ▼              ▼
          ownership graph   capability graph
                 \              /
                  \            /
                   ▼          ▼
                  Live Effect Runtime

                    Scope Tree
                        +
              immutable provider bindings
```

The internal ownership and capability graphs together form the runtime's **dynamic Effect topology**.

---

## 7. Static versus dynamic information

The architecture explicitly separates static and dynamic information.

### Static

Defined once:

```text
which lifetime families exist
one versus many cardinality
semantic key equality
who owns whom
who requires whom
startup behavior
replacement policy
```

### Dynamic

Supplied on each state commit:

```text
which keys are currently desired
under which desired owners
```

Therefore:

> **The runtime architecture is mostly static. Desire is dynamic.**

The public API reflects that distinction without requiring users to construct topology objects or desired trees manually.

---

## 8. Reconciler Definition

A Definition describes the reusable Effect runtime architecture.

Conceptually:

```ts
const Editor =
  Reconciler.define(define => {
    // lifetime families

    return {
      ...
    }
  })
```

A Definition is independent of any particular application state type.

It may be reused with:

```text
Foldkit Model
daemon configuration
desktop application state
test scenario state
another control plane
```

without duplicating ownership, dependency, or startup definitions.

---

## 9. Lifetime handles

Definitions create opaque lifetime handles.

Example:

```ts
const Session =
  define.one("Session", {
    ...
  })
```

`Session` is used as the stable nominal identity for that lifetime family.

Handles may be referenced by:

```text
owner
requires
bindings
tests
diagnostics
```

The string `"Session"` is primarily a human-readable label.

The handle itself is authoritative identity.

The API should not require a separate `ProcessTag`.

---

## 10. Cardinality

Cardinality is part of the static definition.

v0 supports two forms.

### `define.one`

At most one keyed instance exists per owner instance.

Example:

```text
Application
└── Session[alice]
```

or:

```text
Session[alice]
└── Workspace[acme]
```

The instance may also be absent.

### `define.many`

Zero or more independently keyed instances exist per owner.

Example:

```text
Workspace[acme]
├── Document[foo]
├── Document[bar]
└── Document[baz]
```

Each key is reconciled independently.

---

## 11. Example Definition

Conceptually:

```ts
const Editor =
  Reconciler.define(define => {
    const Settings =
      define.one("Settings", {
        key:
          Key.number,

        start:
          settingsRevision =>
            SettingsRuntime.open(
              settingsRevision
            )
      })

    const Session =
      define.one("Session", {
        key:
          Key.string,

        replacement:
          Replacement.overlap(),

        start:
          userId =>
            SessionRuntime.open(userId)
      })

    const Workspace =
      define.one("Workspace", {
        key:
          Key.string,

        owner:
          Session,

        replacement:
          Replacement.sequential(),

        start:
          workspaceId =>
            WorkspaceRuntime.open(
              workspaceId
            )
      })

    const Language =
      define.one("Language", {
        key:
          Key.string,

        owner:
          Workspace,

        start:
          language =>
            LanguageRuntime.open(language)
      })

    const Document =
      define.many("Document", {
        key:
          Key.string,

        owner:
          Workspace,

        start:
          uri =>
            DocumentRuntime.open(uri)
      })

    const Diagnostics =
      define.one("Diagnostics", {
        key:
          Key.null,

        owner:
          Document,

        requires: {
          settings:
            Settings,

          language:
            Language
        },

        start:
          () =>
            DiagnosticsRuntime.open
      })

    return {
      Settings,
      Session,
      Workspace,
      Language,
      Document,
      Diagnostics
    }
  })
```

The exact TypeScript syntax remains provisional.

The semantics are not.

---

## 12. Definition reuse

The Definition must not depend on a specific state shape.

For example, the same `Editor` definition may be bound to:

```ts
interface Model {
  readonly user:
    Option.Option<string>

  readonly workspaceId:
    Option.Option<string>

  readonly language:
    string

  readonly settingsRevision:
    number

  readonly documents:
    ReadonlyArray<string>
}
```

or:

```ts
interface DaemonConfig {
  readonly account:
    Option.Option<string>

  readonly project:
    Option.Option<string>

  readonly parser:
    string

  readonly settingsEpoch:
    number

  readonly files:
    ReadonlyArray<string>
}
```

without duplicating the Effect architecture.

This reuse requirement is the reason state selectors do not belong directly on lifetime definitions.

---

## 13. Binding

A Binding maps one control-state type into desired instances of a Definition.

Conceptually:

```ts
const FoldkitEditor =
  Editor.bind<Model>(bind => ({
    ...
  }))
```

A separate control plane can create:

```ts
const DaemonEditor =
  Editor.bind<DaemonConfig>(
    bind => ({
      ...
    })
  )
```

The Definition remains unchanged.

---

## 14. Binding is pure

Binding selectors must be pure.

Conceptually:

```text
State
+
desired owner key
        ↓
selector
        ↓
desired child key(s)
```

Selectors must not:

```text
perform Effects
read mutable runtime state
acquire resources
inspect current physical generations
dispatch Messages
```

They describe desire.

They do not perform reconciliation.

---

## 15. Root `one` binding

Example:

```ts
session:
  bind.one(
    Editor.Session,

    model =>
      model.session.pipe(
        Option.map(
          session =>
            session.userId
        )
      )
  )
```

Meaning:

```text
Some("alice")
→ Session[alice] desired

None
→ Session absent
```

---

## 16. Owner-relative `one` binding

A child selector receives the semantic key of the desired owner instance.

Conceptually:

```ts
workspace:
  bind.one(
    Editor.Workspace,

    (
      model,
      userId
    ) =>
      workspaceFor(
        model,
        userId
      )
  )
```

The selector does not receive:

```text
Scope
live owner object
physical generation
runtime service
```

It receives stable desired identity.

---

## 17. `many` binding

Collection families use `bind.many`.

Example:

```ts
documents:
  bind.many(
    Editor.Document,

    (
      model,
      workspaceId
    ) =>
      documentsFor(
        model,
        workspaceId
      )
  )
```

If the selector returns:

```text
foo
bar
baz
```

then three independently keyed Document lifetimes are desired beneath that Workspace.

---

## 18. Per-owner evaluation

Bindings are evaluated relative to desired owners.

A child selector is logically evaluated once for each relevant desired owner identity.

This means desired instance identity is owner-relative.

---

## 19. Semantic identity

A live lifetime's semantic identity is defined by:

```text
lifetime handle
+
semantic key
+
owner semantic path
```

Physical runtime generations are distinct from semantic identity.

For example:

```text
Session[alice]
└── Workspace[acme]
```

and:

```text
Session[bob]
└── Workspace[acme]
```

represent different Workspace instances even though the Workspace key is the same.

---

## 20. Key equality

Each definition provides explicit semantic key equality.

Conceptually:

```ts
key:
  Key.string
```

or:

```ts
key:
  Key.struct({
    uri:
      Key.string,

    version:
      Key.number
  })
```

The rule is:

> **A value belongs in the semantic key only when changing it should replace that lifetime for semantic runtime reasons.**

JavaScript object reference equality is not sufficient unless explicitly selected.

---

## 21. Equivalent state commits

If a new state produces semantically equivalent desired instances:

```text
before:
Session[alice]

after:
Session[alice]
```

the runtime must retain the existing physical lifetime.

Equivalent commits must not create synthetic restart churn.

---

## 22. Lifetime ownership

Every definition has exactly one lifetime owner:

```text
root
or
another lifetime family
```

Ownership means:

> **The child may never outlive the physical owner instance beneath which it was admitted.**

Conceptually:

```text
Session
└── Workspace
    └── Document
```

If Session becomes obsolete:

```text
Session
Workspace
Document
```

all become obsolete structurally.

---

## 23. Ownership is not dependency

Lifetime ownership must not be used merely to gain access to a service.

Example:

```text
Workspace
├── Language
└── Document
    └── Diagnostics
```

If Diagnostics also requires Settings:

```text
Settings ─────────► Diagnostics
Language ─────────► Diagnostics
```

Settings should not become an ancestor merely to supply its capability.

Therefore `effect-reconciler` internally maintains two separate relations:

```text
lifetime ownership tree
+
capability dependency DAG
```

---

## 24. Capability requirements

A lifetime may require capabilities provided by other lifetime families.

Requirements are declared statically and named.

Example:

```ts
requires: {
  settings:
    Settings,

  language:
    Language
}
```

Named requirements avoid positional APIs and permit additive evolution.

---

## 25. Provider resolution

Each requirement must resolve unambiguously for a desired/live instance.

The runtime must never arbitrarily choose between multiple possible providers.

v0 should favor explicit provider handles and owner-relative lookup rules.

Ambiguous definitions are invalid.

---

## 26. Capability graph

Capability dependencies may form a DAG.

Example:

```text
Settings ────────────────┐
                         ▼
Language ───────────► Diagnostics
                         ▲
Workspace ───────────────┘
```

They must not form an unresolved cycle.

Invalid:

```text
A requires B
B requires C
C requires A
```

Such cycles are rejected when the Definition is compiled.

---

## 27. Startup

A desired lifetime does not become available immediately.

Conceptually:

```text
desired
  ↓
owner ready?
  ↓
providers ready?
  ↓
create Scope
  ↓
Starting
  ↓
run start
  ↓
publish provided capabilities
  ↓
Running
```

Only Running lifetimes may:

```text
satisfy requirements
admit children
```

---

## 28. Startup environment

Startup executes against one immutable capability snapshot derived from:

```text
owner capabilities
+
required provider capabilities
+
root environment
```

The exact API may expose this through:

```text
Effect environment
typed startup context
or both
```

but the semantic contract is fixed.

A lifetime never dynamically rebinds to a different provider generation while remaining physically alive.

---

## 29. Provided capabilities

A lifetime may provide capabilities to:

```text
its children
explicit dependents
```

Conceptually the startup Effect produces:

```ts
Context.Context<ROut>
```

or an equivalent opaque service bundle.

The stable API should describe:

> this lifetime provides capabilities `ROut`

rather than expose internal `Runtime.Runtime` objects.

---

## 30. Provider-generation safety

Each physical dependent instance is bound to exact physical provider instances.

Conceptually:

```text
Diagnostics[foo]

bound to:
  Settings(old)
  Language(ts-old)
```

If Language is replaced:

```text
Language(ts-old)
→ obsolete

Language(py-new)
→ Running
```

the existing Diagnostics instance does not silently switch provider.

Instead:

```text
Diagnostics(old)
→ obsolete

Diagnostics(new)
→ start against py-new
```

---

## 31. Environment isolation

Overlapping physical generations may coexist during finalization.

Example:

```text
Session[alice] old   STOPPING
Session[bob] new     RUNNING
```

The runtime must guarantee:

```text
Bob descendants
never receive Alice services
```

Likewise, a dependent requiring several providers must receive one internally consistent captured provider set.

Cross-generation capability mixing is forbidden.

---

## 32. No implicit rebinding

Forbidden:

```text
Diagnostics running with Settings A

Settings B becomes Running

mutate Diagnostics runtime
to point at Settings B
```

Required:

```text
Diagnostics old
→ obsolete

Diagnostics new
→ startup against Settings B
```

This keeps capability relationships:

```text
immutable
observable
testable
race-resistant
```

---

## 33. Physical generations

The Controller uses physical generation identity internally.

Example:

```text
Workspace[acme] old
Workspace[acme] replacement
```

may represent two different physical lifetimes despite equal semantic keys if replacement was caused by a provider binding change.

Generation identities are internal.

Stable public APIs must not expose numerical generation counters.

---

## 34. Runtime validity

A physical lifetime remains valid only while:

```text
its semantic desire remains current
AND
its physical owner remains current
AND
all bound provider instances remain current
```

If any condition fails:

```text
lifetime
→ obsolete
→ Stopping
```

---

## 35. Obsolescence

Once obsolete, a physical lifetime:

```text
may not admit new children
may not admit new reconciler-owned work
may not satisfy new dependents
loses readiness authority
begins Scope closure
invalidates dependent bindings
```

If still Starting, startup is interrupted.

Physical finalization may continue asynchronously.

---

## 36. Late startup completion

If startup completes after its lifetime became obsolete:

```text
late success
```

must not:

```text
publish capabilities
become Running
admit children
satisfy requirements
resurrect the old lifetime
```

The result is discarded and its Scope continues closing.

---

## 37. Lifecycle

The stable observable lifecycle is approximately:

```text
Starting
Running
Stopping
Failed
```

A lifetime may transition:

```text
Starting
  ├──► Running
  ├──► Failed
  └──► Stopping
```

and:

```text
Running
  └──► Stopping
```

Physical absence after finalization need not be represented as a durable public state.

---

## 38. Startup failure

Startup failure is a normal runtime condition.

It is not a Controller defect.

If startup fails:

```text
no children start
no dependents bind
partial resources finalize
failure becomes inspectable
```

A future retry creates another physical instance — explicitly, through
`Controller.retry` (§93), never by recommitting the same state.

Advanced supervision policies are deferred.

---

## 39. Replacement policy

Definitions declare an extensible replacement policy.

v0 supports:

```text
Sequential
Overlap
```

through constructors such as:

```ts
Replacement.sequential()
Replacement.overlap()
```

not bare string enums.

---

## 40. Sequential replacement

Sequential replacement means:

```text
old lifetime obsolete
       ↓
begin shutdown
       ↓
required finalization boundary reached
       ↓
re-read latest desire
       ↓
start latest replacement
```

Use for:

```text
exclusive devices
locks
single-writer resources
resources that cannot overlap safely
```

---

## 41. Overlap replacement

Overlap means:

```text
old lifetime
→ Stopping

new desired lifetime
→ may start immediately
```

Use for:

```text
independent sessions
subscriptions
search runtimes
non-exclusive workers
replaceable service clients
```

Physical overlap does not weaken capability-generation isolation.

---

## 42. Latest-state coalescing

Suppose:

```text
Workspace[A] Running
```

then state commits desire:

```text
B
```

while A is stopping, another commit desires:

```text
C
```

When sequential replacement becomes possible:

```text
start C
```

not necessarily:

```text
start B
then stop B
then start C
```

The runtime continuously reconciles toward the latest committed state.

Intermediate desired states need not become physical runtimes.

---

## 43. Binding evaluation model

A state commit produces one coherent desired snapshot.

Conceptually:

```text
commit(state)
     ↓
evaluate Binding
     ↓
desired instance snapshot
     ↓
atomic publication
```

Selectors for one commit must not observe different versions of application state.

This is particularly important for MVU integration.

---

## 44. Controller creation

A Binding produces a runnable configuration.

Conceptually:

```ts
const BoundEditor =
  Editor.bind<Model>(...)

const controller =
  yield* Reconciler.make(
    BoundEditor
  )
```

The exact constructor syntax remains provisional.

Creation compiles and validates the static Definition and Binding.

---

## 45. Validation boundary: Definition

Creation validates structural invariants such as:

```text
unknown owners
unknown requirements
ownership cycles
capability cycles
ambiguous providers
invalid cardinality relationships
illegal definition reuse
```

Once compiled successfully, internal reconciliation trusts these invariants.

---

## 46. Validation boundary: Binding

Binding compilation validates as much as possible statically or during creation:

```text
every binding references a definition in this Reconciler
one definitions use bind.one
many definitions use bind.many
binding keys match definition key types
owner-relative selectors match owner key types
```

TypeScript should reject most of these before runtime.

---

## 47. Runtime desired-state validation

A `commit(state)` may still discover dynamic invalidity such as:

```text
duplicate equal keys from a many selector
invalid selector result
```

If dynamic validation fails, the new desired snapshot must not become authoritative.

---

## 48. Commit API

The stable mutation boundary is:

```ts
controller.commit(state)
```

Conceptually:

```ts
interface Controller<State> {
  readonly commit:
    (
      state: State
    ) => Effect.Effect<
      void,
      CommitError
    >

  readonly snapshot:
    Effect.Effect<
      ReconcilerSnapshot
    >

  readonly shutdown:
    Effect.Effect<void>
}
```

---

## 49. Commit semantics

`commit(state)` means:

> **Evaluate the Binding against `state` and atomically replace the Controller's authoritative desired instance snapshot.**

A successful commit guarantees:

```text
the new desired snapshot became authoritative
```

It does not guarantee:

```text
resources have started
resources have stopped
the physical runtime has converged
```

---

## 50. Commit atomicity

Commit has no ambiguous publication outcome.

```text
commit succeeds
⇒ new desire definitely published

commit fails
⇒ new desire definitely not published
```

The desired-state publication point should be a small atomic/uninterruptible critical section.

Resource lifecycle work remains asynchronous and interruptible.

---

## 51. Commit latency

`commit` must not await:

```text
resource startup
resource shutdown
finalizers
replacement completion
provider readiness
retry
full reconciliation
```

Therefore:

```text
control-state latency
≠
resource convergence latency
```

---

## 52. Equivalent commits

If two committed states produce equivalent desired snapshots:

```text
commit(state1)
commit(state2)
```

then no lifecycle churn should occur merely because the state object itself changed.

Desired equality is semantic.

It is derived from:

```text
definition structure
owner-relative identity
key equivalence
```

---

## 53. Concurrent commits

Concurrent commits are linearized.

Example:

```text
Fiber A → commit(A)
Fiber B → commit(B)
```

The Controller establishes one total publication order.

The last successfully linearized commit becomes authoritative.

The API does not promise which unsynchronized caller wins.

Callers needing domain ordering should serialize their control-state updates.

---

## 54. Commit errors

Conceptually:

```ts
type CommitError =
  | {
      readonly _tag:
        "ControllerClosed"
    }

  | {
      readonly _tag:
        "InvalidDesiredState"
      readonly reason:
        InvalidDesiredStateReason
    }
```

Lifetime startup failures do not cause `commit` itself to fail.

---

## 55. Shutdown

`shutdown` is idempotent.

```text
shutdown
shutdown again
→ success
```

Shutdown:

```text
stop accepting commits
        ↓
invalidate all desire
        ↓
mark all live lifetimes obsolete
        ↓
close root Scope
        ↓
await structured finalization
```

After shutdown:

```text
commit(...)
→ ControllerClosed
```

---

## 56. Snapshot

The stable Controller may expose a read-only snapshot for inspection.

Conceptually:

```ts
interface ReconcilerSnapshot {
  readonly roots:
    ReadonlyArray<
      LifetimeSnapshot
    >
}
```

A lifetime snapshot may expose:

```text
definition handle
semantic key
status
children
```

It should not expose:

```text
Scope
Fiber
Runtime
mutable maps
physical generation counters
reconcile revisions
internal provider indexes
```

---

## 57. Diagnostic boundary

Detailed runtime events are useful but should not define the stable application API.

An experimental diagnostic API may expose:

```text
physical instance identity
startup timing
replacement reason
provider invalidation
coalescing
internal desired revision
finalization timing
```

Conceptually:

```ts
ReconcilerDiagnostics.observe(
  controller
)
```

rather than making a detailed event stream part of the minimal stable Controller contract.

---

## 58. Hyrum's Law boundary

The implementation must avoid accidentally promising:

```text
exact sibling startup ordering
exact sibling shutdown ordering
exact reconciliation traversal
numerical generation identity
one physical generation per commit
one event per internal transition
specific diagnostic event ordering
```

These are implementation details unless explicitly documented.

---

## 59. Non-guarantees

Unless explicitly stated otherwise, the runtime does not guarantee:

```text
sibling startup ordering
sibling shutdown ordering
wall-clock convergence deadlines
fair scheduling among unrelated lifetimes
materialization of every intermediate desired state
stable internal generation numbers
stable reconciliation revision numbers
global finalizer ordering beyond Scope semantics
```

---

## 60. Root services

The Controller may itself require a static root Effect environment.

Example:

```text
Logger
Clock
Filesystem
Platform services
```

These services live for the Controller's root Scope.

They need not become reconciled lifetime definitions merely because dynamic lifetimes use them.

---

## 61. Dynamic versus root capabilities

Use normal static Effect Layers for:

```text
application-lifetime infrastructure
```

Use reconciled lifetime definitions when:

```text
resource existence or identity changes dynamically
according to committed control state
```

`effect-reconciler` should complement Layer rather than replace it.

---

## 62. Relationship to RcMap and LayerMap

`RcMap` and `LayerMap` solve keyed resource acquisition and sharing.

Conceptually:

```text
reference
   ↓
keyed resource lifetime
```

`effect-reconciler` solves:

```text
control-state desire
        ↓
keyed resource lifetime
```

The distinction is:

```text
RcMap / LayerMap:
resource exists while referenced

effect-reconciler:
resource exists while desired and admissible
```

The implementation may internally use `RcMap`, `LayerMap`, or lower-level Scopes where appropriate.

The public abstraction must not duplicate their functionality unnecessarily.

---

## 63. Relationship to direct Effect

Everything `effect-reconciler` does should remain expressible manually using:

```text
Scope
Context
Layer
RcMap
LayerMap
Fiber
Ref
Stream
```

That is intentional.

The package earns its existence only if it materially reduces:

```text
application lifecycle predicates
manual owner tracking
readiness coordination
provider invalidation code
race-condition tests
replacement bookkeeping
```

It is a coordination abstraction, not a new primitive execution capability.

---

## 64. Relationship to Foldkit

Foldkit is a particularly natural control plane.

Foldkit already provides:

```text
Message
  ↓
pure update
  ↓
committed Model
```

Integration becomes:

```text
Message
  ↓
update
  ↓
Committed Model
  │
  ├────────► View
  │
  ├────────► Commands
  │
  └────────► controller.commit(model)
```

No separate `ProcessSpec` abstraction is required if the Foldkit application uses a `Binding<Model>`.

---

## 65. Foldkit integration contract

The Foldkit adapter must guarantee:

> **Only committed Models are passed to the Reconciler, and they are committed in the same serialized order as Foldkit Model transitions.**

Runtime convergence is asynchronous.

Foldkit's Message loop must not await resource convergence.

---

## 66. Event versus state causality

The earlier Command/Process distinction remains useful even though `Process` is no longer required as public vocabulary.

### Command

```text
Because event X happened,
run this finite Effect.
```

### Reconciled lifetime

```text
While current committed state desires identity X,
maintain this Effect lifetime.
```

Therefore:

```text
event causality
→ Command

state causality
→ Reconciler
```

---

## 67. Foldkit stale outputs

Cancellation cannot retract a Message already emitted.

Example:

```text
Diagnostics computes result
        ↓
dispatch Message
        ↓
Message queued
        ↓
Diagnostics becomes obsolete
```

Reducer-level identity/version validation remains required.

Rule:

> **Reconciler generation safety protects runtime execution; reducer validation protects committed domain state.**

---

## 68. Runtime status versus Foldkit Model

The Controller may know:

```text
Starting
Running
Stopping
Failed
```

Foldkit View should not implicitly treat that runtime status as authoritative application state.

If application/UI semantics require:

```text
WorkspaceReady
ConnectionFailed
LanguageServerUnavailable
```

the lifetime should emit a semantic Message.

Then:

```text
Message
→ update
→ Model
→ View
```

remains authoritative.

---

## 69. Reuse across control planes

One of the defining requirements of `effect-reconciler` is:

> **Static Effect architecture must be reusable independently of control-state representation.**

Example:

```text
Editor Definition
      │
      ├── bind<Model>
      │
      └── bind<DaemonConfig>
```

Both bindings must reuse:

```text
same owner relationships
same requirement graph
same startup Effects
same replacement policies
same key semantics
```

Only desired-state selectors change.

---

## 70. Nested Reconcilers

A reconciled lifetime may host a child Reconciler.

Example:

```text
Application Reconciler
└── Workspace lifetime
    └── Plugin host
        └── Plugin Reconciler
```

The parent Scope owns the nested Controller's lifetime.

The system does not require one global Reconciler or one global control-state type.

---

## 71. Performance architecture

The naïve implementation:

```text
commit state
   ↓
evaluate every binding
   ↓
walk every definition
```

is semantically valid but not the intended optimized runtime.

The compiled Definition should permit indexes such as:

```text
owner → children
provider → dependents
definition → live slots
```

Bindings may later support incremental selector invalidation.

Correctness must not depend on these optimizations.

---

## 72. Reverse dependency index

Provider replacement should invalidate only known dependents.

Conceptually:

```text
Settings replaced
       │
       ▼
dependents(Settings)
       │
       ├── Diagnostics[foo]
       └── Diagnostics[bar]
```

The runtime should not globally rescan unrelated resource families merely because one provider changed.

---

## 73. Binding optimization

A Binding implementation may eventually track which selectors are affected by a state transition.

Foldkit may be especially well positioned to exploit this.

The optimized path may become:

```text
Model commit
    ↓
affected bindings
    ↓
changed desired identities
    ↓
Reconciler work queue
```

rather than full reevaluation.

This is an optimization layer.

The semantic contract remains full-snapshot-equivalent.

---

## 74. Failure of providers

If a required provider fails to start:

```text
Language
→ Failed
```

a dependent such as Diagnostics:

```text
remains unadmitted
```

It must not start with:

```text
missing provider
stale provider
partially initialized provider
```

If a valid replacement later becomes Running, the latest desired dependent may then start.

---

## 75. Replacement caused by provider change

A lifetime may be replaced even when its semantic key remains unchanged.

Example:

```text
Diagnostics[foo]
```

remains semantically desired.

But:

```text
Settings old
→ Settings new
```

invalidates Diagnostics' provider binding.

Therefore:

```text
Diagnostics physical instance old
→ obsolete

Diagnostics physical instance new
→ same semantic key
→ new provider binding
```

This is why physical generations are distinct from semantic identity.

---

## 76. Startup cancellation

If desired state changes while startup is in progress:

```text
Starting A
```

and A becomes obsolete:

```text
close A Scope
→ interrupt startup
```

A stale startup completion must not regain authority.

This applies to obsolescence caused by:

```text
semantic key change
owner invalidation
provider invalidation
shutdown
```

---

## 77. Admission invariant

A new physical lifetime may be admitted only if, at the admission point:

```text
its semantic desire is still current
its owner is still current and Running
all required providers are still current and Running
the Controller is still open
```

If any condition fails, admission is abandoned.

---

## 78. Ownership closure invariant

If an owner becomes obsolete:

```text
all physical descendants become obsolete
```

without requiring each child Binding selector to independently express the ancestor condition.

This removes duplicated predicates such as:

```text
if session exists
AND workspace exists
AND document exists
...
```

from application code.

Lifetime dominance is structural.

---

## 79. Dependency invalidation invariant

If a provider binding becomes invalid:

```text
all currently bound dependents become obsolete
```

without invalidating unrelated owners.

Example:

```text
Settings changes
```

may replace:

```text
Diagnostics
```

while retaining:

```text
Document
Workspace
Language
```

unless they independently depend on Settings.

---

## 80. Required v0 correctness suite

The initial implementation must prove:

```text
equal keys retain physical lifetimes
changed keys replace lifetimes
one cardinality admits at most one key per owner
many cardinality reconciles keys independently
owner replacement closes all descendants
provider replacement invalidates dependents only
provider failure prevents dependent admission
startup is interruptible
late startup cannot resurrect obsolete lifetime
old/new provider generations never mix
sequential replacement preserves exclusivity
overlap replacement permits safe coexistence
latest desired identity supersedes intermediate replacements
equivalent commits create no lifecycle churn
commits linearize
successful commit definitely publishes desire
failed commit definitely does not publish desire
commit does not await lifecycle convergence
shutdown is idempotent
commit after shutdown fails
same Definition can bind to multiple state types
```

---

## 81. Benchmark acceptance criteria

`effect-reconciler` should continue only if realistic applications show material reduction in coordination burden relative to direct Effect.

Evaluation should compare:

```text
application orchestration LOC
manual lifecycle predicates
manual cancellation rules
manual provider invalidation
manual readiness state
race-condition tests
runtime overhead
selector work
debugging clarity
type-level misuse resistance
```

A primary success criterion is:

> **The Reconciler should remove a repeated block of application-written coordination without obscuring ordinary Effect resource code.**

---

## 82. Kill criteria

The project should be reconsidered if:

```text
RcMap/LayerMap plus a tiny helper
achieve nearly the same compression

owner/require relationships rarely appear
in real Effect applications

the API requires frequent escape hatches
into internal graph state

binding types become harder to understand
than direct Effect composition

runtime policy grows into a general workflow
or actor framework

most applications still need their own
manual readiness/controller protocol

the main benefit becomes DevTools rather
than correctness and code reduction
```

The goal is not to justify the abstraction at all costs.

---

## 83. Deferred from v0

Do not include:

```text
query caching
stale-time policies
actor mailboxes
durable workflows
distributed orchestration
remote reconciliation
automatic dependency discovery
arbitrary capability cycles
complex supervision DSLs
renderer
router
forms
HMR
general signal reactivity
stable detailed reconciliation events
```

The v0 scope is deliberately narrow:

> **state-reconciled Effect lifetimes**

---

## 84. Minimal standalone API

The intended conceptual public surface is approximately:

```ts
Reconciler.define

define.one

define.many

Definition.bind

bind.one

bind.many

Key.*

Replacement.sequential

Replacement.overlap

Reconciler.make
Reconciler.ref

Controller.commit

Controller.failures
Controller.status
Controller.retry

Controller.snapshot

Controller.shutdown
```

Potential public types:

```text
Definition
Binding<State>
Controller<State>

OneHandle
ManyHandle

Key<A>
ReplacementPolicy

LifetimeRef
LifetimeFailure
LifetimeStatus

ReconcilerSnapshot
LifetimeSnapshot
LifetimeStatus

DefinitionError
BindingError
CommitError
```

Notably absent:

```text
Topology
Desire
ProcessSpec
ProcessGeneration
TopologyRevision
LiveProcess
Scope handles
Runtime handles
detailed reconciliation events
```

---

## 85. Example complete binding

Foldkit:

```ts
const FoldkitEditor =
  Editor.bind<Model>(bind => ({
    settings:
      bind.one(
        Editor.Settings,
        model =>
          Option.some(
            model.settingsRevision
          )
      ),

    session:
      bind.one(
        Editor.Session,
        model =>
          model.session.pipe(
            Option.map(
              session =>
                session.userId
            )
          )
      ),

    workspace:
      bind.one(
        Editor.Workspace,
        (
          model,
          _userId
        ) =>
          model.workspaceId
      ),

    language:
      bind.one(
        Editor.Language,
        (
          model,
          _workspaceId
        ) =>
          Option.some(
            model.language
          )
      ),

    documents:
      bind.many(
        Editor.Document,
        (
          model,
          _workspaceId
        ) =>
          model.openDocuments
      ),

    diagnostics:
      bind.one(
        Editor.Diagnostics,
        (
          _model,
          _documentUri
        ) =>
          Option.some(null)
      )
  }))
```

Then:

```ts
const controller =
  yield* Reconciler.make(
    FoldkitEditor
  )
```

and after every committed Model transition:

```ts
yield* controller.commit(model)
```

---

## 86. Same Definition, different control plane

Daemon:

```ts
const DaemonEditor =
  Editor.bind<DaemonConfig>(
    bind => ({
      settings:
        bind.one(
          Editor.Settings,
          config =>
            Option.some(
              config.settingsEpoch
            )
        ),

      session:
        bind.one(
          Editor.Session,
          config =>
            config.account
        ),

      workspace:
        bind.one(
          Editor.Workspace,
          config =>
            config.project
        ),

      language:
        bind.one(
          Editor.Language,
          config =>
            Option.some(
              config.parser
            )
        ),

      documents:
        bind.many(
          Editor.Document,
          config =>
            config.files
        ),

      diagnostics:
        bind.one(
          Editor.Diagnostics,
          () =>
            Option.some(null)
        )
    })
  )
```

The runtime architecture is reused unchanged.

---

## 87. Mental model for generic Effect users

A generic Effect developer should think:

> **Define the dynamic Effect resource families once, then bind any immutable control state to the keys that should currently exist.**

They should not need to reason about:

```text
desired topology trees
controller generations
dependency indexes
reconciliation revisions
```

for ordinary usage.

---

## 88. Mental model for Foldkit users

A Foldkit developer should think:

> **After every committed Model, `effect-reconciler` ensures that the Effect lifetimes implied by that Model eventually exist and obsolete lifetimes eventually disappear.**

The distinction remains:

```text
Message
→ Command
```

for event-caused finite work,

and:

```text
Model
→ Reconciler
```

for state-caused lifetime existence.

---

## 89. Internal implementation model

Although the public API is intentionally compact, the runtime implementation remains a dynamic Effect topology reconciler.

Internally:

```text
Compiled Definition

├── lifetime ownership tree
├── capability dependency DAG
├── reverse dependency index
└── cardinality metadata

              +

Binding<State>

              ↓

commit(state)

              ↓

Desired Instance Snapshot

              ↓

Reconciliation

              ↓

Live Physical Instances

├── Scope ownership tree
└── immutable capability bindings
```

The internal graph model is necessary.

It is not user-facing.

---

## 90. Naming

The package and product name is:

> **`effect-reconciler`**

The primary public abstraction is:

> **Reconciler**

The primary user-facing vocabulary is:

```text
Reconciler
Definition
Binding
Controller
Lifetime
```

The phrase:

> **dynamic Effect topology**

remains the architectural description for the internal ownership and capability graph.

This gives a deliberate naming split:

```text
package:
effect-reconciler

public operation:
reconciliation

managed concept:
Effect lifetimes

internal architecture:
dynamic Effect topology
```

This avoids exposing graph terminology as a requirement of normal use while preserving it where it accurately describes the implementation.

---

## 91. Final definition

`effect-reconciler` can be summarized as:

> **A Reconciler compiles a static architecture of keyed Effect lifetime families, lifetime ownership, and capability dependencies. A Binding maps immutable control state into desired keys for those families. Each committed state atomically replaces desired state, and the Controller asynchronously converges live Effect Scopes and capability bindings toward that desire.**

More compactly:

> **State-reconciled keyed Effect lifetimes.**

The product thesis is:

> **Define dynamic Effect architecture once; bind it to application state; let `effect-reconciler` own the races.**

---

## 92. Semantic lifetime reference

Every semantic API speaks one vocabulary: a reference naming

```text
family handle
+
semantic key
+
semantic owner path
```

The family handle — not its label — is the identity. Two families may share a
display name, so a name-keyed API could not distinguish them.

```ts
interface LifetimeRef<H> {
  readonly family: H
  readonly key: KeyOf<H>
  readonly parent: OwnerOf<H> // a LifetimeRef, or null at the root
}
```

The ownership chain is type-checked, so a reference cannot name a lifetime the
Definition could not produce. References are built with `Reconciler.ref`, and
arrive with every failure. Owned selectors receive their owner as one, which is
what lets a selector distinguish two identical direct owner keys under
different ancestors.

A reference never exposes:

```text
Scope
Fiber
Context
physical generation
reconcile revision
live slot or instance
```

---

## 93. Same-key retry

A failed lifetime keeps its slot until desire changes, which is what makes
recommitting the same state lifecycle-idempotent. Recommitting therefore cannot
serve as an implicit retry, and the alternatives — a retry nonce inside the
semantic key, withdrawing and restoring desire, an unrelated domain-state
change — would all pollute domain identity with operational generation state.

```ts
controller.retry(ref)
```

> If the referenced lifetime is still desired and its current physical
> generation is Failed, retire that generation and allow a fresh one to be
> admitted when owner and provider conditions permit.

Retry never changes semantic identity: the key, the owner path and therefore
every descendant's identity are exactly what the Binding already described.

| situation | behaviour |
| :--- | :--- |
| current generation Failed | retire it; a fresh generation is admitted when conditions permit |
| Starting / Running / Stopping | no-op |
| no longer desired | no-op |
| controller closed | fails with `ControllerClosed` |
| provider unavailable | stays unadmitted until the provider is Running |
| sequential cleanup in flight | waits for the failed generation's finalization boundary |
| called repeatedly | idempotent: one retirement, not one per call |

---

## 94. Failed-slot semantics

A generation whose startup failed is not discarded: it holds its slot, in the
`Failed` state, with its cause. That is what stops the runtime from spinning on
a failing resource, and what makes "still broken" observable rather than
indistinguishable from "not started yet".

The slot is released when either

```text
desire changes
or
Controller.retry retires the generation
```

Under `Replacement.sequential`, the replacement waits for the failed
generation's finalization boundary, so a partially acquired exclusive resource
is fully released before another attempt acquires it.

---

## 95. Failure observation: event versus status

Two mechanisms, deliberately different in strength.

`Controller.status(ref)` is authoritative and cannot be missed. Its shape is
given in §99: `Some` of a physical state, or `None` when no generation exists.

`Controller.failures` is a live convenience: a `Stream` of the failures of
lifetimes whose desire is still current.

Its delivery contract is explicit:

- a failure is published only if the semantic desire is still current at the
  moment startup completes — desire withdrawn during startup means no event;
- a superseded generation's failure is never published;
- with no subscriber attached, nothing is retained;
- the buffer is bounded and drops the oldest events under overflow;
- publication never blocks reconciliation.

Therefore:

> If application state depends on a failure, that state must be recoverable
> from `status`. Notifications are for reacting, not for remembering.

---

## 96. Definition identity

A Definition's identity is a per-call object, compared by reference; a family's
identity is its handle object. Neither is a name nor a numeric index, so
handles cannot be confused across Definitions that declare families in the same
order, nor across two duplicate installed copies of the package. Numeric family
ids remain, but only as indexes within one Definition.

---

## 97. Key identity is Effect's

A family declares no key descriptor. The semantic key type is inferred from
`start`, and semantic equality is `Equal.equals` with `Hash.hash`, the same
convention `RcMap` and the Effect collections use.

```ts
define.one("Session", {
  start: (userId: string) => ...
})
```

Primitives work as themselves. Structural keys are ordinary values — a plain
object, an array, an Effect `Data` value — because Effect compares and hashes
all of them structurally. Nothing has to be serialized, and therefore nothing
has to be escaped: the delimiter-collision class of bug the earlier encoded
path scheme had to defend against cannot be expressed.

The one value Effect compares by reference is a function, so a function key is
rejected as invalid desired state rather than churning the lifetime on every
commit.

The §8.3 rule is unchanged and now purely semantic:

> Put a value in the semantic key only when changing it should create a
> different semantic lifetime.

Identity performance is measured, not assumed: `bench/RESULTS.md` records this
scheme against the encoded-string scheme it replaced, with identical churn.

---

## 98. Errors are tagged data

Expected failures are Effect-style tagged errors carrying the family they
concern, so recovery is ordinary `catchTag` / `catchTags`:

```text
DefinitionError = ForeignOwner | OwnershipCycle | ForeignRequirement
                | CapabilityCycle | AmbiguousProvider | UnresolvableProvider

BindingError    = ForeignHandle | MissingBinding | DuplicateBinding
                | CardinalityMismatch

CommitError     = ControllerClosed | InvalidDesiredState
```

`InvalidDesiredState` carries a discriminated reason:

```text
DuplicateDesiredKey | InvalidSelectorResult | SelectorFailed | UnstableKey
```

Message formatting is presentation, not structure. Impossible states caused by
a bug in this package are defects, not members of these unions.

---

## 99. The observation surface

```ts
interface Controller<State> {
  readonly commit: (state: State) => Effect<void, CommitError>
  readonly retry: (ref: LifetimeRef) => Effect<void, ControllerClosed>
  readonly status: (ref: LifetimeRef) => Effect<Option<LifetimeStatus>>
  readonly failures: Stream<LifetimeFailure>
  readonly shutdown: Effect<void>
}
```

`status` is authoritative and answers with what exists:

```text
Some(Starting | Running | Failed(cause) | Stopping)
None  — no physical generation for that semantic identity
```

`None` covers both "not desired" and "desired but not admitted". What was
asked for lives in the application's own state; the runtime reports what
exists.

`failures` is a live `Stream`, not a raw PubSub: a convenience for reacting,
never for remembering. A subscriber that falls behind loses events rather than
holding reconciliation up, which is exactly why `status` is the authority.

Controller stays this small deliberately: no `start`, `stop`, `restart`,
`pause`, `rebind` or `invalidate`.

---

---

---

# Implementation Plan

## 1. Goal

The next milestone is not another specification pass.

The next milestone is:

> **Build the smallest real `effect-reconciler` kernel that can falsify the specification.**

The implementation should use actual Effect primitives and deliberately omit non-essential product features.

The key question is:

> **Does the proposed state machine remain correct and ergonomic when implemented with real Effect Scopes, Fibers, Contexts, interruption, and finalization?**

---

## 2. Scope of the v0 kernel

Implement only:

```text
Reconciler.define
define.one
define.many

Definition.bind
bind.one
bind.many

Key.*

Replacement.sequential
Replacement.overlap

Reconciler.make

Controller.commit
Controller.shutdown
```

Internally implement only what is necessary for:

```text
ownership tree
capability DAG
one/many desired instances
semantic key equality
Starting / Running / Stopping / Failed
physical generation identity
provider-generation bindings
startup cancellation
replacement
latest-state coalescing
shutdown
```

---

## 3. Explicitly defer

Do not implement yet:

```text
snapshot API
DevTools
diagnostic event stream
supervision/retry DSL
incremental selectors
nested Reconcilers
polished package exports
Foldkit-specific public abstractions
HMR
complex tracing
```

These should not distract from proving the runtime semantics.

---

## 4. First real implementation target

Use the existing editor/service topology:

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

This topology exercises:

```text
root one
nested one
nested many
non-ancestral provider dependency
provider replacement
owner replacement
sequential replacement
overlap replacement
rapid state churn
startup failure
generation isolation
```

Implement it using real Effect primitives rather than a semantic simulator.

---

## 5. Recommended internal model

A minimal internal representation may include:

```ts
interface CompiledDefinition {
  readonly ownerChildren: ...
  readonly providerDependents: ...
  readonly definitions: ...
}

interface LiveSlot {
  readonly current: LiveInstance | undefined
  readonly retiring: Set<LiveInstance>
}

interface LiveInstance {
  readonly definition: LifetimeHandle<any, any>
  readonly semanticKey: unknown
  readonly generation: InternalGeneration

  readonly owner:
    LiveInstance | undefined

  readonly providers:
    ReadonlyMap<
      LifetimeHandle<any, any>,
      LiveInstance
    >

  readonly scope:
    Scope.Closeable

  readonly status:
    InternalStatus

  readonly providedContext:
    Context.Context<any> | undefined
}
```

These are internal details, not public types.

---

## 6. Controller architecture

Avoid a controller loop where the controller's own state mutations are cancelled by newer desired state.

Do not structure the central controller as conceptually:

```text
runForEachLatest(commit => reconcile(commit))
```

if cancellation can interrupt controller bookkeeping.

Prefer:

```text
serialized controller state machine
+
interruptible lifecycle Fibers
+
latest authoritative desired snapshot
```

The controller itself owns consistency.

Individual startup/finalizer Effects remain interruptible according to lifecycle policy.

---

## 7. Commit implementation

`commit(state)` should:

```text
1. evaluate the Binding against one immutable State value
2. validate dynamic desired-state invariants
3. atomically publish the new desired snapshot
4. enqueue/trigger reconciliation
5. return
```

It must not await:

```text
startup
shutdown
provider readiness
finalizers
full convergence
```

The publication critical section should be small.

---

## 8. Binding compiler

Compile bindings into static selector descriptors.

Conceptually:

```ts
interface CompiledBinding<State> {
  readonly selectors:
    ReadonlyArray<
      BoundSelector<State>
    >
}
```

For v0, it is acceptable to evaluate every selector on every commit.

Do not optimize selector invalidation until semantics are proven.

The implementation should preserve a path toward:

```text
affected selector
→ affected desired slot
```

later.

---

## 9. Conformance suite first

Before completing the controller implementation, encode the specification as executable tests.

The test suite is the actual v0 contract.

### 9.1 Identity retention

```text
same semantic key
→ same physical lifetime retained
```

Verify:

- no second startup;
- no shutdown;
- no child churn.

---

### 9.2 Key replacement

```text
A
→ B
```

Verify:

- A becomes obsolete;
- replacement semantics obey the configured policy;
- B becomes the current lifetime.

---

### 9.3 Owner invalidation

```text
Session changes
```

Verify:

```text
Workspace
Language
Documents
Diagnostics
```

under the old Session are all invalidated structurally.

No child binding should need to repeat the Session predicate.

---

### 9.4 Provider-only replacement

```text
Settings A
→ Settings B
```

Verify:

```text
Diagnostics replaced
```

while retaining:

```text
Session
Workspace
Language
Documents
```

unless they independently depend on Settings.

---

### 9.5 Provider changes during dependent startup

Central race:

```text
Provider A#1 Running
        ↓
Dependent D#1 Starting

Provider A#1 becomes obsolete
Provider A#2 starts

D#1 startup completes late
```

Required result:

```text
D#1 never becomes Running
D#1 never publishes capabilities
D#1 never admits children
D#2 may start against A#2
```

This should be one of the most important conformance tests.

---

### 9.6 Owner changes during child startup

```text
Owner O#1 Running
Child C#1 Starting

O#1 becomes obsolete
O#2 starts

C#1 startup completes late
```

Required:

```text
C#1 never becomes Running
```

and any new child must belong to O#2.

---

### 9.7 Sequential coalescing

```text
A Running
desired B
A starts stopping
desired C
```

Required:

```text
C starts after A shutdown
B never starts
```

unless B had already crossed the admission boundary before C became authoritative.

---

### 9.8 Overlap replacement

```text
A Running
desired B
```

with overlap policy.

Verify:

```text
A Stopping
B Starting/Running
```

may coexist.

Verify that descendants/providers never mix between generations.

---

### 9.9 Failed provider

```text
Language desired
Language startup fails
Diagnostics desired
```

Required:

```text
Diagnostics never starts
```

until a valid Language provider becomes Running.

---

### 9.10 Equivalent commits

```text
commit(state1)
commit(state2)
```

where bindings produce equivalent desire.

Verify:

```text
zero startup
zero shutdown
zero generation churn
```

caused by the second commit.

---

### 9.11 Commit atomicity

Test interruption around publication.

Required contract:

```text
commit succeeds
→ new desire definitely authoritative

commit fails/interrupted before success
→ new desire definitely not authoritative
```

There must be no externally ambiguous partially published desired snapshot.

---

### 9.12 Concurrent commits

Run:

```text
Fiber A → commit(A)
Fiber B → commit(B)
```

Verify:

- commits linearize;
- final authoritative desire corresponds to one total order;
- controller internal state is not corrupted.

Do not assert which caller wins without external synchronization.

---

### 9.13 Shutdown during startup

```text
lifetime Starting
↓
controller.shutdown
```

Verify:

- startup interrupted;
- late completion cannot become Running;
- root Scope closes;
- shutdown waits for structured finalization.

---

### 9.14 Shutdown idempotency

```text
shutdown
shutdown
```

Both calls succeed.

---

### 9.15 Commit after shutdown

```text
shutdown
commit(state)
```

Required:

```text
ControllerClosed
```

---

### 9.16 Many reconciliation

Given:

```text
Documents = {foo, bar}
```

then:

```text
Documents = {bar, baz}
```

Verify:

```text
foo stops
bar retained
baz starts
```

independently.

---

### 9.17 Owner-relative identity

Ensure:

```text
Session[alice]
└── Workspace[acme]
```

and:

```text
Session[bob]
└── Workspace[acme]
```

cannot share one physical Workspace lifetime.

---

### 9.18 Environment isolation

Create overlapping old/new owner or provider generations.

Record capability identities observed by descendants/dependents.

Assert:

```text
zero cross-generation observations
```

---

## 10. Service typing experiment

The largest remaining API uncertainty is how provided and required services integrate with normal Effect environments.

Prefer an API where user Effects remain ordinary Effect code.

Ideal:

```ts
const Diagnostics =
  define.one("Diagnostics", {
    owner:
      Document,

    requires: {
      settings:
        Settings,

      language:
        Language
    },

    start:
      uri =>
        Effect.gen(function* () {
          const settings =
            yield* SettingsService

          const language =
            yield* LanguageService

          // ordinary Effect code
        })
  })
```

Avoid requiring a parallel runtime API such as:

```ts
start: (uri, context) =>
  context.services.settings
```

unless TypeScript or Effect environment mechanics make ordinary service access impractical.

### Acceptance criterion

Inside `start`, an Effect developer should still feel like they are writing Effect.

If `effect-reconciler` introduces a second DI model, reconsider the design.

---

## 11. Foldkit integration experiment

Do not design a new Foldkit API initially.

Use the thinnest integration possible.

Conceptually:

```ts
const EditorModelBinding =
  Editor.bind<Model>(...)

const controller =
  yield* Reconciler.make(
    EditorModelBinding
  )
```

After Foldkit commits a Model:

```ts
yield* controller.commit(model)
```

The Foldkit runtime should guarantee serialized commit ordering.

Do not await resource convergence inside the Message transaction.

---

## 12. Real Foldkit migration

After the kernel passes its conformance suite, migrate one real Foldkit feature currently requiring significant lifecycle coordination.

Prefer a feature containing several of:

```text
ManagedResource
Subscriptions
nested lifetime conditions
operational readiness Model fields
provider-dependent resources
rapid key changes
```

Do not choose an artificially simple feature.

---

## 13. Migration metrics

Measure before and after.

### Application state

Count Model fields that exist only to coordinate runtime readiness:

```text
sessionReady
workspaceReady
resourceAvailable
languageReady
...
```

Desired result:

```text
large reduction or elimination
```

where those fields are not domain/UI state.

---

### Messages

Count Messages used only for lifecycle bookkeeping:

```text
ResourceAcquired
ResourceReleased
RetryAcquire
ChildReady
ParentReady
...
```

Retain Messages that have genuine application semantics.

---

### Predicates

Count duplicated conditions such as:

```text
session exists
AND workspace exists
AND language ready
AND document exists
```

A successful ownership/dependency model should structurally eliminate most of these.

---

### Manual invalidation

Count code that manually reacts to:

```text
provider changed
owner changed
key changed
resource released
```

to restart dependent resources.

---

### Tests

Count application-level tests whose sole purpose is verifying generic lifecycle races.

Those should move into `effect-reconciler`'s conformance suite.

Application tests should focus on domain behavior.

---

### SLOC

Measure:

```text
application orchestration SLOC before
application orchestration SLOC after
generic reconciler SLOC
```

Do not optimize for framework SLOC alone.

The economic case depends on runtime cost being amortized across applications/features.

---

## 14. Success criteria

Proceed toward a real package if the real implementation demonstrates all of the following.

### Correctness

The conformance suite passes with actual Effect interruption and finalization.

### Compression

A real application materially reduces lifecycle coordination code.

A useful target is:

```text
30–50% reduction
```

in lifecycle-specific application code, with a much larger reduction in manual race-handling rules.

### Effect-native ergonomics

Resource code still uses:

```text
Effect
Scope
Context
Layer
```

normally.

### Narrow runtime

The implementation does not immediately require:

```text
actors
mailboxes
workflow state
query caching
distributed coordination
complex supervision
```

to be useful.

### Type safety

The API infers:

```text
keys
owner keys
required services
cardinality
```

without pervasive explicit generics or `any`.

---

## 15. Go / no-go questions

After the kernel and one real migration, answer:

1. **Did it eliminate application-written lifecycle coordination?**
2. **Did the resulting application become easier for an Effect developer to understand?**
3. **Did ordinary Effect code remain ordinary Effect code inside each lifetime?**
4. **Did ownership and capability dependencies eliminate real duplicated predicates?**
5. **Did provider-generation correctness move from application tests into framework guarantees?**
6. **Did the runtime remain a narrow reconciler rather than expanding into an actor/workflow framework?**
7. **Is the abstraction meaningfully better than direct `RcMap` / `LayerMap` composition?**

If the answers are mostly yes, proceed.

If not, shrink the idea toward Foldkit-specific orchestration or additions around existing Effect keyed-resource primitives.

---

## 16. Suggested implementation phases

### Phase 1 — Type skeleton

Implement:

```text
Reconciler.define
define.one
define.many
Definition.bind
bind.one
bind.many
Key
Replacement
```

Goal:

```text
tsc --strict --noEmit
```

with misuse tests for:

```text
wrong key type
one/many mismatch
wrong owner key
invalid requirement handle
cross-definition handle use
```

---

### Phase 2 — Static compiler

Compile:

```text
definitions
```

into:

```text
owner → children
provider → dependents
cardinality metadata
definition IDs
```

Validate cycles and invalid references.

No runtime lifecycle behavior yet.

---

### Phase 3 — Desired snapshot compiler

Implement:

```text
Binding<State>
+
state
→ desired instance snapshot
```

Cover:

```text
root one
root many
owner-relative one
owner-relative many
duplicate semantic key rejection
```

---

### Phase 4 — Basic one-lifetime controller

Support:

```text
Absent
Starting
Running
Stopping
Failed
```

for one root `define.one`.

Prove:

```text
same key retain
key change replace
startup cancellation
late readiness suppression
shutdown
```

---

### Phase 5 — Ownership tree

Add parent-child Scope ownership.

Prove:

```text
parent invalidation dominates children
child cannot outlive owner
child waits for owner Running
```

---

### Phase 6 — `many`

Add keyed collections.

Prove independent:

```text
add
retain
remove
replace
```

under each owner.

---

### Phase 7 — Capability dependencies

Add:

```text
requires
provider readiness
provider binding capture
reverse dependency index
dependent invalidation
```

This phase validates the main differentiation from simple nested Scope trees.

---

### Phase 8 — Replacement policies

Add:

```text
Sequential
Overlap
```

and latest-state coalescing.

---

### Phase 9 — Foldkit migration

Integrate through:

```text
committed Model
→ controller.commit(model)
```

Migrate one non-trivial real feature.

Measure application-code deletion.

---

### Phase 10 — Decision point

Only after Phase 9 decide whether to invest in:

```text
snapshot API
diagnostics
DevTools
selector optimization
supervision
package polish
documentation
```

---

## 17. Recommended first repository layout

```text
effect-reconciler/
├── src/
│   ├── Reconciler.ts
│   ├── Definition.ts
│   ├── Binding.ts
│   ├── Key.ts
│   ├── Replacement.ts
│   ├── internal/
│   │   ├── compiledDefinition.ts
│   │   ├── desiredSnapshot.ts
│   │   ├── controller.ts
│   │   ├── liveInstance.ts
│   │   ├── reconciliation.ts
│   │   └── generation.ts
│   └── index.ts
├── test/
│   ├── identity.test.ts
│   ├── ownership.test.ts
│   ├── dependencies.test.ts
│   ├── replacement.test.ts
│   ├── failure.test.ts
│   ├── commit.test.ts
│   ├── shutdown.test.ts
│   └── environmentIsolation.test.ts
├── examples/
│   └── editor.ts
├── package.json
└── tsconfig.json
```

The exact module boundaries should be allowed to evolve during implementation.

---

## 18. Immediate next artifact

The immediate next artifact should be:

> **A real Effect-backed `effect-reconciler` v0 kernel plus the conformance suite.**

Not:

```text
spec v0.8
DevTools
documentation site
general supervision
performance optimization
```

The specification is mature enough that the implementation should now be allowed to challenge it.

The next milestone succeeds when the editor topology runs on real Effect Scopes and passes the race-heavy conformance suite with no application-written lifecycle controller.
