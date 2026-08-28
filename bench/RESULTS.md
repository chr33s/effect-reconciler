# Scale benchmark — baseline

Run with `npm run bench`. These are the numbers **before** any incremental
optimization exists: no reverse dependency index, no dirty-slot or dirty-family
queues, no incremental binding invalidation. The point of recording them is to
know which of those, if any, a real workload actually needs.

Recorded 2026-08-28 · Node v24.18.1 · darwin arm64 · Apple M5 Max.

| documents | scenario | commit ms | converge ms | selector evals | starts | stops |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: |
| 100 | build | 0.40 | 4.12 | 105 | 204 | 0 |
| 100 | A equivalent commit | 0.14 | 1.50 | 105 | 0 | 0 |
| 100 | B one document changed | 0.14 | 1.43 | 105 | 2 | 2 |
| 100 | C settings replaced | 0.10 | 3.40 | 105 | 101 | 101 |
| 100 | D language replaced | 0.16 | 1.87 | 105 | 101 | 101 |
| 100 | E workspace replaced | 0.09 | 3.75 | 105 | 202 | 202 |
| 1000 | build | 0.64 | 19.44 | 1005 | 2004 | 0 |
| 1000 | A equivalent commit | 0.61 | 0.91 | 1005 | 0 | 0 |
| 1000 | B one document changed | 0.59 | 2.24 | 1005 | 2 | 2 |
| 1000 | C settings replaced | 0.62 | 14.25 | 1005 | 1001 | 1001 |
| 1000 | D language replaced | 0.60 | 18.87 | 1005 | 1001 | 1001 |
| 1000 | E workspace replaced | 0.60 | 20.24 | 1005 | 2002 | 2002 |
| 10000 | build | 7.82 | 174.16 | 10005 | 20004 | 0 |
| 10000 | A equivalent commit | 6.80 | 12.55 | 10005 | 0 | 0 |
| 10000 | B one document changed | 10.27 | 21.68 | 10005 | 2 | 2 |
| 10000 | C settings replaced | 10.92 | 163.36 | 10005 | 10001 | 10001 |
| 10000 | D language replaced | 6.34 | 164.57 | 10005 | 10001 | 10001 |
| 10000 | E workspace replaced | 10.42 | 201.47 | 10005 | 20002 | 20002 |

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
2. **Commit latency tracks that evaluation**: ~0.1 ms at 100 documents, ~0.6 ms
   at 1,000, ~7–11 ms at 10,000. Selector evaluation happens outside the
   critical section and outside the atomic publication region, so this is
   latency at the caller's mutation boundary, not time holding the controller.

At 10,000 documents a no-op commit costs about 7 ms of pure selector work plus
about 13 ms to walk the reconcile pass and confirm there is nothing to do. For
an editor-sized workload (hundreds to low thousands of documents) that is under
a millisecond and needs nothing further.

## When to optimize

Incremental machinery — reverse dependency indexes, dirty-slot or dirty-family
queues, incremental binding invalidation — is worth adding when a real workload
shows one of:

- commits at a rate where `N + 5` selector evaluations per commit dominate the
  frame budget (roughly: >10,000 instances committed on every keystroke), or
- a reconcile pass whose full sweep of live instances becomes visible next to
  the lifecycle work it schedules.

Neither is visible at these sizes. The measurement, not the shape of the code,
should decide.
