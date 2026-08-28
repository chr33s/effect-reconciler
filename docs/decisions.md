# Decisions

Why `effect-reconciler` is shaped the way it is. Each entry states the decision,
what it rules out, and where the evidence lives, so the reasoning survives
contact with new contributors and new use cases.

---

## 1. Definition and Binding are separate

A Definition declares the static architecture: families, cardinality, semantic
key equality, ownership, capability requirements, startup, replacement policy.
A Binding maps one control-state type into desired keys for those families.

**Why.** The architecture of an application's dynamic resources does not change
when its state shape does. Keeping them separate means one Definition can be
bound to a Foldkit Model, to a daemon's config, and to a test's fixture without
restating the topology — and the type-misuse assertions catch a Binding that
does not match the Definition it names.

**Rules out.** A single fused "resource description + state selector" object,
which would make the architecture unusable outside the state type it was born
in.

**Evidence.** `test/identity.test.ts` binds one Definition to two state types;
`examples/editor.ts` does the same for two control planes.

---

## 2. Topology is internal vocabulary

Applications say `owner:` and `requires:`. They never see, name, or order the
ownership tree, the capability DAG, the reconcile pass, slots, or generations.

**Why.** Every internal structure an application can name becomes a
compatibility obligation (Hyrum's Law, spec §58). The runtime must stay free to
change how it converges.

**Rules out.** Public topology inspection, ordering guarantees between
unrelated families, and DevTools built on internal identity.

---

## 3. Semantic key, not physical generation

Identity is `family + semantic key + owner path`. A physical generation is an
implementation detail with no public name.

**Why.** Applications reason about *what should exist*; the runtime reasons
about *what does exist*. Conflating them is what forces retry nonces and
generation counters into domain state.

**Evidence.** `docs/spec.md` §92; `test/identity.test.ts`.

---

## 4. Ownership and capability dependency are different relations

`owner:` means "cannot outlive"; `requires:` means "cannot run without". A
family has exactly one owner and any number of requirements.

**Why.** Collapsing them into one relation would force either a spurious tree
(a resource cannot have two owners) or a spurious DAG (a child must die with
its parent, which a dependency does not imply).

**Evidence.** `test/ownership.test.ts` and `test/dependencies.test.ts` prove
the two invalidation behaviours differ.

---

## 5. Provider replacement replaces dependents; it never rebinds them

When a provider generation is superseded, its dependents are structurally
replaced rather than silently pointed at the new generation.

**Why.** A dependent captured one internally consistent set of provider
capabilities at admission. Rebinding it mid-life would let a resource observe
two generations of its provider, which is the exact race applications write by
hand and get wrong.

**Evidence.** `test/environmentIsolation.test.ts`, `test/dependencies.test.ts`.

---

## 6. Commit is non-blocking and non-convergent

`commit` evaluates selectors, validates, and atomically publishes desire. It
never awaits startup, shutdown or convergence.

**Why.** The control plane's transaction — a Foldkit Message, an HTTP handler —
must not be held open by resource latency. Convergence is the runtime's job and
happens after.

**Rules out.** An `awaitConvergence` in the commit path. Applications that need
to know whether something is up ask `status`.

**Evidence.** `test/commit.test.ts`, including the linearization-point tests.

---

## 7. Ambiguous `many` providers are rejected

A requirement resolves to an ancestor instance, or to the unique `one` instance
owned by an ancestor or root. A `many` provider is rejected at compile time.

**Why.** With a `many` provider there is no single defensible answer to "which
one?", and inventing one (first, newest, matching key) would bake a selection
policy into the kernel before any real workload asked for it.

**Reconsider when.** A real migration repeatedly needs
`Document[foo] requires LanguageServer[typescript]`. `docs/spec.2.md` §11
tracks that pressure; an explicit selection mechanism is the answer if it
recurs, not a default.

**Evidence.** `test/dependencies.test.ts` (`§25 — ambiguous providers are
rejected at creation`).

---

## 8. Retry is explicit, never key pollution

A failed generation holds its slot, so recommitting the same state changes
nothing. `Controller.retry(ref)` retires the failed generation under the same
semantic key.

**Why.** The alternatives all put operational state into domain identity: a
retry nonce in the key, withdrawing and restoring desire, or an unrelated model
change. The example measures this precisely — the Foldkit version needs a
`serverAttempt` counter threaded into its resource requirements; the reconciler
version needs nothing.

**Evidence.** `docs/spec.md` §93–§94, `test/retry.test.ts`,
`examples/foldkit/scenario.test.ts`.

---

## 9. Observability is semantic, and status outranks events

`status(ref)` is authoritative; the failure stream is a live, bounded,
best-effort convenience. Neither exposes generations, Fibers, Scopes or
reconcile ordering.

**Why.** An application that turns a failure into UI state must be able to
recover that state after a missed notification, or the notification becomes a
second source of truth that can drift. Publication must also never block
reconciliation, which forces the stream to be lossy — so it cannot be the
authority.

**Evidence.** `docs/spec.md` §95, `test/observation.test.ts`.

---

## 10. Optimization waits for measured pressure

Binding evaluation and the reconcile sweep are O(N) per commit. No dirty-slot
queues, dirty-family queues, incremental selector graphs or reverse
invalidation schedulers exist.

**Why.** The benchmark shows churn is already scale-invariant and selective:
zero churn on an equivalent commit, two starts and two stops for one changed
document whether there are 100 or 10,000. What scales with N is selector
evaluation — ~7ms at 10,000 lifetimes, at the caller's boundary rather than
holding the controller. Adding incremental machinery now would trade a simple,
provably correct pass for cache-invalidation bugs, against no measured need.

**Reconsider when.** A real workload shows selector evaluation or the reconcile
sweep consuming a meaningful share of its frame or latency budget.

**Evidence.** `bench/RESULTS.md`.
