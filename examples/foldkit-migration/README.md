# Migrating an existing Foldkit app

This is the migration `docs/spec.md` §16.2 asks for: a feature that **existed before `effect-reconciler` did**, moved onto it,
measured, and reported including the parts that did not pay off.

```sh
npm test                            # both versions, same user story
node examples/foldkit-migration/metrics.mjs
```

## Provenance

`before/main.ts` is `examples/managed-resource-layer/src/main.ts` from
[foldkit/foldkit](https://github.com/foldkit/foldkit) (MIT), taken as-is apart
from three mechanical changes, none of which touch how the resource's lifetime
is coordinated:

- the view, its `@foldkit/ui` imports and the `Runtime.makeElement` entry point
  are dropped — this comparison measures coordination, not rendering — so
  `init` becomes a plain Model;
- the engine layer moves to `engine.ts`, where its id comes from a counter
  rather than browser crypto, so the run is deterministic and headless;
- `evo` from `foldkit/struct` is spelled as an object spread, to avoid pulling
  the helper in for three call sites.

Both versions run on `../foldkit/driver.ts`, the headless stand-in for the
Foldkit runtime's Message loop, Commands and Managed Resources.

## What the app does

One compute engine, built from a `Layer`, that exists only while the user wants
it. `Compute` squares a counter using the engine, and skips when there is none.
It is a **single flat resource**: no ownership, no capability dependencies, no
keyed children, no churn. `docs/spec.md` §16.2 explicitly warns against
validating on exactly this shape — which is why it is worth doing.

## What the tests show

`migration.test.ts` runs one user story against both versions and asserts
against the **engine's own log**, not the Model: boot on demand, compute
against it, tear down on stop, a fresh engine on restart, a boot failure
surfaced to the UI, a compute skipped while it is down, and recovery. Both
versions produce identical engine behaviour.

Their Models deliberately do not match. Replacing the lifecycle half of the
Model is the migration.

## Measurement

```text
metric                                        before   after
------------------------------------------------------------
Model fields, total                                3       4
Model fields, lifecycle-only                       1       0
Lifecycle state-machine variants                   4       0
Message variants, total                            8       6
Message variants, lifecycle-only                   3       1
Resource-availability handling in commands         1       0
Definition + Binding SLOC                          0      18
Integration SLOC (holder, wiring, retry)           0      41
Application SLOC, whole feature                    92     124
```

## Findings

**1. On a single flat resource, this does not pay for itself.** The migrated
app is 35% *larger*. It deletes a four-state machine, two of three lifecycle
Messages and the resource-availability branch in a Command, and pays 18 lines
of Definition and Binding plus 41 lines of integration for it. The integration
is a per-application cost that would be amortised across many families — but
with exactly one family there is nothing to amortise it over. The purpose-built
multi-lifetime comparison in `../foldkit` shows −57% coordination SLOC; this
one shows +35% total. Both numbers are real, and the difference between them is
the shape of the problem, not the quality of the code.

**2. The clearest win is structural, not numeric.** Upstream, `EngineState` is
simultaneously the user's intent (`Booting` means "I want one") and the
runtime's status (`Ready`, `Failed`) — the resource's requirements are derived
by matching on the very state the resource's own callbacks write back. It is a
loop, and it is the reason the Model has a state machine at all. After the
migration, intent is `engineWanted: boolean` and status is
`controller.status(ref)`; the loop is gone. That would remain true if the line
count were identical.

**3. "Click Start again" was an implicit retry.** Upstream, clicking Start
after a failure re-acquired the engine because the Model went
`Failed → Booting`, which changed the Managed Resource's requirements. With
desire expressed directly, clicking Start when the engine is already wanted
changes nothing — so the migrated version says what it always meant:
`controller.retry(engineRef)`. Same-key retry (`docs/spec.md` §9.3) earned its
place here by being *required*, and the upstream app's own behaviour is what
demanded it, not a design argument.

**4. There is no way to use a lifetime's services from outside a lifetime.**
Foldkit's `Resource.get` lets an ordinary Command use the resource. The
reconciler publishes capabilities *into* lifetimes and nowhere else, so the
migration adds an application-owned holder that the lifetime fills on start and
clears on teardown — about 20 of the 41 integration lines. This is the single
largest piece of adoption friction found, and the strongest candidate for a
future API.

It is deliberately **not** being added now. The Controller API stays frozen
through this migration; one data point is not enough to design an API around,
and an application-owned holder is a perfectly serviceable answer in the
meantime.

**5. Layer interop needed nothing.** `Layer.build(engineLayer)` inside the
lifetime's Scope publishes its Context to the family, exactly as the upstream
`acquire` built it into the resource's Scope. No reconciler-specific Layer
support was needed, which is what `docs/spec.md` §12.2 hoped for.

**6. The upstream app found two bugs in the test harness.** Running real code
through the driver exposed that a failed acquisition must be retried once
requirements go away and come back, and that the framework's resource service
is a `Ref<Option<Value>>` rather than the value. Both are fixed in
`../foldkit/driver.ts`. Purpose-built examples had not exercised either path.

## What this does not settle

One migration of one feature, whose shape is the least favourable case for this
abstraction. It says the migration is *possible*, *behaviour-preserving* and
*mechanical*, and it says where the friction is. It does not establish the
value case; a feature with keyed children, ownership and capability
dependencies would, and that is what the GO / SHRINK / STOP decision still
needs.
