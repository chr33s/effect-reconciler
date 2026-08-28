# effect-reconciler

## Effect-Idiomatic Runtime Specification — Draft v0.8

**Status:** design target for the next implementation phase  
**Primary goal:** preserve state-reconciled keyed lifetimes while aligning the public API and semantics with idiomatic Effect conventions.

---

# 1. Purpose

`effect-reconciler` coordinates long-lived Effect lifetimes whose desired existence is determined by changing control state.

It is **not** a replacement for Effect's runtime, dependency model, resource model, or concurrency model.

The central abstraction is:

> **Compile control state into structured Effect lifetimes.**

Conceptually:

```text
immutable control state
        ↓
pure Binding
        ↓
desired semantic lifetimes
        ↓
Reconciler
        ↓
Effect Scope tree
+
captured Context capabilities
```

The package exists to remove repeated application-written coordination around:

```text
which keyed lifetime should exist?
who owns it?
which provider generation may it use?
when is it obsolete?
when may a replacement start?
what happens if startup finishes late?
```

Everything after that decision should remain ordinary Effect.

---

# 2. Effect alignment principles

The design must follow these principles.

## 2.1 Effect remains the execution model

A reconciled lifetime executes normal:

```text
Effect.Effect
```

The reconciler must not introduce a parallel task/effect abstraction.

Inside a lifetime, developers should continue using:

```ts
Effect.gen(...)
Effect.acquireRelease(...)
Effect.addFinalizer(...)
Effect.forkScoped(...)
Effect.retry(...)
Effect.timeout(...)
```

without a reconciler-specific equivalent.

---

## 2.2 Scope remains the lifetime model

Effect describes `Scope` as a lifetime boundary.

`effect-reconciler` should express ownership by creating real child Scopes:

```text
Session Scope
└── Workspace Scope
    └── Server Scope
        └── Analyzer Scope
```

The reconciler may decide **when** a Scope should exist.

It must not invent a second cleanup or cancellation model.

Rule:

> **Lifetime ownership in the reconciler is implemented as structured Effect Scope ownership.**

---

## 2.3 Context and Layer remain the capability model

Capabilities visible to a reconciled lifetime must remain normal Effect services.

Preferred application code:

```ts
start: uri =>
  Effect.gen(function* () {
    const server = yield* ServerService
    const settings = yield* SettingsService

    // ordinary Effect code
  })
```

Avoid:

```ts
start: (uri, reconcilerContext) => {
  reconcilerContext.services.server
  reconcilerContext.services.settings
}
```

The reconciler determines which immutable service environment is captured.

Effect `Context` remains how services are represented and accessed.

`Layer` remains the normal higher-level mechanism for building service graphs when applications want it.

---

## 2.4 Equal and Hash define semantic key identity

The public package should prefer Effect's standard equality and hashing conventions over a parallel serialized-key protocol.

Effect collections and keyed resource primitives already use `Equal` and `Hash` semantics for value-based complex keys.

Therefore:

> **A lifetime key should be an ordinary Effect key value whose semantic equality follows Effect's `Equal` / `Hash` conventions.**

Primitive values work naturally.

Complex structural keys should preferably be Effect data values or custom values implementing `Equal` and `Hash`.

Example:

```ts
import { Data } from "effect"

class DocumentKey extends Data.Class<{
  readonly uri: string
  readonly version: number
}> {}
```

Then:

```ts
define.one("Document", {
  start: (key: DocumentKey) => ...
})
```

No injective string serialization should be required from ordinary users.

### Escape hatch

If explicit custom identity is later shown to be necessary, provide an Effect-shaped descriptor based on equality and hashing:

```ts
interface LifetimeIdentity<A> {
  readonly equals: (a: A, b: A) => boolean
  readonly hash: (a: A) => number
}
```

Do not make serialization the primary public identity mechanism.

---

## 2.5 Typed errors use Effect-style discriminated data

Public expected failures should be structured tagged errors.

Prefer:

```ts
class ControllerClosed
  extends Data.TaggedError("ControllerClosed") {}

class DuplicateDesiredKey
  extends Data.TaggedError("DuplicateDesiredKey")<{
    readonly family: LifetimeFamily.Any
  }> {}
```

over:

```ts
new Error("duplicate key")
```

or:

```ts
DefinitionError({ reason: "..." })
```

Application-recoverable errors belong in the typed error channel.

Internal impossible states remain defects.

---

## 2.6 Reconciler policy stays narrow

Effect already provides retry schedules, timeout policies, error recovery, tracing, logging, metrics, and supervision primitives.

The reconciler should not duplicate them.

In particular:

```text
transient acquisition retry
→ Effect.retry / Schedule

new physical generation of a still-desired failed lifetime
→ Controller.retry(ref)
```

These are distinct operations.

---

# 3. Relationship to existing Effect primitives

## 3.1 Scope

`Scope` answers:

```text
how long may this resource/work live?
```

The reconciler answers:

```text
which Scope should currently exist?
```

---

## 3.2 Context

`Context` answers:

```text
which services are available to this Effect?
```

The reconciler answers:

```text
which immutable provider instances supply those services
for this physical lifetime generation?
```

---

## 3.3 Layer

`Layer` answers:

```text
how are services constructed and wired?
```

The reconciler does not replace Layer.

A lifetime startup may freely build or use Layers.

The reconciler only owns the dynamic lifetime decision and instance Scope.

---

## 3.4 RcMap / LayerMap

`RcMap` and `LayerMap` are keyed resource/service primitives whose lifetimes are driven primarily by references.

Conceptually:

```text
RcMap / LayerMap

reference demand
      ↓
keyed resource lifetime
```

`effect-reconciler` is desire-driven:

```text
control state
      ↓
desired semantic identity
      ↓
keyed resource lifetime
```

The project must not claim that Effect lacks dynamic keyed resources.

Its distinct value is:

> **declarative coordination of interdependent desired lifetimes.**

---

# 4. Public conceptual model

The stable public vocabulary should remain small:

```text
Definition
Binding<State>
Controller<State>
LifetimeRef
```

Application code also uses opaque lifetime-family handles returned from a Definition.

The normal user should not need to manipulate:

```text
Topology
DesiredTopology
PhysicalGeneration
ReconcileRevision
LiveInstance
Scope internals
dependency indexes
```

Those remain implementation concepts.

---

# 5. Definition

A Definition describes reusable dynamic Effect architecture independently of any control-state type.

Conceptually:

```ts
const Editor =
  Reconciler.define(define => {
    const Settings =
      define.one("Settings", {
        start: (revision: number) =>
          Effect.succeed(
            Context.make(SettingsService, { revision })
          )
      })

    const Session =
      define.one("Session", {
        start: (userId: string) =>
          Effect.succeed(
            Context.make(SessionService, { userId })
          )
      })

    const Workspace =
      define.one("Workspace", {
        owner: Session,

        start: (workspaceId: string) =>
          Effect.gen(function* () {
            const session = yield* SessionService

            yield* openWorkspace(
              session.userId,
              workspaceId
            )
          })
      })

    return {
      Settings,
      Session,
      Workspace
    }
  })
```

The state type is not mentioned here.

---

# 6. Lifetime families

A Definition creates opaque family handles.

Example:

```ts
const Session =
  define.one("Session", ...)
```

The handle is authoritative identity.

The string `"Session"` is a human-readable label only.

Rules:

- duplicate labels are permitted unless explicitly prohibited for diagnostics;
- handle identity must never be derived from the label;
- cross-Definition handles are invalid;
- runtime Definition identity must use an unforgeable object/token rather than a module-local integer that can collide across duplicate package copies.

---

# 7. Cardinality

## 7.1 `define.one`

At most one desired semantic key exists per semantic owner instance.

```text
Session[alice]
└── Workspace[acme]
```

The desired instance may also be absent.

---

## 7.2 `define.many`

Zero or more independently keyed instances may exist per semantic owner instance.

```text
Workspace[acme]
├── Document[foo]
├── Document[bar]
└── Document[baz]
```

Each semantic key reconciles independently.

---

# 8. Key semantics

The public API should remove the requirement to pass:

```ts
key: Key.string
```

for ordinary cases.

Instead, key type should be inferred from the Definition's startup function and Binding selector.

Example:

```ts
const Session =
  define.one("Session", {
    start: (userId: string) => ...
  })
```

The runtime uses Effect `Equal.equals` and `Hash.hash` semantics for key identity.

## 8.1 Primitive keys

Idiomatic:

```text
string
number
boolean
bigint
symbol where appropriate
```

---

## 8.2 Complex keys

Prefer Effect data values.

Example:

```ts
class WorkspaceKey extends Data.Class<{
  readonly organizationId: string
  readonly workspaceId: string
}> {}
```

or another value implementing Effect `Equal` and `Hash`.

---

## 8.3 Semantic-key rule

> **Put a value in the semantic key only when changing that value should create a different semantic lifetime.**

Do not add:

```text
generation
retry counter
startup attempt
provider generation
timestamp
```

to a key merely to force replacement.

Physical generations are runtime state, not semantic identity.

---

# 9. Binding

A Binding maps immutable control state into desired semantic keys.

```ts
const BoundEditor =
  Editor.bind<Model>(bind => ({
    settings:
      bind.one(
        Editor.Settings,
        model => Option.some(model.settingsRevision)
      ),

    session:
      bind.one(
        Editor.Session,
        model => model.user
      ),

    workspace:
      bind.one(
        Editor.Workspace,
        (model, owner) =>
          workspaceFor(model, owner.key)
      )
  }))
```

Selectors are pure.

They must not:

```text
perform Effects
read mutable runtime state
access Scopes
inspect physical generations
acquire resources
dispatch application events
```

They describe desire only.

---

# 10. Semantic Owner reference

Owned selectors receive a pure semantic owner reference.

Conceptually:

```ts
interface Owner<K, Parent> {
  readonly family: LifetimeFamily.Any
  readonly key: K
  readonly parent: Parent
}
```

It contains:

```text
family identity
semantic key
semantic parent path
```

It does not contain:

```text
Scope
Context
services
Fiber
physical generation
runtime status
```

This permits:

```text
Organization[A]/Workspace[main]
```

to be distinguished from:

```text
Organization[B]/Workspace[main]
```

without polluting `Workspace`'s semantic key with organization identity.

---

# 11. Semantic lifetime identity

A desired lifetime is identified by:

```text
family handle
+
semantic key
+
semantic owner path
```

This is represented publicly by an opaque:

```ts
LifetimeRef<H>
```

A `LifetimeRef` is semantic, not physical.

It remains the same conceptual identity across:

```text
startup failure
retry
provider-induced replacement
physical generation replacement
```

The ref must not expose a generation number.

---

# 12. Runtime ownership

Every non-root family has exactly one lifetime owner.

Ownership means:

> **A child physical lifetime may never outlive its physical owner generation.**

If:

```text
Session[alice]
```

becomes obsolete, every descendant physical lifetime becomes obsolete structurally.

The application must not duplicate owner-readiness predicates inside child Binding selectors.

---

# 13. Capability requirements

Ownership and capability requirements remain separate.

Example:

```text
Workspace
├── Language
└── Document
    └── Diagnostics

Settings ───────► Diagnostics
Language ───────► Diagnostics
```

Definition:

```ts
const Diagnostics =
  define.one("Diagnostics", {
    owner: Document,

    requires: {
      settings: Settings,
      language: Language
    },

    start: (_: null) =>
      Effect.gen(function* () {
        const settings = yield* SettingsService
        const language = yield* LanguageService
        const document = yield* DocumentService

        // ordinary Effect code
      })
  })
```

Named requirements declare **which dynamic provider families must be valid**.

The services themselves remain ordinary Context services.

---

# 14. Provider resolution

v0.x should remain conservative.

A requirement may resolve to:

1. an owner ancestor; or
2. an unambiguous `one` provider owned by root or one of the dependent's ancestors.

Ambiguous `many` providers remain invalid unless real application evidence justifies an explicit selection API.

Do not infer arbitrary matching rules.

Potential future extension, only if proven necessary:

```ts
requires: {
  server:
    Reconciler.require(LanguageServer, {
      select: ...
    })
}
```

This is deferred.

---

# 15. Startup

A desired semantic lifetime becomes physical only when admissible.

```text
desired
  ↓
owner Running?
  ↓
required providers Running?
  ↓
create child Scope
  ↓
Starting
  ↓
run ordinary Effect startup
  ↓
publish provided Context
  ↓
Running
```

Only `Running` physical generations may:

```text
admit children
satisfy dynamic requirements
```

---

# 16. Startup Effect environment

Each startup Effect receives one immutable Context assembled from:

```text
root environment
+
ancestor-provided services
+
required provider services
+
instance Scope
```

The runtime captures exact provider generations before admission.

No running lifetime is silently rebound to replacement provider generations.

---

# 17. Publishing services

A startup Effect may publish Context services by returning a `Context.Context<ROut>`.

Example:

```ts
start: language =>
  Effect.acquireRelease(
    openLanguageServer(language),
    closeLanguageServer
  ).pipe(
    Effect.map(server =>
      Context.make(
        LanguageServerService,
        server
      )
    )
  )
```

A startup Effect that returns a non-Context value publishes no services.

This keeps simple background lifetimes ergonomic while preserving ordinary Effect Context for providers.

Applications may freely use `Layer.buildWithScope` or other Layer APIs inside startup when they prefer Layer-based construction.

---

# 18. Provider-generation invariant

A running dependent is bound to exact physical provider generations.

If:

```text
Settings#1
```

is replaced by:

```text
Settings#2
```

then:

```text
Diagnostics#1
```

bound to `Settings#1` becomes obsolete.

It is not mutated to point at `Settings#2`.

A fresh:

```text
Diagnostics#2
```

may start with the same semantic key but a new immutable provider set.

Rule:

> **No implicit capability rebinding across physical generations.**

---

# 19. Environment isolation

Overlapping generations may coexist physically during finalization:

```text
Session[alice] old  Stopping
Session[bob] new    Running
```

Descendants of the new generation must never observe services from the old generation.

Likewise, a dependent requiring multiple providers receives one internally consistent captured provider set.

Cross-generation environment mixing is forbidden.

---

# 20. Lifecycle state

The minimal semantic physical statuses are:

```text
Starting
Running
Failed
Stopping
```

Physical absence is represented by no current instance.

Internal numerical generation IDs are not stable public API.

---

# 21. Obsolescence

A physical lifetime becomes obsolete when any of the following becomes false:

```text
its semantic desire is current
its physical owner is current
every captured required provider is current
controller is open
```

Once obsolete it:

```text
cannot admit new children
cannot satisfy new dependents
loses readiness authority
begins Scope closure
invalidates its dependents
```

If startup is still running, closing its Scope interrupts it where Effect interruption semantics permit.

---

# 22. Late startup completion

A startup Effect may be uninterruptible or otherwise complete after obsolescence.

Late completion must be inert.

It cannot:

```text
become Running
publish Context
admit children
satisfy dependents
resurrect the generation
```

The returned resources remain governed by the closing Scope.

---

# 23. Replacement policies

The reconciler owns only **generation replacement ordering**.

v0.x supports:

```ts
Replacement.sequential()
Replacement.overlap()
```

## Sequential

```text
old obsolete
↓
old finalization boundary completes
↓
re-read latest desire
↓
start latest replacement
```

## Overlap

```text
old Stopping
+
new Starting/Running
```

may coexist physically.

Environment-generation isolation still applies.

---

# 24. Latest-state coalescing

For sequential replacement:

```text
A Running
desired B
A Stopping
desired C
```

once replacement becomes admissible, the runtime should normally start:

```text
C
```

rather than materializing every intermediate desired state.

The runtime converges toward the latest authoritative desire.

---

# 25. Controller construction

A Controller is itself a scoped Effect resource.

Conceptually:

```ts
const controller =
  yield* Reconciler.make(BoundEditor)
```

Its Effect environment includes:

```text
Scope.Scope
+
all root requirements inferred from lifetime startup Effects
```

Closing the surrounding Scope shuts the Controller down and finalizes owned lifetime Scopes.

No separate manual global runtime is required.

---

# 26. Commit

The control-plane mutation boundary is:

```ts
controller.commit(state)
```

Semantics:

> **Evaluate the Binding against one immutable state value and atomically replace the Controller's authoritative desired snapshot.**

A successful commit means:

```text
new desire definitely published
```

not:

```text
runtime converged
```

Commit must not await:

```text
startup
shutdown of obsolete generations
provider readiness
finalizers
full reconciliation
```

---

# 27. Commit interruption and linearization

The intended Effect behavior is:

```text
selector evaluation
→ interruptible

validation
→ interruptible

waiting for controller serialization
→ interruptible

small publication region
→ uninterruptible / atomic
```

Contract:

```text
interrupted before publication
→ nothing published

commit returns successfully
→ desire definitely published exactly once
```

No user-visible `"maybe committed"` state.

---

# 28. Equivalent commits

If two states produce semantically equal desired lifetimes according to Effect key equality:

```text
commit(state1)
commit(state2)
```

the second commit must create no lifecycle churn.

The state object itself need not be referentially equal.

---

# 29. Retry boundaries

Two kinds of retry must remain distinct.

## 29.1 Retry inside startup

Transient operational retries belong inside normal Effect code:

```ts
start: key =>
  acquire(key).pipe(
    Effect.retry(schedule)
  )
```

This remains one physical generation and one Scope.

Use this when acquisition attempts are part of one logical startup.

---

## 29.2 Retry a Failed physical generation

A failed reconciled generation can be explicitly replaced while preserving semantic identity:

```ts
yield* controller.retry(ref)
```

Meaning:

> If `ref` is still desired and its current physical generation is `Failed`, retire that generation and permit a fresh physical generation when admission conditions allow.

Rules:

- no semantic-key change;
- no retry nonce in application Model;
- Running lifetime => no-op;
- no longer desired => no-op;
- repeated retry => idempotent;
- closed controller => `ControllerClosed`;
- sequential replacement waits for required failed-generation cleanup;
- provider/owner admission rules still apply.

This is **generation restart**, not a general retry/supervision DSL.

---

# 30. Failure observation

Application correctness must not depend solely on a lossy ephemeral event.

The stable model should separate:

```text
authoritative semantic status
+
live notification convenience
```

## 30.1 Authoritative status

A minimal API should make current state queryable.

Candidate:

```ts
controller.status(ref)
```

returning conceptually:

```ts
Option.Option<
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Running" }
  | {
      readonly _tag: "Failed"
      readonly cause: Cause.Cause<unknown>
    }
  | { readonly _tag: "Stopping" }
>
```

Alternative:

```ts
controller.snapshot
```

if real application use cases show multi-lifetime inspection is needed.

Do not stabilize both prematurely.

---

## 30.2 Notifications

A live failure/change stream may exist as a convenience.

Prefer exposing an Effect `Stream`-shaped API over leaking the internal PubSub primitive if public ergonomics benefit:

```ts
controller.changes
```

or:

```ts
controller.failures
```

The notification API must clearly document:

```text
delivery guarantees
buffering
loss behavior
subscription lifetime
```

If notifications are lossy, status remains authoritative.

---

# 31. LifetimeRef

`LifetimeRef` is the stable semantic identity used by:

```text
failure observation
retry
status lookup
future diagnostics
```

Conceptually:

```ts
interface LifetimeRef<H extends LifetimeFamily.Any> {
  readonly family: H
  readonly key: LifetimeFamily.Key<H>
  readonly owner: LifetimeFamily.Owner<H>
}
```

It must be created by the Reconciler/Binding runtime rather than freely forged from arbitrary values unless a validated constructor is intentionally added later.

No physical generation appears in the ref.

---

# 32. Public error model

Expected public errors should be Effect-style tagged errors.

Conceptually:

```ts
class ControllerClosed
  extends Data.TaggedError("ControllerClosed") {}

class InvalidDesiredState
  extends Data.TaggedError("InvalidDesiredState")<{
    readonly reason: InvalidDesiredStateReason
  }> {}
```

Definition errors should be discriminated:

```ts
type DefinitionError =
  | ForeignOwner
  | OwnershipCycle
  | ForeignRequirement
  | CapabilityCycle
  | AmbiguousProvider
  | UnresolvableProvider
```

Binding errors should be discriminated:

```ts
type BindingError =
  | ForeignHandle
  | MissingBinding
  | DuplicateBinding
  | CardinalityMismatch
```

The goal is compatibility with idiomatic:

```ts
Effect.catchTag(...)
Effect.catchTags(...)
```

String formatting is diagnostic presentation, not semantic structure.

---

# 33. Internal defects

Impossible states caused by a reconciler implementation bug should die/defect.

Examples:

```text
compiled ownership invariant violated
live instance references impossible family id
provider index internally inconsistent
double-finalization bookkeeping invariant broken
```

Do not convert implementation defects into broad user-recoverable `ReconcilerError`.

---

# 34. Root environment

Static application-wide dependencies remain ordinary Effect environment requirements.

Examples:

```text
Logger
Clock
Filesystem
Telemetry
Platform
Backend
```

They do not need reconciled families merely because dynamic lifetimes use them.

Use a reconciled family only when the **existence or semantic identity of the lifetime itself** changes according to control state.

---

# 35. Foldkit integration

Foldkit remains a natural control plane.

```text
Message
  ↓
pure update
  ↓
committed Model
  ├──► View
  ├──► Commands
  └──► controller.commit(model)
```

Rule:

> **Only committed Models are passed to the Reconciler, in the same serialized order as Model transitions.**

The Foldkit update loop must not await lifecycle convergence.

---

# 36. Event causality vs state causality

Keep the conceptual distinction:

```text
Because X happened...
→ Command / ordinary finite Effect

While current state desires X...
→ Reconciled lifetime
```

Examples:

```text
user clicked Save
→ Command
```

```text
user is signed in as Alice
→ Session[alice] desired
```

```text
document foo is open
→ Analyzer[foo] desired
```

---

# 37. Runtime state vs domain state

The Reconciler may know:

```text
Starting
Running
Failed
Stopping
```

This does not automatically make those values application Model state.

Put a runtime fact into the application Model only when the domain/UI genuinely cares.

Example:

```text
Server Failed
```

may become:

```text
serverUnavailable = true
```

because the UI displays it.

Do not mirror the entire reconciler state machine into Model.

---

# 38. Application outputs remain stale-checkable

Cancellation cannot retract an application event already emitted.

Example:

```text
Analyzer emits result
↓
Message queued
↓
Analyzer becomes obsolete
```

Therefore reducer/domain validation still owns stale-domain-result protection where necessary.

Rule:

> **Reconciler generation safety protects execution environments; domain validation protects already-emitted application facts.**

---

# 39. Observation boundaries

Stable public observation may expose:

```text
family handle
semantic key
semantic owner path
semantic status
startup failure cause
```

It should not expose:

```text
Scope
Fiber
Context object
physical generation number
desired revision
reconcile pass count
slot identity
provider reverse index
scheduler ordering
```

This keeps the compatibility surface semantic.

---

# 40. Controller API target

The target minimal Controller is approximately:

```ts
interface Controller<State> {
  readonly commit:
    (state: State) =>
      Effect.Effect<void, CommitError>

  readonly retry:
    (ref: LifetimeRef<LifetimeFamily.Any>) =>
      Effect.Effect<void, ControllerClosed>

  readonly status:
    (
      ref: LifetimeRef<LifetimeFamily.Any>
    ) =>
      Effect.Effect<
        Option.Option<LifetimeStatus>
      >

  readonly shutdown:
    Effect.Effect<void>
}
```

A live observation stream may be added only if real application use proves it earns stable API surface.

`shutdown` may remain public even though Controller construction is Scope-owned because explicit early shutdown is useful.

Do not grow Controller into a general resource command object.

Avoid:

```text
start
forceStart
stop
restartChildren
pause
resume
rebind
invalidateEverything
```

unless separately justified.

---

# 41. Definition API target

Conceptually:

```ts
const Editor =
  Reconciler.define(define => {
    const Settings =
      define.one("Settings", {
        start:
          (revision: number) =>
            Effect.succeed(
              Context.make(
                SettingsService,
                { revision }
              )
            )
      })

    const Session =
      define.one("Session", {
        replacement:
          Replacement.overlap(),

        start:
          (userId: string) =>
            Effect.succeed(
              Context.make(
                SessionService,
                { userId }
              )
            )
      })

    const Workspace =
      define.one("Workspace", {
        owner:
          Session,

        replacement:
          Replacement.sequential(),

        start:
          (workspaceId: string) =>
            Workspace.open(workspaceId)
      })

    const Language =
      define.one("Language", {
        owner:
          Workspace,

        start:
          (language: string) =>
            LanguageServer.open(language).pipe(
              Effect.map(server =>
                Context.make(
                  LanguageServerService,
                  server
                )
              )
            )
      })

    const Document =
      define.many("Document", {
        owner:
          Workspace,

        start:
          (uri: string) =>
            Effect.succeed(
              Context.make(
                DocumentService,
                { uri }
              )
            )
      })

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
          (_: null) =>
            Effect.gen(function* () {
              const settings =
                yield* SettingsService

              const language =
                yield* LanguageServerService

              const document =
                yield* DocumentService

              yield* Diagnostics.run({
                settings,
                language,
                document
              })
            })
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

Notably absent:

```text
custom Key.string
custom Context accessor
custom resource acquisition API
custom retry schedule
custom finalizer API
```

---

# 42. Binding API target

```ts
const BoundEditor =
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
        model =>
          model.workspaceId
      ),

    language:
      bind.one(
        Editor.Language,
        model =>
          Option.some(
            model.language
          )
      ),

    documents:
      bind.many(
        Editor.Document,
        model =>
          model.openDocuments
      ),

    diagnostics:
      bind.one(
        Editor.Diagnostics,
        () =>
          Option.some(null)
      )
  }))
```

Owned selectors may use their typed semantic Owner reference when needed:

```ts
bind.many(
  Editor.Document,
  (model, workspace) =>
    documentsFor(
      model,
      workspace.parent.key,
      workspace.key
    )
)
```

---

# 43. Effect-native transient retry example

```ts
const Server =
  define.one("Server", {
    owner:
      Workspace,

    start:
      (language: string) =>
        Effect.acquireRelease(
          openServer(language).pipe(
            Effect.retry(
              Schedule.exponential("100 millis").pipe(
                Schedule.intersect(
                  Schedule.recurs(4)
                )
              )
            )
          ),
          closeServer
        ).pipe(
          Effect.map(server =>
            Context.make(
              ServerService,
              server
            )
          )
        )
  })
```

The Reconciler does not need to understand this retry schedule.

If the Effect ultimately fails, the physical lifetime becomes `Failed`.

A later explicit:

```ts
controller.retry(ref)
```

creates a new physical generation.

---

# 44. Layer interoperability

A lifetime may build a Layer in its own instance Scope.

Conceptually:

```ts
start: key =>
  Effect.gen(function* () {
    const scope =
      yield* Effect.scope

    const context =
      yield* Layer.buildWithScope(
        makeLayer(key),
        scope
      )

    return context
  })
```

This is preferable to inventing special Reconciler Layer semantics in v0.x.

If repeated Layer integration later proves cumbersome, a small helper may be added:

```ts
Reconciler.fromLayer(...)
```

only after real usage evidence.

---

# 45. Type inference goals

The public API should infer:

```text
semantic key type
owner semantic reference type
services published by returned Context
services available from owner ancestry
services available from named dynamic providers
remaining root Effect requirements
startup error type
```

without pervasive explicit generics.

Type-level misuse should reject:

```text
one handle used with bind.many
many handle used with bind.one
wrong key type
foreign Definition handle
invalid owner
missing binding
ambiguous provider
startup requirement not supplied by root/owner/providers
```

---

# 46. Testing conventions

Use `@effect/vitest`.

Concurrency tests should prefer deterministic Effect synchronization:

```text
Deferred
Semaphore
explicit gates
test-only convergence barriers
```

rather than arbitrary sleeps.

Real-time timeout windows should be used only where the absence of an event must be observed and no stronger synchronization is possible.

Required conformance includes:

```text
equal semantic keys retain generation
changed keys replace
owner invalidation dominates descendants
provider replacement invalidates dependents only
late startup cannot publish
provider generations never mix
sequential replacement honors finalization
overlap replacement permits safe coexistence
latest desire coalesces intermediate states
commit is non-blocking
commit has a clear linearization point
same-key retry creates a fresh failed generation replacement
retry does not alter semantic identity
shutdown is structured and idempotent
```

---

# 47. Performance conventions

Correctness should not depend on incremental optimization.

The simple implementation may:

```text
evaluate full Binding
sweep current live instances
```

as long as measured target workloads remain acceptable.

Do not add complex reactive dependency tracking until benchmarks show the need.

Optimization order, if justified:

1. reverse provider → dependent indexes;
2. dirty semantic-slot queues;
3. dirty-family queues;
4. incremental Binding invalidation.

Preserve full-snapshot-equivalent semantics.

---

# 48. Package identity and dependency rules

Before publication:

- use an unforgeable per-Definition identity object;
- do not rely on module-local numeric Definition IDs across package copies;
- keep Effect as a peer dependency;
- avoid `instanceof` as cross-package semantic identity;
- use opaque handles and Effect-compatible runtime brands;
- document one-version expectations if multiple package copies cannot safely interoperate.

---

# 49. Public non-goals

`effect-reconciler` is not:

```text
an actor framework
a durable workflow engine
a query cache
a distributed scheduler
a service mesh
a renderer
a state-management framework
a replacement for Layer
a replacement for RcMap / LayerMap
a general supervision DSL
```

It should remain:

> **state-reconciled keyed Effect lifetimes.**

---

# 50. Decision rules for future features

Before adding a feature, ask:

### Does Effect already solve this inside one lifetime?

If yes, use Effect.

Examples:

```text
retry
timeout
logging
metrics
tracing
resource cleanup
child fibers
service construction
```

### Is this specifically about reconciling semantic lifetime existence?

If yes, it may belong in `effect-reconciler`.

Examples:

```text
desired identity
owner-relative lifetime admission
provider-generation invalidation
same-key failed-generation restart
semantic status
```

This boundary should be treated as a core architectural constraint.

---

# 51. Effect-idiomatic litmus test

For every API change ask:

> **Once the Reconciler has decided that a lifetime should exist, does the code inside that lifetime look like normal Effect code?**

The desired answer is always:

```text
yes
```

If application resource code begins requiring a Reconciler-specific:

```text
Context
Task
Fiber
Scope
Layer
retry
error
```

abstraction, the package is drifting away from Effect idioms.

---

# 52. Migration from the current v0 kernel

The following changes should be implemented experimentally before calling this specification stable.

## Phase A — semantic identity

1. introduce `LifetimeRef`;
2. use family handle identity, not family label identity;
3. replace numeric Definition identity with an object token.

## Phase B — retry

4. implement `Controller.retry(ref)`;
5. prove same-key retry semantics;
6. keep `Effect.retry` as the transient-startup mechanism.

## Phase C — key alignment

7. prototype removing public encoded `Key` descriptors;
8. use `Equal.equals` and `Hash.hash` for semantic key identity;
9. type-test primitives and Effect `Data` structural values;
10. benchmark Hash/Equal-based semantic maps against current encoded strings.

Do not switch the public API until runtime and type tests show parity.

## Phase D — errors

11. replace stringly `DefinitionError` / `BindingError` reasons with tagged cases;
12. verify ergonomic `Effect.catchTag` / `catchTags` usage.

## Phase E — observation

13. make current Failed state authoritative/queryable;
14. decide whether live notifications are public;
15. if public, document buffering/loss semantics;
16. prefer Stream-shaped observation over exposing raw PubSub where practical.

## Phase F — validation

17. migrate one pre-existing Foldkit feature;
18. add real user-visible same-key Retry;
19. measure application coordination deletion and adoption cost;
20. update the main specification only after implementation evidence.

---

# 53. Go criteria for the idiomatic redesign

Adopt this Effect-idiomatic surface if:

```text
ordinary Effect services remain ordinary Context services
Layer remains interoperable without special semantics
Equal/Hash identity is ergonomic and performant
tagged errors improve recovery ergonomics
same-key retry does not pollute Model state
Controller remains small
real Foldkit code becomes simpler
```

Reconsider any change that causes:

```text
parallel dependency-injection API
parallel resource API
parallel retry/schedule API
parallel cancellation API
excess controller commands
key boilerplate worse than Effect data values
```

---

# 54. Final definition

`effect-reconciler` should be described as:

> **An Effect-native reconciler that maps immutable control state to desired keyed lifetimes, realizes lifetime ownership with Effect Scopes, supplies immutable generation-bound capabilities through Effect Context, and leaves resource acquisition, service construction, retry policy, interruption, and finalization to ordinary Effect.**

More compactly:

> **State to structured Effect lifetimes.**

The architectural rule is:

> **The Reconciler decides what should exist. Effect decides how it runs.**

---

# 55. Reference alignment

This draft is intentionally aligned with current Effect conventions visible in the Effect source and documentation:

- [`Scope`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Scope.ts) — Scope as a resource lifetime boundary.
- [`Context`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Context.ts) — typed services used directly as Effect requirements.
- [`Layer`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Layer.ts) — scoped service construction and wiring.
- [`Equal`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Equal.ts) and [`Hash`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Hash.ts) — Effect-native value equality and hashing.
- [`RcMap`](https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/RcMap.ts) — keyed, scoped, reference-counted resources using Effect equality/hash conventions for complex keys.
- [`LayerMap`](https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/LayerMap.ts) — keyed service contexts built from Layers.
- [`Data`](https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/Data.ts) — immutable data and tagged yieldable errors suitable for typed error channels.

Repository implementation target:

- `chr33s/effect-reconciler`
- current kernel API centered on `Reconciler.define`, `Definition.bind`, `Reconciler.make`, and `Controller.commit`.
