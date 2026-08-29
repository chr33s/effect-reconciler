# Scale benchmark

Run with `npm run bench`. These are the numbers **before** any incremental
optimization exists: no dirty-slot or dirty-family queues, no incremental
binding invalidation, and no way to avoid the full sweep of live instances that
every reconcile pass does. The point of recording them is to know which of
those, if any, a real workload actually needs.

Obsolescence *does* travel a reverse provider-to-dependent index, but that is
not one of the optimizations above: it replaced a fixpoint sweep with a walk of
the same edges, and it is measurably neither faster nor slower here.

Recorded 2026-08-28 · Node v24.18.1 · darwin arm64 · Apple M5 Max.

## Method

Each scenario is a *transition*, so it is measured by applying it repeatedly
and returning to the previous state in between. One full round is run and
discarded to warm up, then seven samples are taken of the applied direction
only. Both halves of the cost are reported, because they are paid by different
people:

- **commit** — how long `controller.commit(model)` blocks the caller. This is
  latency at the application's mutation boundary, inside its update loop.
- **converge** — how long the runtime then takes to reach the new desire, in
  the background.

p50 and p95 are reported rather than a single measurement: the distribution is
skewed by GC and by the first pass after a snapshot changes, and a lone sample
hides that. The cold build is a single sample, because an application only ever
starts once.

Each figure below is the **median of three whole runs** of that seven-sample
method, not one run. A single run is not enough: at 10,000 documents the commit
column is bimodal between roughly 9 ms and 13 ms, and which mode a run lands in
has nothing to do with the code under test. Comparing two single runs at that
size produces differences of ±50% that reproduce in neither direction.

> **Convergence timings before and after 2026-08-28 are not comparable at 100
> and 1,000 documents.** `converge` is measured with the test-hook convergence
> barrier, and that barrier used to poll on a 1 ms timer, which put a ~1 ms
> floor under every sample. It is now signalled at the end of a reconcile pass.
> At 100 documents the previously recorded converge figures were largely that
> floor — the equivalent commit, which starts and stops nothing at all, was
> recorded at 1.43 ms and now measures 0.16 ms. The runtime did not get faster;
> the measurement stopped including the poll. The 10,000-document figures are
> unaffected, since a pass there takes far longer than the poll interval.

| documents | scenario | commit p50 | commit p95 | converge p50 | converge p95 | selector evals | starts | stops |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | build (cold, one sample) | 0.69 | 0.69 | 3.96 | 3.96 | 105 | 204 | 0 |
| 100 | A equivalent commit | 0.11 | 0.17 | 0.16 | 0.49 | 105 | 0 | 0 |
| 100 | B one document changed | 0.08 | 0.10 | 0.24 | 2.42 | 105 | 2 | 2 |
| 100 | C settings replaced | 0.10 | 0.36 | 1.79 | 2.78 | 105 | 101 | 101 |
| 100 | D language replaced | 0.09 | 0.47 | 1.33 | 2.62 | 105 | 101 | 101 |
| 100 | E workspace replaced | 0.09 | 0.19 | 1.73 | 4.78 | 105 | 202 | 202 |
| 1000 | build (cold, one sample) | 0.88 | 0.88 | 17.55 | 17.55 | 1005 | 2004 | 0 |
| 1000 | A equivalent commit | 0.74 | 1.82 | 1.16 | 2.46 | 1005 | 0 | 0 |
| 1000 | B one document changed | 0.68 | 0.71 | 1.27 | 4.99 | 1005 | 2 | 2 |
| 1000 | C settings replaced | 0.75 | 3.10 | 16.78 | 18.52 | 1005 | 1001 | 1001 |
| 1000 | D language replaced | 0.74 | 0.77 | 16.17 | 29.60 | 1005 | 1001 | 1001 |
| 1000 | E workspace replaced | 0.72 | 0.74 | 17.66 | 40.28 | 1005 | 2002 | 2002 |
| 10000 | build (cold, one sample) | 8.73 | 8.73 | 153.45 | 153.45 | 10005 | 20004 | 0 |
| 10000 | A equivalent commit | 8.82 | 21.09 | 25.73 | 35.22 | 10005 | 0 | 0 |
| 10000 | B one document changed | 8.98 | 9.76 | 32.42 | 46.28 | 10005 | 2 | 2 |
| 10000 | C settings replaced | 13.22 | 16.09 | 193.48 | 344.19 | 10005 | 10001 | 10001 |
| 10000 | D language replaced | 9.72 | 34.58 | 203.07 | 400.22 | 10005 | 10001 | 10001 |
| 10000 | E workspace replaced | 8.73 | 14.43 | 216.97 | 240.64 | 10005 | 20002 | 20002 |

The topology is the editor from the specification, so each document carries a
`Diagnostics` child that depends on both `Settings` and `Language`: a build of
N documents is `2N + 4` lifetimes.

## What the churn columns say

The scenarios the benchmark asserts, at every size:

- **A — equivalent commit: exactly zero churn.** Semantically equal desire
  never touches a lifetime, so an application can commit on every state
  transition without rate-limiting it.
- **B — one document changed: exactly 2 starts and 2 stops**, at 100 and at
  10,000 alike. Only the removed document with its diagnostics child and the
  added one with its own move; the other N−1 documents are untouched.
- **C / D — provider replaced: `N + 1` restarts, and every Document is
  retained.** Replacing `Settings` or `Language` structurally replaces exactly
  the dependents that captured that provider generation.
- **E — workspace replaced: `2N + 2`**, the whole owned subtree. This is the
  intended worst case: an owner's identity changing invalidates everything
  beneath it.

Churn is scale-invariant where it should be. Nothing here suggests a
correctness-level scaling problem.

## Where the cost actually is

Two costs scale with N rather than with the size of the change:

1. **Selector evaluation is `N + 5` on every commit**, including the equivalent
   commit that produces no work at all. The whole binding is re-evaluated
   against the new state, which is what makes commits pure and coalescing
   trivial — but it is also the entire cost of a no-op commit.
2. **Commit latency tracks that evaluation**: ~0.1 ms at 100 documents, ~0.7 ms
   at 1,000, and at 10,000 a p50 of ~9 ms with a p95 near 21 ms. Selector
   evaluation happens outside the critical section and outside the atomic
   publication region, so this is latency at the caller's mutation boundary,
   not time holding the controller.

At 10,000 documents a no-op commit costs about 9 ms of pure selector work (p95
~21 ms) plus about 26 ms of background convergence to confirm there is nothing
to do. For an editor-sized workload — hundreds to low thousands of documents —
commit is under a millisecond and needs nothing further.

The p95 columns are worth reading before optimizing anything: at 10,000
documents the tail is 2–4× the median for commits and about 2× for convergence
on the provider-replacement scenarios, which is GC and
first-pass-after-a-snapshot cost, not a different algorithm.

## When to optimize

Incremental machinery — dirty-slot or dirty-family queues, incremental binding
invalidation — is worth adding when a real workload shows one of:

- commits at a rate where `N + 5` selector evaluations per commit dominate the
  frame budget (roughly: >10,000 instances committed on every keystroke, where
  the p95 commit already exceeds a frame), or
- a reconcile pass whose full sweep of live instances becomes visible next to
  the lifecycle work it schedules.

Neither is visible at these sizes for an editor-shaped workload. The
measurement, not the shape of the code, should decide.

## Identity: encoded strings versus Effect `Equal` / `Hash`

Effect-native key identity had to be benchmarked against the encoded-string
scheme it replaced, with the public API not switching until parity was shown
(`docs/spec.md` §13.10).

Both were measured at 10,000 documents — the size where the difference is
visible at all — under the *previous* single-sample methodology. They are
comparable to each other, but not to the p50/p95 table above.

| scenario (single sample) | encoded strings | Effect identity |
| :--- | ---: | ---: |
| build, converge ms | 174.2 | 177.3 |
| A equivalent commit, converge ms | 12.6 | 18.4 |
| B one document changed, converge ms | 21.7 | 19.6 |
| C settings replaced, converge ms | 163.4 | 181.7 |
| D language replaced, converge ms | 164.6 | 206.2 |
| E workspace replaced, converge ms | 201.5 | 212.9 |

Every churn and selector-evaluation count is **identical** between the two: the
switch changed how identity is computed, not what is identical to what.

The first implementation was about 2× slower on the convergence path, which is
not parity. Three changes closed the gap, none of them incremental dependency
tracking (`docs/spec.md` §15 — full-snapshot semantics are preserved):

1. semantic identities cache their hash and compare hashes before walking the
   key or the owner chain;
2. each desired node's replacement-slot identity is computed once with the
   snapshot rather than per reconcile pass;
3. desire is matched to live instances once per published snapshot, so the
   admission phase skips already-satisfied nodes without hashing anything.

What remains is a 10–25% convergence cost at 10,000 lifetimes, against a
commit path that is unchanged and a public API with no key descriptors in it.
That was judged worth it. If a real workload ever disagrees, the numbers to
beat are in this table.

## The change signal costs nothing measurable

`Controller.changes` (`docs/spec.md` §9.5) adds two things to the reconcile
path: an integer increment inside the four live-state transitions, and, at the
end of each pass, one integer comparison plus — only when that comparison says
something moved — a publish into a capacity-1 sliding `PubSub`. Nothing is
walked, and nothing is allocated per lifetime.

Re-running the table above after adding it reproduces every churn and
selector-evaluation count exactly, and every timing within the run-to-run
spread this document already warns about at 10,000 documents. That is a single
run against a table of three-run medians, so it is evidence that nothing
regressed by a visible margin, not a new measurement: the table was left as
recorded rather than overwritten with a less careful one.

The interesting cost is the one that was *removed*, and it is not in this
table because it was never in the kernel. `examples/ui` previously re-read
every watched lifetime's status every 250 ms forever, converged or not.
`examples/ui/mirror.test.ts` now asserts zero reads across a 400 ms idle
window. For an observer, the change is not a percentage — it is the difference
between work proportional to time and work proportional to transitions.

## Incremental bindings: a win on unchanged data, a loss on changed data

`deps` (`docs/spec.md` §9.9) lets a Binding declare what a selector reads, so
the runtime can skip the call — and reuse the semantic identities it produced
last time — when those inputs are unchanged. The A/B below runs the same
topology and the same scenarios at 10,000 documents, twice: once as the full
sweep, once with `deps` on both the `Document` selector and the per-document
`Diagnostics` selector.

| scenario | commit p50 | commit p95 | converge p50 | selector evals |
| :--- | ---: | ---: | ---: | ---: |
| A equivalent commit, full sweep | 7.84 | 12.54 | 17.21 | 10005 |
| A equivalent commit, incremental | **6.92** | **7.67** | **1.73** | **4** |
| B one document changed, full sweep | **8.25** | **15.56** | 22.26 | 10005 |
| B one document changed, incremental | 23.81 | 29.06 | **5.52** | 6 |

Read the two rows that matter together:

- **Unchanged data is about three times cheaper end to end** — 25 ms of commit
  plus convergence becomes 8.6 ms. Most of that is not the skipped selectors;
  it is the reused identities. An identity caches its hash, so a pass over
  reused ones does cached reads where a pass over fresh ones walks the key and
  the whole owner chain. That is why convergence improves tenfold while commit
  improves barely at all.
- **Changed data is about three times more expensive at the commit boundary.**
  A miss pays for the `deps` call and a memo probe *on top of* the work it
  could not avoid, and the probe is the expensive half: it is keyed by the
  owner's semantic identity, which on a miss is a freshly built object whose
  hash has to be computed from scratch.

Two consequences worth stating plainly, because they are not what "add a
memo" usually implies:

1. **Declare `deps` where the dependency genuinely changes rarely relative to
   commits.** On data that changes on most commits it is a pessimization, and
   the full sweep — which is what you get by writing nothing — is faster.
2. **Incrementality wants the whole owner chain.** With `deps` on only the
   per-document selector and not on `Document` itself, the equivalent-commit
   case was *worse* than the full sweep (19.8 ms commit against 8.8 ms):
   every memo probe was keyed by a document identity that had just been
   rebuilt, so every probe paid a full structural hash. Adding `deps` one
   level up turned a 2.2× regression into a 3× improvement. A memo whose key
   is expensive to compute is not a memo.

The pruning of memo entries for owners that have gone away is conditional for
the same reason: as an unconditional per-commit sweep it allocated an array of
ten thousand entries and probed each one, and cost more than the selectors the
memo existed to skip. It now runs only when the memo holds more owners than
the commit visited, which is the only way a stale entry can exist.

Everything here is one run of the seven-sample method rather than the
three-run median used for the main table, and the p95 column at this size is
noisy in both directions. The selector-evaluation and churn columns are exact,
and churn is identical between the two — which is the assertion the benchmark
actually makes, and the reason the timings are worth reading at all.
