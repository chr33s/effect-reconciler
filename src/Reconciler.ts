import * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import type { BindApi, Binding, BindingEntry, LabeledEntry } from "./Binding.js"
import {
  HandleTypeId,
  observed as observedWitness,
  type AnyHandle,
  type DefineApi,
  type DefinitionIdentity,
  type DefinitionSource,
  type InternalHandle,
  type KeyOf,
  type OwnerOf,
  type RootRequirementsOf
} from "./Definition.js"
import type { Diagnostics, ReconcileEvent } from "./Diagnostics.js"
import type { BindingError, CommitError, ControllerClosed, DefinitionError } from "./Errors.js"
import type { LifetimeFailure } from "./Failure.js"
import type { LifetimeRef } from "./LifetimeRef.js"
import type { Snapshot } from "./Snapshot.js"
import type { LifetimeStatus } from "./Status.js"
import { compileBinding, compileDefinition } from "./internal/compiledDefinition.js"
import { makeController } from "./internal/controller.js"

/**
 * A Definition with its lifetime handles: the handles returned by the builder
 * plus `bind`, which maps an arbitrary control-state type into desired
 * instances. The Definition is independent of any particular state type and
 * may be bound any number of times.
 */
export type Defined<H extends Record<string, AnyHandle>> = H & {
  readonly bind: <State>(
    f: (bind: BindApi<State>) => Record<string, BindingEntry<State>>
  ) => Binding<State, RootRequirementsOf<H[keyof H]>>
}

/**
 * Define a static family architecture of keyed Effect lifetimes: cardinality,
 * semantic key equality, ownership, capability requirements, startup and
 * replacement policy. Structural invariants are validated when a Controller
 * is created with `Reconciler.make`.
 */
export const define = <H extends Record<string, AnyHandle>>(
  f: (define: DefineApi) => H
): Defined<H> => {
  // Unforgeable Definition identity: a fresh object per call, compared by
  // reference, so handles from another Definition — including one from a
  // duplicate installed copy of this package — can never pass as ours.
  const identity = {} as DefinitionIdentity
  const families: Array<InternalHandle> = []

  const makeHandle =
    (cardinality: "one" | "many") =>
    (name: string, options: any): any => {
      const handle: InternalHandle = {
        [HandleTypeId]: cardinality,
        name,
        identity,
        familyId: families.length,
        owner: options.owner,
        requires: options.requires ?? {},
        replacement:
          options.replacement !== undefined && options.replacement._tag === "Overlap"
            ? "overlap"
            : "sequential",
        supervision: options.supervision ?? { _tag: "Manual" },
        observes: options.observes !== undefined,
        start: options.start
      }
      families.push(handle)
      return handle
    }

  const handles = f({
    one: makeHandle("one") as DefineApi["one"],
    many: makeHandle("many") as DefineApi["many"]
  })

  const source: DefinitionSource = { identity, families }

  const bind = <State>(
    bf: (bind: BindApi<State>) => Record<string, BindingEntry<State>>
  ): Binding<State, never> => {
    const bound =
      (cardinality: "one" | "many") =>
      (
        handle: AnyHandle,
        selector: unknown,
        options?: { readonly deps?: unknown; readonly observe?: unknown }
      ): BindingEntry<State> => ({
        handle,
        cardinality,
        selector: selector as (state: State, owner: unknown) => unknown,
        deps: options?.deps as BindingEntry<State>["deps"],
        observe: options?.observe as BindingEntry<State>["observe"]
      })
    const api = { one: bound("one"), many: bound("many") } as unknown as BindApi<State>
    // The record key is the name the application gave this selector, and the
    // only name a foreign handle can be reported under.
    const entries: ReadonlyArray<LabeledEntry<State>> = Object.entries(bf(api))
      .map(([label, entry]) => ({ ...entry, label }))
    return { source, entries }
  }

  return { ...handles, bind } as Defined<H>
}

/**
 * A semantic reference to one keyed lifetime: the family handle, its key, and
 * the reference of its owner (`null` for a root family). The ownership chain
 * is type-checked, so a reference cannot name a lifetime the Definition could
 * not produce.
 */
export const ref = <H extends AnyHandle>(
  family: H,
  key: KeyOf<H>,
  parent: OwnerOf<H>
): LifetimeRef<H> => ({ family, key, parent })

/**
 * The stable mutation boundary of a running Reconciler.
 *
 * `commit(state)` evaluates the Binding against `state` and atomically
 * replaces the authoritative desired snapshot; the runtime converges
 * asynchronously. It never awaits resource startup, shutdown or convergence.
 *
 * `failures` is a live Stream of the startup failures of lifetimes whose
 * desire is still current, so a control plane can surface them in its own
 * model. Running it subscribes; only failures published while it runs are
 * delivered, and the buffer drops the oldest under overflow.
 *
 * `changes` emits — with no payload — whenever reconciliation moved something
 * `status` could report, so an observer can re-read on notice instead of
 * polling. It names nothing, so it exposes nothing `status` does not; and
 * because it only ever prompts a re-read, coalescing several transitions into
 * one signal loses no information.
 *
 * `status` answers authoritatively what the runtime currently knows about one
 * semantic lifetime; unlike a failure notification it cannot be missed.
 * `None` means no physical generation exists for that identity.
 *
 * `retry(ref)` retires a Failed generation so a fresh one may be admitted
 * under the same semantic key, without the application inventing a retry
 * nonce or withdrawing and restoring desire.
 *
 * `snapshot` is `status` for every lifetime at one instant, coherently: a
 * tree assembled from separate `status` calls can show a child Running under
 * an owner that has already stopped, and one assembled from a snapshot
 * cannot.
 *
 * `events` and `diagnostics` are for understanding the runtime, never for
 * driving it. Events are lossy and produced only while something is
 * subscribed; counters are always maintained. Neither is authoritative —
 * `status` is.
 *
 * `shutdown` is idempotent: it stops accepting commits, invalidates all
 * desire, closes the root Scope and awaits structured finalization.
 */
export interface Controller<in State> {
  readonly commit: (state: State) => Effect.Effect<void, CommitError>
  readonly changes: Stream.Stream<void>
  readonly failures: Stream.Stream<LifetimeFailure>
  readonly events: Stream.Stream<ReconcileEvent>
  readonly status: (ref: LifetimeRef) => Effect.Effect<Option.Option<LifetimeStatus>>
  readonly snapshot: Effect.Effect<Snapshot>
  readonly diagnostics: Effect.Effect<Diagnostics>
  readonly retry: (ref: LifetimeRef) => Effect.Effect<void, ControllerClosed>
  readonly shutdown: Effect.Effect<void>
}

/**
 * Compile and validate a Definition + Binding and start a Controller. The
 * Controller's root Scope is owned by the surrounding Scope; the current
 * environment at `make` becomes the root environment of every lifetime, so
 * whatever the Definition's startup Effects require beyond their Scope, their
 * ancestors and their providers is required here (spec §6.2).
 */
export const make = <State, RootR = never>(
  binding: Binding<State, RootR>
): Effect.Effect<
  Controller<State>,
  DefinitionError | BindingError,
  Scope.Scope | RootR
> =>
  Effect.gen(function* () {
    const rootContext = yield* Effect.context<RootR>()
    const compiled = yield* Effect.fromResult(compileDefinition(binding.source))
    const entries = yield* Effect.fromResult(compileBinding(compiled, binding))
    return yield* makeController<State>(compiled, entries, rootContext)
  })

/**
 * Declare the shape of projected state a family observes:
 * `observes: Reconciler.observed<SubModel>()`.
 *
 * Re-exported here so a Definition needs one import.
 */
export const observed = observedWitness

/**
 * A lifetime that runs a Reconciler of its own.
 *
 * ```ts
 * const Workspace = define.one("Workspace", {
 *   owner: Session,
 *   observes: Reconciler.observed<WorkspaceModel>(),
 *   start: Reconciler.nested<string>()(workspaceBinding)
 * })
 * ```
 *
 * The empty first call is where the host family's own key type is annotated,
 * for the same reason `start` normally annotates it: the key type cannot be
 * inferred from anything here, and a family whose key silently widened could
 * be bound to desire anything at all. Write `nested()` — the key defaults to
 * `null` — for a host whose key carries no information, exactly as
 * `start: (_: null) => …` does.
 *
 * Everything this needs already exists, which is the point: the child
 * Controller is created in the lifetime's own Scope, so it is shut down and
 * finalized by the same ownership closure that governs every other resource a
 * lifetime holds (§11), and the projected state the lifetime observes is what
 * it commits. There is no second lifecycle to reason about — a nested
 * Reconciler stops when its host lifetime stops, for the same structural
 * reason a child lifetime does.
 *
 * What it buys is **modularity of the Definition**, which is the thing a flat
 * Definition cannot give: a feature ships its own families, its own Binding
 * and its own state shape, and an application mounts the whole thing under an
 * owner without its families joining the parent's identity space or its
 * selectors running on the parent's every commit. A parent commit that does
 * not change the projection reaches the child not at all (§8.4 applies to the
 * projection, by `Equal`), and one that does costs the child one commit —
 * over its own families only.
 *
 * The trade is equally real, and it is the reason this is a helper rather
 * than the default. Two Controllers are two reconcile loops: the child's
 * families cannot own, require, or be required by the parent's, `status` and
 * `snapshot` on the parent say nothing about the child's lifetimes, and
 * convergence across the boundary is two asynchronous steps rather than one.
 * Nest when a subtree is genuinely a separate concern with its own state
 * shape. Do not nest to organize a Definition that would work flat.
 *
 * Whatever the child's startup Effects need from the root environment becomes
 * a requirement of the host family, and so of the parent `Reconciler.make` —
 * the same rule that governs an ordinary lifetime (§6.2), applied through one
 * more level.
 */
export const nested = <K = null>() =>
<SubState, RootR = never>(binding: Binding<SubState, RootR>) =>
(
  _key: K,
  state: SubscriptionRef.SubscriptionRef<SubState>
): Effect.Effect<void, DefinitionError | BindingError | CommitError, Scope.Scope | RootR> =>
  Effect.gen(function* () {
    const controller = yield* make(binding)
    // The first commit is made here, not in the forked fiber, so a Definition
    // or Binding that cannot accept the initial projection fails *startup* —
    // visibly, as a Failed lifetime with a cause — rather than dying inside a
    // background fiber of a lifetime that reports itself Running.
    yield* controller.commit(yield* SubscriptionRef.get(state))
    yield* Effect.forkScoped(
      Stream.runForEach(SubscriptionRef.changes(state), (next) =>
        // `changes` replays the current value, so this re-commits what was
        // just committed. That costs nothing: an equivalent commit is exactly
        // zero churn (§8.4), which is the same property that lets a UI commit
        // on every keystroke.
        Effect.orDie(controller.commit(next)))
    )
  })
