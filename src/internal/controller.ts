import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { pipe } from "effect/Function"
import * as Latch from "effect/Latch"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type { LabeledEntry } from "../Binding.js"
import { asInternal, isHandle } from "../Definition.js"
import { ControllerClosed, ForeignLifetimeRef, type CommitError } from "../Errors.js"
import type { LifetimeFailure } from "../Failure.js"
import type { LifetimeRef } from "../LifetimeRef.js"
import type { LifetimeStatus } from "../Status.js"
import type { Compiled, CompiledFamily, CompiledRequirement } from "./compiledDefinition.js"
import { makeFinalization } from "./finalization.js"
import {
  emptySnapshot,
  evaluate,
  type DesiredNode,
  type DesiredSnapshot
} from "./desiredSnapshot.js"
import { Ident, slotIdent } from "./identity.js"
import {
  concludeStartup,
  currentInstance,
  isObsolete,
  makeLiveState,
  retire,
  retiringInstance,
  settled,
  slotOf,
  track,
  type LiveInstance,
  type LiveState
} from "./liveState.js"

// -----------------------------------------------------------------------------
// Semantic references
// -----------------------------------------------------------------------------

/** The purely semantic reference of a live instance. */
const semanticRef = (compiled: Compiled, inst: LiveInstance): LifetimeRef => ({
  family: compiled.families[inst.familyId]!.handle,
  key: inst.key,
  parent: inst.owner === null ? null : semanticRef(compiled, inst.owner)
}) as LifetimeRef

/**
 * The internal path a semantic reference names. A reference whose family
 * belongs to another Definition cannot name anything here and is a
 * programming error, so it is reported as a defect rather than silently
 * matching nothing.
 */
const identOf = (compiled: Compiled, ref: LifetimeRef): Ident => {
  if (!isHandle(ref.family) || asInternal(ref.family).identity !== compiled.identity) {
    throw new ForeignLifetimeRef({ family: ref.family })
  }
  const family = compiled.families[asInternal(ref.family).familyId]!
  const parent = ref.parent === null ? null : identOf(compiled, ref.parent as LifetimeRef)
  return new Ident(family.id, ref.key, parent)
}

// -----------------------------------------------------------------------------
// Reconciliation, as pure decisions over the two snapshots
// -----------------------------------------------------------------------------

const resolveProvider = (
  live: LiveState,
  desired: DesiredSnapshot,
  node: DesiredNode,
  requirement: CompiledRequirement
): LiveInstance | undefined => {
  if (requirement.kind === "ancestor") {
    const ancestor = node.ancestors[requirement.depth - 1]
    return ancestor === undefined ? undefined : currentInstance(live, ancestor.ident)
  }
  const ownerNode = requirement.depth === 0 ? null : node.ancestors[requirement.depth - 1]
  const candidates = ownerNode == null
    ? desired.rootsByFamily.get(requirement.familyId)
    : ownerNode.childrenByFamily.get(requirement.familyId)
  const providerNode = candidates?.[0]
  return providerNode === undefined ? undefined : currentInstance(live, providerNode.ident)
}

/**
 * Phase A — obsolescence. A physical lifetime remains valid only while its
 * semantic desire is current, its physical owner is current and all bound
 * provider instances are current. Retires everything that is no longer valid
 * and returns those generations in the order they were retired.
 *
 * `seeds` are generations retired outside a reconcile pass (`Controller.retry`)
 * whose subtree has therefore not been cascaded yet.
 */
const invalidate = (
  live: LiveState,
  desired: DesiredSnapshot,
  revision: number,
  seeds: ReadonlyArray<LiveInstance>
): Array<LiveInstance> => {
  const newlyObsolete: Array<LiveInstance> = []
  const pending: Array<LiveInstance> = []
  const cascade = (inst: LiveInstance): void => {
    if (isObsolete(inst)) return
    retire(live, inst)
    newlyObsolete.push(inst)
    pending.push(inst)
  }

  // One sweep, matching live generations to the published desire and starting
  // the walk wherever desire has been withdrawn. Matching is done once per
  // snapshot — many passes run against the same desire, and the admission
  // phase can then skip satisfied nodes without hashing anything.
  for (const inst of live.all) {
    if (isObsolete(inst)) continue
    if (inst.desiredRevision !== revision) {
      inst.desiredRevision = revision
      const node = Option.getOrUndefined(MutableHashMap.get(desired.byIdent, inst.ident))
      inst.desiredNode = node
      if (node !== undefined) node.live = inst
    }
    if (inst.desiredNode === undefined) cascade(inst)
  }
  // Invalidity travels down the two edges that carry it — owner to child and
  // provider to dependent — so it is walked from where it starts rather than
  // searched for. It starts in exactly two places: the sweep above, and a
  // retirement performed outside a pass.
  for (const seed of seeds) pending.push(seed)
  while (pending.length > 0) {
    const inst = pending.pop()!
    for (const child of inst.children) cascade(child)
    for (const dependent of inst.dependents) cascade(dependent)
  }
  return newlyObsolete
}

/** The owner and provider generations a desired node would capture. */
interface Admission {
  readonly ownerLive: LiveInstance | null
  readonly providers: ReadonlyMap<string, LiveInstance>
}

/**
 * Phase B — whether a desired node may take its slot now. A new physical
 * lifetime is admitted only while its desire is current, its owner is current
 * and Running, all required providers are current and Running, and the
 * replacement policy permits it. Running implies current: a generation that
 * loses authority leaves the `running` state in the same transition.
 */
const admissible = (
  live: LiveState,
  desired: DesiredSnapshot,
  family: CompiledFamily,
  node: DesiredNode
): Admission | undefined => {
  let ownerLive: LiveInstance | null = null
  if (node.parent !== null) {
    const known = node.parent.live
    const owner = known !== undefined && !isObsolete(known)
      ? known
      : currentInstance(live, node.parent.ident)
    if (owner === undefined || owner.status !== "running") return undefined
    ownerLive = owner
  }

  const slot = slotOf(live, node.slot)
  if (slot !== undefined) {
    if (slot.current !== undefined) return undefined
    if (family.replacement === "sequential" && slot.retiring.size > 0) return undefined
  }

  const providers = new Map<string, LiveInstance>()
  for (const requirement of family.requires) {
    const provider = resolveProvider(live, desired, node, requirement)
    if (provider === undefined || provider.status !== "running") return undefined
    providers.set(requirement.name, provider)
  }
  return { ownerLive, providers }
}

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

export const TestHooksId: unique symbol = Symbol.for("effect-reconciler/TestHooks")

/**
 * Test-only observation of controller bookkeeping. These hooks read the same
 * state machine the reconciler already maintains and take the same mutex it
 * already takes; they add no production behaviour and are not part of the
 * public `Controller`.
 */
export interface TestHooks {
  /** Hold the controller's serialization mutex for the duration of `effect`. */
  readonly holding: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /**
   * Completes once the controller has converged on the published desire:
   * every wake has been reconciled and no instance is still starting or
   * finalizing. Never completes while a lifetime is deliberately wedged (a
   * blocked startup or finalizer), so gate-driven tests await their gates.
   */
  readonly idle: Effect.Effect<void>
}

export interface ControllerInternal<State> {
  readonly commit: (state: State) => Effect.Effect<void, CommitError>
  readonly changes: Stream.Stream<void>
  readonly failures: Stream.Stream<LifetimeFailure>
  readonly status: (ref: LifetimeRef) => Effect.Effect<Option.Option<LifetimeStatus>>
  readonly retry: (ref: LifetimeRef) => Effect.Effect<void, ControllerClosed>
  readonly shutdown: Effect.Effect<void>
  readonly [TestHooksId]: TestHooks
}

/**
 * Serialized controller state machine. All bookkeeping mutations (commit
 * publication, reconcile passes, startup/stop completions) run under one
 * mutex; lifecycle Effects (startup, finalization) run in interruptible
 * fibers owned by per-instance Scopes.
 */
export const makeController = <State>(
  compiled: Compiled,
  entries: ReadonlyMap<number, LabeledEntry<State>>,
  rootContext: Context.Context<never>
): Effect.Effect<ControllerInternal<State>, never, Scope.Scope> =>
  // Uninterruptible so construction cannot be abandoned between creating the
  // root Scope / forking the reconcile loop and registering the shutdown
  // finalizer — an interruption there would orphan the scope and leak the
  // loop fiber.
  Effect.uninterruptible(
    Effect.gen(function* () {
      const rootScope = yield* Scope.make()
      const mutex = yield* Semaphore.make(1)
      /** The one serialization region every bookkeeping mutation runs in. */
      const serialized = mutex.withPermits(1)
      /** Open means a reconcile pass is owed. Coalescing by construction:
       * any number of wakes before the loop looks is still one pass. */
      const wake = yield* Latch.make(false)
      /** Open means the controller has settled on the published desire. Read
       * only by the test hooks; see `idle` below. */
      const converged = yield* Latch.make(false)
      // Sliding: publishing a failure never blocks the controller, and with no
      // subscriber attached nothing is retained.
      const failureLog = yield* PubSub.sliding<LifetimeFailure>(64)
      // A change signal is a prompt to re-read, never a datum, so a subscriber
      // holding one undrained has nothing to gain from a second: capacity 1
      // coalesces every burst into "there is something new to read".
      //
      // `replay: 1` is what makes the stream safe to build a cache on. An
      // observer must establish its subscription and take its first reading
      // in some order, and a transition landing between the two would be
      // invisible either way round; replaying the last prompt to a late
      // subscriber means the observer is always told to read again after any
      // transition it could have missed. Replaying a *prompt* costs nothing
      // and reveals nothing — there is no history here to leak.
      const changeLog = yield* PubSub.sliding<void>({ capacity: 1, replay: 1 })

      const live = makeLiveState()
      let open = true
      let desired: DesiredSnapshot = emptySnapshot
      let desiredRevision = 0
      // Bookkeeping for the convergence barrier: `wakeVersion` counts requested
      // reconcile work, `reconciledVersion` the newest request a completed pass
      // has covered. Equal versions mean no pass is owed.
      let wakeVersion = 0
      let reconciledVersion = 0
      // Generations `Controller.retry` retired between passes: the next pass
      // owes their subtrees a cascade that no snapshot comparison would find.
      const retiredOutOfBand: Array<LiveInstance> = []
      // The value of `live.version` the last change signal spoke for. A pass
      // that leaves them equal moved nothing an observer could see.
      let publishedVersion = 0

      // Requesting a pass and losing convergence are the same event, so they
      // are the same synchronous step: no fiber can observe one without the
      // other.
      const wakeUp = Effect.sync(() => {
        wakeVersion++
        Latch.closeUnsafe(converged)
        Latch.openUnsafe(wake)
      })

      const { beginStop, closeInstance } = makeFinalization({ live, mutex, rootScope, wakeUp })

      // ---------------------------------------------------------------------
      // Startup
      // ---------------------------------------------------------------------

      const onStartupDone = (
        inst: LiveInstance,
        exit: Exit.Exit<unknown, unknown>
      ): Effect.Effect<void> =>
        serialized(
          Effect.suspend((): Effect.Effect<void> => {
            // Late completion of an obsolete or superseded startup never
            // publishes capabilities or regains authority: both leave the
            // `starting` state.
            if (!open || inst.status !== "starting") return Effect.void
            if (Exit.isSuccess(exit)) {
              concludeStartup(live, inst, "running")
              inst.providedContext = Context.isContext(exit.value)
                ? (exit.value as Context.Context<never>)
                : Context.empty()
              // Fold the environment this instance's children inherit exactly
              // once, here, instead of re-walking the ancestor chain at every
              // admission below it.
              inst.childContext = Context.merge(
                inst.owner === null ? rootContext : inst.owner.childContext,
                inst.providedContext
              )
              return wakeUp
            }
            // Startup failure is a normal runtime condition: partial resources
            // finalize, the failed generation blocks its slot until desire
            // changes (no automatic retry in v0). External interruption always
            // marks the instance obsolete (or closes the controller) first, so
            // an interrupted exit reaching this point means the start Effect
            // interrupted itself — treated as failure, not left wedged.
            concludeStartup(live, inst, "failed")
            inst.failure = exit.cause
            // Only a failure whose semantic desire is still current is an
            // application-visible failure. Desire can have been withdrawn
            // between admission and this completion, before the reconcile pass
            // that will obsolete this generation has even run.
            const stillDesired = MutableHashMap.has(desired.byIdent, inst.ident)
            return pipe(
              stillDesired
                ? PubSub.publish(failureLog, {
                  lifetime: semanticRef(compiled, inst),
                  cause: exit.cause
                })
                : Effect.void,
              Effect.andThen(
                pipe(
                  closeInstance(inst, exit),
                  // Cleaning up a failed startup ends a transition like any
                  // other, and convergence is only ever observed at the end of
                  // a pass, so it wakes the loop.
                  Effect.ensuring(wakeUp),
                  Effect.forkIn(rootScope, { uninterruptible: true }),
                  Effect.asVoid
                )
              ),
              // The generation is Failed *now*. Waking only when its partial
              // resources finish finalizing would make `changes` — and so any
              // observer built on it — wait on a finalizer that has nothing to
              // do with the transition it is reporting, and never arrive at
              // all behind one that blocks.
              Effect.andThen(wakeUp)
            )
          })
        )

      const startInstance = (
        node: DesiredNode,
        family: CompiledFamily,
        { ownerLive, providers }: Admission
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const parentScope = ownerLive === null ? rootScope : ownerLive.scope
          const instScope = yield* Scope.fork(parentScope, "sequential")
          const inst: LiveInstance = {
            familyId: family.id,
            key: node.key,
            ident: node.ident,
            slot: node.slot,
            owner: ownerLive,
            providers,
            scope: instScope,
            children: new Set(),
            dependents: new Set(),
            status: "starting",
            desiredRevision,
            desiredNode: node,
            providedContext: Context.empty(),
            childContext: rootContext,
            failure: null,
            closing: null
          }
          node.live = inst
          track(live, inst)

          // Immutable startup environment: what the owner passes down (the
          // root environment plus every ancestor's published capabilities),
          // then the required providers' capabilities, then the instance Scope.
          let ctx = ownerLive === null ? rootContext : ownerLive.childContext
          for (const provider of providers.values()) {
            ctx = Context.merge(ctx, provider.providedContext)
          }
          const startContext = Context.add(ctx, Scope.Scope, instScope)

          // Forks are interruptible in Effect 4 however the forking fiber is
          // masked, which is what closing the instance Scope relies on to
          // cancel a startup admitted inside the uninterruptible pass.
          const startFiber = yield* pipe(
            Effect.suspend(() => family.start(inst.key)) as Effect.Effect<
              unknown,
              unknown,
              Scope.Scope
            >,
            Effect.provide(startContext),
            Effect.forkIn(instScope)
          )
          yield* pipe(
            Fiber.await(startFiber),
            Effect.flatMap((exit) => onStartupDone(inst, exit)),
            Effect.forkIn(rootScope)
          )
        })

      // ---------------------------------------------------------------------
      // Reconcile loop
      // ---------------------------------------------------------------------

      const reconcilePass: Effect.Effect<void> = Effect.gen(function* () {
        if (!open) return

        const newlyObsolete = invalidate(live, desired, desiredRevision, retiredOutOfBand)
        retiredOutOfBand.length = 0
        const newlySet = new Set(newlyObsolete)
        // Subtree roots get their own close (descendants close with them).
        // An instance with a dedicated close already in flight (a startup
        // failure's cleanup) also gets one: its ancestor's Scope-close will
        // not await that in-flight close, so it must retire itself when its
        // own finalization boundary is reached.
        for (const inst of newlyObsolete) {
          if (inst.owner === null || !newlySet.has(inst.owner) || inst.closing !== null) {
            yield* beginStop(inst)
          }
        }

        // Admission, owners before children.
        for (const node of desired.topo) {
          // Already satisfied by a current generation: nothing to admit, and
          // no need to hash anything to find that out.
          const satisfying = node.live
          if (satisfying !== undefined && !isObsolete(satisfying)) continue
          const family = compiled.families[node.familyId]!
          const admission = admissible(live, desired, family, node)
          if (admission !== undefined) yield* startInstance(node, family, admission)
        }
      })

      /**
       * Has the controller settled on the published desire? A closed one has,
       * vacuously: its loop is gone, so no pass will ever run to observe
       * anything else, and a waiter that kept asking would spin against a
       * latch nothing can close.
       */
      const quiescent = (): boolean =>
        !open || (reconciledVersion === wakeVersion && settled(live))
      // Nothing observes convergence unless the `idle` test hook has been
      // used, so a production controller never pays for the walk.
      let convergenceObserved = false

      /**
       * Tell subscribers that re-reading could now say something different.
       * The signal carries no payload by construction: it names no lifetime,
       * no generation and no transition, so it exposes nothing `status` would
       * not already answer for (§9.4), and a subscriber that misses one still
       * reads the same authoritative state as one that does not.
       */
      const publishChanges = (): void => {
        if (live.version === publishedVersion) return
        publishedVersion = live.version
        PubSub.publishUnsafe(changeLog, void 0)
      }

      const onePass = Effect.suspend(() => {
        const covered = wakeVersion
        return Effect.andThen(
          reconcilePass,
          Effect.sync(() => {
            reconciledVersion = covered
            // Under the mutex, after the pass and after every transition it
            // caused, so a subscriber woken by this signal reads state at
            // least as new as the one that caused it.
            publishChanges()
            if (convergenceObserved && quiescent()) Latch.openUnsafe(converged)
          })
        )
      })

      // Converge toward the latest authoritative desired snapshot whenever
      // woken by a commit or a lifecycle event. The latch is closed before the
      // pass runs, never after, so a wake arriving mid-pass is still owed a
      // pass. The loop fiber is interruptible — shutdown must be able to stop
      // it — while each individual pass runs to completion under its own mask.
      yield* pipe(
        wake.await,
        Effect.andThen(wake.close),
        Effect.andThen(serialized(Effect.uninterruptible(onePass))),
        Effect.forever,
        Effect.forkIn(rootScope)
      )

      // ---------------------------------------------------------------------
      // Public surface
      // ---------------------------------------------------------------------

      /**
       * The commit linearization point is entry into the publication region.
       * Selector evaluation, validation and waiting for the mutex are all
       * interruptible and publish nothing; once publication begins it runs to
       * completion exactly once. The caller never faces a "maybe committed"
       * outcome.
       */
      const commit = (state: State): Effect.Effect<void, CommitError> =>
        Effect.suspend(() => {
          // Pure, against this one immutable state value, outside the critical
          // section and outside any mask.
          const snapshot = evaluate(compiled, entries, state)
          return serialized(
            // [atomic publication region]
            Effect.uninterruptible(
              Effect.suspend((): Effect.Effect<void, CommitError> => {
                if (!open) return Effect.fail(new ControllerClosed())
                if (Result.isFailure(snapshot)) return Effect.fail(snapshot.failure)
                desired = snapshot.success
                desiredRevision++
                return wakeUp
              })
            )
          )
        })

      /**
       * The authoritative state of one semantic lifetime. Read under the same
       * mutex the reconciler mutates under, so it never observes a half-applied
       * pass.
       */
      const status = (ref: LifetimeRef): Effect.Effect<Option.Option<LifetimeStatus>> =>
        serialized(
          Effect.sync((): Option.Option<LifetimeStatus> => {
            const ident = identOf(compiled, ref)
            const inst = currentInstance(live, ident)
            if (inst !== undefined) {
              switch (inst.status) {
                case "starting":
                  return Option.some({ _tag: "Starting" })
                case "running":
                  return Option.some({ _tag: "Running" })
                case "failed":
                  return Option.some({ _tag: "Failed", cause: inst.failure ?? Cause.empty })
                case "stopping":
                  return Option.some({ _tag: "Stopping" })
              }
            }
            // A generation that is no longer current but still finalizing is
            // still something that exists. It has left `currentByIdent`, but
            // it cannot have left the slot it is draining out of.
            const cardinality = compiled.families[ident.familyId]!.cardinality
            const slot = slotIdent(ident.familyId, cardinality, ident)
            return retiringInstance(live, slot, ident) === undefined
              ? Option.none()
              : Option.some({ _tag: "Stopping" })
          })
        )

      /**
       * Retire a Failed generation so a fresh one may be admitted under the same
       * semantic key. Retry never changes semantic identity: it is the physical
       * generation that is replaced, which is why an application never has to
       * pollute its domain state with a retry nonce.
       *
       * It is a no-op unless the referenced lifetime is both still desired and
       * currently Failed, and it is idempotent: a second call finds the failed
       * generation already retiring.
       */
      const retry = (ref: LifetimeRef): Effect.Effect<void, ControllerClosed> =>
        // Waiting for the mutex is interruptible and retires nothing; only the
        // retirement itself is atomic. The linearization point is the same as
        // `commit`'s: entry into the masked region.
        serialized(
          Effect.uninterruptible(
            Effect.suspend((): Effect.Effect<void, ControllerClosed> => {
              if (!open) return Effect.fail(new ControllerClosed())
              const ident = identOf(compiled, ref)
              const inst = currentInstance(live, ident)
              if (inst === undefined || inst.status !== "failed") return Effect.void
              if (!MutableHashMap.has(desired.byIdent, ident)) return Effect.void

              // Exactly the transition obsolescence uses, so the replacement
              // policy still governs when the fresh generation may start, and
              // the next pass cascades to whatever depended on this one.
              retire(live, inst)
              retiredOutOfBand.push(inst)
              return Effect.andThen(beginStop(inst), wakeUp)
            })
          )
        )

      const shutdownGate = yield* Deferred.make<void>()
      let shutdownStarted = false
      const shutdown: Effect.Effect<void> = Effect.uninterruptible(
        Effect.suspend(() => {
          if (shutdownStarted) return Deferred.await(shutdownGate)
          shutdownStarted = true
          return pipe(
            serialized(
              Effect.sync(() => {
                open = false
                desired = emptySnapshot
                desiredRevision++
              })
            ),
            Effect.andThen(Scope.close(rootScope, Exit.void)),
            // Nothing is left to converge on, and no further pass will run —
            // so this is also the last chance to signal whatever the close
            // itself moved. A subscriber that re-reads after it sees the final
            // state of a closed controller.
            Effect.andThen(
              Effect.sync(() => {
                publishChanges()
                Latch.openUnsafe(converged)
              })
            ),
            Effect.andThen(Deferred.succeed(shutdownGate, void 0)),
            Effect.asVoid
          )
        })
      )

      yield* Effect.addFinalizer(() => shutdown)

      /**
       * The convergence barrier. `converged` holds a *state*, not an edge:
       * open means settled. A waiter arriving after the settling pass passes
       * straight through, and one arriving before it suspends until a pass
       * opens the latch, so no wake-up can be lost between releasing the mutex
       * and suspending.
       */
      const idle: Effect.Effect<void> = Effect.suspend(() =>
        Effect.flatMap(
          serialized(
            Effect.sync(() => {
              convergenceObserved = true
              return quiescent()
            })
          ),
          (isSettled) => (isSettled ? Effect.void : Effect.andThen(converged.await, idle))
        )
      )

      return {
        commit,
        changes: Stream.fromPubSub(changeLog),
        failures: Stream.fromPubSub(failureLog),
        status,
        retry,
        shutdown,
        [TestHooksId]: { holding: serialized, idle }
      }
    })
  )
