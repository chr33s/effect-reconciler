import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { pipe } from "effect/Function"
import * as Latch from "effect/Latch"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Pull from "effect/Pull"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import * as Schedule from "effect/Schedule"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import type { LabeledEntry } from "../Binding.js"
import { asInternal, isHandle } from "../Definition.js"
import { ControllerClosed, ForeignLifetimeRef, type CommitError } from "../Errors.js"
import type { Diagnostics, ReconcileEvent, RetirementReason } from "../Diagnostics.js"
import type { LifetimeFailure } from "../Failure.js"
import type { LifetimeRef } from "../LifetimeRef.js"
import type { LifetimeEntry, Snapshot } from "../Snapshot.js"
import type { LifetimeStatus } from "../Status.js"
import type { Compiled, CompiledFamily, CompiledRequirement } from "./compiledDefinition.js"
import { makeFinalization } from "./finalization.js"
import {
  emptySnapshot,
  evaluate,
  makeIncrementalMemory,
  type DesiredNode,
  type DesiredSnapshot
} from "./desiredSnapshot.js"
import { Ident, slotIdent } from "./identity.js"
import {
  concludeStartup,
  currentInstance,
  forget,
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
 * `seeds` are generations retired outside a reconcile pass (`Controller.retry`
 * and the supervision timer) whose subtree has therefore not been cascaded
 * yet. They enter the walk directly rather than through `cascade`, so
 * `onRetired` is never called for one — they are already retired, and they
 * reported that where it was decided.
 */
const invalidate = (
  live: LiveState,
  desired: DesiredSnapshot,
  revision: number,
  seeds: ReadonlyArray<LiveInstance>,
  onRetired: ((inst: LiveInstance, reason: RetirementReason) => void) | undefined
): Array<LiveInstance> => {
  const newlyObsolete: Array<LiveInstance> = []
  const pending: Array<LiveInstance> = []
  const cascade = (inst: LiveInstance, reason: RetirementReason): void => {
    if (isObsolete(inst)) return
    retire(live, inst)
    onRetired?.(inst, reason)
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
    if (inst.desiredNode === undefined) cascade(inst, "desire")
  }
  // Invalidity travels down the two edges that carry it — owner to child and
  // provider to dependent — so it is walked from where it starts rather than
  // searched for. It starts in exactly two places: the sweep above, and a
  // retirement performed outside a pass.
  for (const seed of seeds) pending.push(seed)
  while (pending.length > 0) {
    const inst = pending.pop()!
    // The two edges invalidity travels are also the two reasons it can have,
    // which is why the walk can name them without looking anything up.
    for (const child of inst.children) cascade(child, "owner")
    for (const dependent of inst.dependents) cascade(dependent, "provider")
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

/**
 * The source of physical generation identities.
 *
 * Process-wide rather than per-Controller, so two Controllers can never mint
 * the same token and a consumer holding entries from both — a panel showing a
 * parent and its nested child, say — cannot confuse one generation for
 * another. It is never persisted, compared across processes, or exposed as a
 * number.
 */
let nextGeneration = 0

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
  /** Number of active diagnostic event-stream subscriptions. */
  readonly eventSubscribers: Effect.Effect<number>
}

export interface ControllerInternal<State> {
  readonly commit: (state: State) => Effect.Effect<void, CommitError>
  readonly changes: Stream.Stream<void>
  readonly failures: Stream.Stream<LifetimeFailure>
  readonly events: Stream.Stream<ReconcileEvent>
  readonly status: (ref: LifetimeRef) => Effect.Effect<Option.Option<LifetimeStatus>>
  readonly snapshot: Effect.Effect<Snapshot>
  readonly diagnostics: Effect.Effect<Diagnostics>
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
      // Diagnostics are a firehose by nature, so the buffer is larger and the
      // loss is still the oldest first. Nothing downstream may depend on
      // completeness, which is what makes dropping acceptable at all.
      const eventLog = yield* PubSub.sliding<ReconcileEvent>(512)

      const live = makeLiveState()
      // What incremental bindings remember between commits. Held here because
      // its whole value is that it outlives one evaluation; a Binding with no
      // `deps` anywhere never writes to it.
      const memory = makeIncrementalMemory()
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

      // Building a `LifetimeRef` walks the owner chain and allocates one
      // object per level, so a Controller nobody is watching must not do it.
      // Count active stream subscriptions rather than property accesses: a
      // consumer that only obtains the stream, or whose subscription has
      // ended, must not leave event construction enabled forever.
      let eventSubscribers = 0
      const events = Stream.unwrap(
        Effect.acquireRelease(
          Effect.sync(() => {
            eventSubscribers++
            return Stream.fromPubSub(eventLog)
          }),
          () =>
            Effect.sync(() => {
              eventSubscribers--
            })
        )
      )
      const counters = {
        commits: 0,
        passes: 0,
        admitted: 0,
        started: 0,
        startupFailures: 0,
        retired: 0,
        stopped: 0,
        retries: 0
      }
      /** Publish a diagnostic event, building it only if anyone is listening. */
      const emit = (event: () => ReconcileEvent): void => {
        if (eventSubscribers === 0) return
        PubSub.publishUnsafe(eventLog, event())
      }

      // Requesting a pass and losing convergence are the same event, so they
      // are the same synchronous step: no fiber can observe one without the
      // other.
      const wakeUp = Effect.sync(() => {
        wakeVersion++
        Latch.closeUnsafe(converged)
        Latch.openUnsafe(wake)
      })

      const { beginStop, closeInstance } = makeFinalization({
        live,
        mutex,
        rootScope,
        wakeUp,
        onStopped: (inst) => {
          counters.stopped++
          emit(() => ({ _tag: "Stopped", lifetime: semanticRef(compiled, inst) }))
        }
      })

      // ---------------------------------------------------------------------
      // Startup
      // ---------------------------------------------------------------------

      // `onStartupDone` runs before the supervision section is defined but
      // only ever *executes* after the whole closure exists, so the hook is
      // filled in below rather than hoisted — the alternative is moving a
      // large block for the sake of one call.
      let onFailedStartup: (inst: LiveInstance, family: CompiledFamily) => Effect.Effect<void> =
        () => Effect.void
      let onStarted: (ident: Ident) => void = () => {}

      const onStartupDone = (
        inst: LiveInstance,
        exit: Exit.Exit<unknown, unknown>
      ): Effect.Effect<void> =>
        serialized(
          // Masked for the same reason `commit` and `retry` are: everything
          // below is one bookkeeping transition, and the failure branch in
          // particular claims a generation's `closing` deferred while building
          // its close. An interruption between that claim and the fork would
          // leave a generation permanently unsettled.
          Effect.uninterruptible(
            Effect.suspend((): Effect.Effect<void> => {
              // Late completion of an obsolete or superseded startup never
              // publishes capabilities or regains authority: both leave the
              // `starting` state.
              if (!open || inst.status !== "starting") return Effect.void
              if (Exit.isSuccess(exit)) {
                concludeStartup(live, inst, "running")
                counters.started++
                emit(() => ({ _tag: "Started", lifetime: semanticRef(compiled, inst) }))
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
                // Running answers the question a backoff was asking, so whatever
                // it had counted up to is no longer about anything.
                onStarted(inst.ident)
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
              counters.startupFailures++
              emit(() => ({
                _tag: "StartupFailed",
                lifetime: semanticRef(compiled, inst),
                cause: exit.cause
              }))
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
                Effect.andThen(wakeUp),
                // A policy only ever supervises a failure the application can
                // still see: desire withdrawn mid-startup means the generation
                // is on its way out, and restarting it would resurrect exactly
                // what §6.5 says a late completion must not.
                Effect.andThen(
                  stillDesired
                    ? onFailedStartup(inst, compiled.families[inst.familyId]!)
                    : Effect.void
                )
              )
            })
          )
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
            generation: nextGeneration++,
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
            observed: null,
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

          // A family that observes projected state gets its own ref, seeded
          // with the projection that came from the same state value that
          // decided this generation should exist.
          if (family.observes) {
            const ref = yield* SubscriptionRef.make(node.observed)
            inst.observed = { ref, value: node.observed }
          }

          // Forks are interruptible in Effect 4 however the forking fiber is
          // masked, which is what closing the instance Scope relies on to
          // cancel a startup admitted inside the uninterruptible pass.
          const startFiber = yield* pipe(
            Effect.suspend(() =>
              family.start(inst.key, inst.observed?.ref as SubscriptionRef.SubscriptionRef<unknown>)
            ) as Effect.Effect<
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
          counters.admitted++
          emit(() => ({ _tag: "Admitted", lifetime: node.ref }))
        })

      // ---------------------------------------------------------------------
      // Observation
      // ---------------------------------------------------------------------

      /**
       * Hand a current generation the latest projection of the state it
       * observes, if it changed.
       *
       * Compared with `Equal.equals` rather than by reference, for the same
       * reason an equivalent commit causes no churn (§8.4): a control plane
       * rebuilds its state object on every keystroke, and a projection that
       * is structurally what it already was is not news. Without that, a
       * nested Reconciler would receive — and re-evaluate — a commit per
       * parent commit, which is exactly the cost this whole design exists to
       * avoid.
       *
       * Only a *current* generation is updated. An obsolete one is on its way
       * out and must not be told about a world it is no longer part of; a
       * `starting` one is updated, because a startup that is subscribed to
       * its ref before this pass would otherwise miss the change and one that
       * has not read it yet will see the latest value when it does.
       */
      const republish = (inst: LiveInstance, node: DesiredNode): Effect.Effect<void> => {
        const observed = inst.observed
        if (observed === null) return Effect.void
        if (Equal.equals(observed.value, node.observed)) return Effect.void
        observed.value = node.observed
        return SubscriptionRef.set(observed.ref, node.observed)
      }

      // ---------------------------------------------------------------------
      // Reconcile loop
      // ---------------------------------------------------------------------

      // ---------------------------------------------------------------------
      // Supervision
      // ---------------------------------------------------------------------

      /**
       * The backoff in progress for one semantic identity: the schedule's own
       * driver, so "how long until the next attempt" is the schedule's
       * business and never this module's.
       *
       * Keyed by semantic identity rather than by generation on purpose: the
       * whole point of a backoff is that it counts *across* generations of
       * the same lifetime, which is exactly what physical identity does not
       * survive. One entry per identity is also all that can exist — an
       * identity has at most one current generation, so at most one failed
       * one, so at most one sleep in flight.
       */
      interface Supervisor {
        readonly step: (input: unknown) => Pull.Pull<unknown, never, unknown, never>
      }
      const supervisors = MutableHashMap.empty<Ident, Supervisor>()

      /**
       * Forget the backoff for an identity. Called whenever the question it
       * was answering has changed: the lifetime started, its desire went
       * away, or someone asked for a retry by hand.
       *
       * It does not interrupt the sleep in flight, and that is deliberate
       * rather than lazy. Interrupting awaits the fiber, and a fired timer
       * queued on the controller's mutex cannot finish while the caller
       * holding that mutex waits for it — a deadlock reachable from a
       * startup completing in the same pass that retired its predecessor.
       * Nothing needs the interruption: the timer re-checks the exact
       * instance, its status and its desire before doing anything, so an
       * abandoned sleep wakes into a world where all three say no and exits.
       * Dropping the entry is the whole reset, because a later failure builds
       * a fresh `Supervisor` with a fresh schedule.
       */
      const resetSupervisor = (ident: Ident): void => {
        MutableHashMap.remove(supervisors, ident)
      }

      /**
       * Retire a failed generation on its family's schedule.
       *
       * The fired timer re-checks everything rather than trusting what it
       * captured: a schedule that has been asleep for thirty seconds is the
       * last thing that should be allowed to retire whatever happens to be in
       * the slot when it wakes. Holding the *instance* — not just its
       * identity — is what makes that check exact.
       */
      const superviseFailure = (
        inst: LiveInstance,
        family: CompiledFamily
      ): Effect.Effect<void> => {
        if (family.supervision._tag !== "Restart") return Effect.void
        const policy = family.supervision
        return Effect.gen(function* () {
          const existing = Option.getOrUndefined(MutableHashMap.get(supervisors, inst.ident))
          let held: Supervisor
          if (existing === undefined) {
            const step = yield* Schedule.toStepWithSleep(policy.schedule)
            held = { step: step as Supervisor["step"] }
            MutableHashMap.set(supervisors, inst.ident, held)
          } else {
            held = existing
          }
          yield* pipe(
            // The sleep is the schedule's; `Done` is the schedule saying it
            // has no further attempt to offer, which is an ending, not a
            // failure. The generation simply stays Failed.
            Pull.matchEffect(held.step(void 0), {
              onSuccess: () =>
                serialized(
                  Effect.uninterruptible(
                    Effect.suspend(() => {
                      if (!open) return Effect.void
                      if (currentInstance(live, inst.ident) !== inst) return Effect.void
                      if (inst.status !== "failed") return Effect.void
                      if (!MutableHashMap.has(desired.byIdent, inst.ident)) return Effect.void
                      retire(live, inst)
                      counters.retries++
                      noteRetirement(inst, "retry")
                      retiredOutOfBand.push(inst)
                      return Effect.andThen(beginStop(inst), wakeUp)
                    })
                  )
                ),
              onFailure: () => Effect.void,
              onDone: () => Effect.void
            }),
            Effect.forkIn(rootScope),
            Effect.asVoid
          )
        })
      }

      onFailedStartup = superviseFailure
      onStarted = resetSupervisor

      /**
       * Bookkeeping every retirement shares, wherever it was decided.
       *
       * A retirement drops the backoff, with one exception that is the whole
       * point of having one: the retirement a backoff itself performs. Every
       * other reason means the failed generation is gone for reasons of its
       * own and whether its successor fails is a fresh question — but a
       * scheduled restart is the *same* question, asked again, and a schedule
       * that reset itself on each of its own attempts would never reach its
       * own limit. `Controller.retry` resets deliberately at its own call
       * site, because a person asking for an attempt now is a new question.
       */
      const noteRetirement = (inst: LiveInstance, reason: RetirementReason): void => {
        counters.retired++
        emit(() => ({ _tag: "Retired", lifetime: semanticRef(compiled, inst), reason }))
        if (reason !== "retry") resetSupervisor(inst.ident)
      }

      const reconcilePass: Effect.Effect<void> = Effect.gen(function* () {
        if (!open) return

        // Retirements decided outside a pass already reported themselves, and
        // the walk cannot report them a second time: a seed is retired — so
        // `stopping` — before it is queued here, and `invalidate` both enters
        // seeds directly into its walk rather than through `cascade` and skips
        // every already-obsolete generation. So `onRetired` only ever names a
        // generation this pass has just decided about, which is exactly what
        // `noteRetirement` wants to hear.
        const newlyObsolete = invalidate(
          live,
          desired,
          desiredRevision,
          retiredOutOfBand,
          noteRetirement
        )
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
          if (satisfying !== undefined && !isObsolete(satisfying)) {
            // The null check is inline rather than inside `republish` so the
            // overwhelmingly common case — a family that observes nothing —
            // costs a field read, not an Effect step per node per pass. At ten
            // thousand lifetimes that difference is the whole sweep.
            if (satisfying.observed !== null) yield* republish(satisfying, node)
            continue
          }
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
        const admittedBefore = counters.admitted
        const retiredBefore = counters.retired
        return Effect.andThen(
          reconcilePass,
          Effect.sync(() => {
            reconciledVersion = covered
            counters.passes++
            emit(() => ({
              _tag: "PassCompleted",
              admitted: counters.admitted - admittedBefore,
              retired: counters.retired - retiredBefore,
              settled: quiescent()
            }))
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
          // A closed Controller can only ever answer `ControllerClosed`, so
          // evaluating the Binding first would be an O(N) selector sweep whose
          // result is discarded — and one that still moves `memory.evaluated`,
          // which `diagnostics` reports. `open` is only ever set false, so
          // reading it outside the mutex can be stale in one direction: it may
          // still say open for a controller closing right now. That is not a
          // linearization change, because it is not the deciding read — the
          // authoritative check is still the one inside the publication
          // region below.
          if (!open) return Effect.fail(new ControllerClosed())
          // Pure, against this one immutable state value, outside the critical
          // section and outside any mask.
          // Evaluated outside the critical section, against one immutable
          // state value — including the memo reads and writes. That is safe
          // only because `commit` is the sole caller and commits linearize on
          // the same mutex the publication below takes: two commits can queue
          // for publication, but they cannot evaluate at the same time.
          const snapshot = evaluate(compiled, entries, state, memory)
          return serialized(
            // [atomic publication region]
            Effect.uninterruptible(
              Effect.suspend((): Effect.Effect<void, CommitError> => {
                if (!open) return Effect.fail(new ControllerClosed())
                if (Result.isFailure(snapshot)) return Effect.fail(snapshot.failure)
                desired = snapshot.success
                desiredRevision++
                counters.commits++
                emit(() => ({ _tag: "Committed", desired: desired.topo.length }))
                return wakeUp
              })
            )
          )
        })

      /** What one generation reports as. The single translation from internal
       * lifecycle to public vocabulary, so `status` and `snapshot` cannot
       * drift into two answers for the same generation. */
      const statusOf = (inst: LiveInstance): LifetimeStatus => {
        switch (inst.status) {
          case "starting":
            return { _tag: "Starting" }
          case "running":
            return { _tag: "Running" }
          case "failed":
            return { _tag: "Failed", cause: inst.failure ?? Cause.empty }
          case "stopping":
            return { _tag: "Stopping" }
        }
      }

      /** The generation answering for an identity, current or still draining. */
      const instanceFor = (ident: Ident): LiveInstance | undefined => {
        const inst = currentInstance(live, ident)
        if (inst !== undefined) return inst
        // A generation that is no longer current but still finalizing is
        // still something that exists. It has left `currentByIdent`, but it
        // cannot have left the slot it is draining out of.
        const cardinality = compiled.families[ident.familyId]!.cardinality
        return retiringInstance(live, slotIdent(ident.familyId, cardinality, ident), ident)
      }

      /**
       * The authoritative state of one semantic lifetime. Read under the same
       * mutex the reconciler mutates under, so it never observes a half-applied
       * pass.
       */
      const status = (ref: LifetimeRef): Effect.Effect<Option.Option<LifetimeStatus>> =>
        serialized(
          Effect.sync((): Option.Option<LifetimeStatus> => {
            const inst = instanceFor(identOf(compiled, ref))
            return inst === undefined ? Option.none() : Option.some(statusOf(inst))
          })
        )

      /**
       * Every generation at one instant, owners before children.
       *
       * Taken under the mutex for the reason the whole API exists: N separate
       * `status` calls interleave with N-1 chances for the runtime to move,
       * and a tree assembled from them can show a child Running under an
       * owner that has already stopped. Depth ordering is computed here
       * rather than trusted from `all`'s insertion order, which admission
       * happens to produce and nothing guarantees.
       */
      const snapshot: Effect.Effect<Snapshot> = serialized(
        Effect.sync((): Snapshot => {
          const withDepth: Array<{
            readonly entry: LifetimeEntry
            readonly ident: Ident
            readonly depth: number
          }> = []
          for (const inst of live.all) {
            let depth = 0
            for (let owner = inst.owner; owner !== null; owner = owner.owner) depth++
            withDepth.push({
              entry: {
                lifetime: semanticRef(compiled, inst),
                status: statusOf(inst),
                generation: inst.generation as LifetimeEntry["generation"],
                owner: inst.owner === null
                  ? null
                  : (inst.owner.generation as LifetimeEntry["generation"])
              },
              ident: inst.ident,
              depth
            })
          }
          withDepth.sort((a, b) => a.depth - b.depth)
          // Split, so the sort's wrapper records are garbage the moment this
          // returns: what the snapshot goes on holding is these two arrays and
          // nothing else. `idents` is positionally aligned with `lifetimes`,
          // and holds the instances' own identity objects rather than fresh
          // ones, so it costs a pointer per generation.
          const lifetimes = withDepth.map((d) => d.entry)
          const idents = withDepth.map((d) => d.ident)

          // Built on the first lookup, not here. A snapshot taken to render a
          // tree — the common case, and the one `Snapshot`'s doc comment
          // promises a cost for — never asks for it, and a UI holding the
          // previous snapshot to diff against would otherwise be holding two
          // full hash indexes rather than two arrays.
          let index: MutableHashMap.MutableHashMap<Ident, LifetimeStatus> | undefined
          return {
            lifetimes,
            get: (ref) => {
              // First, so a reference from another Definition is refused even
              // when the index would have been built anyway.
              const ident = identOf(compiled, ref)
              if (index === undefined) {
                const built = MutableHashMap.empty<Ident, LifetimeStatus>()
                for (let i = 0; i < lifetimes.length; i++) {
                  const entry = lifetimes[i]!
                  const at = idents[i]!
                  // `status` answers with the generation currently holding an
                  // identity and only falls back to one that is draining, so
                  // this must too: a current generation wins its identity
                  // however `all` happened to be ordered.
                  if (entry.status._tag !== "Stopping" || !MutableHashMap.has(built, at)) {
                    MutableHashMap.set(built, at, entry.status)
                  }
                }
                index = built
              }
              return MutableHashMap.get(index, ident)
            }
          }
        })
      )

      /**
       * Cumulative counters plus the current lifecycle census. The counters
       * are maintained unconditionally — they are integer increments on paths
       * already walked — but the census is an O(N) walk, so it is done here,
       * when asked, and never as part of reconciliation.
       */
      const diagnostics: Effect.Effect<Diagnostics> = serialized(
        Effect.sync((): Diagnostics => {
          let starting = 0
          let running = 0
          let failed = 0
          let stopping = 0
          for (const inst of live.all) {
            switch (inst.status) {
              case "starting":
                starting++
                break
              case "running":
                running++
                break
              case "failed":
                failed++
                break
              case "stopping":
                stopping++
                break
            }
          }
          return {
            lifetimes: { starting, running, failed, stopping, total: live.all.size },
            ...counters,
            // Read from the memory itself rather than copied at commit time.
            // Evaluation happens outside the mutex, so a copy taken there can
            // be published out of order by two concurrent commits and hand a
            // reader a *negative* rate between two samples. Read here, under
            // the mutex, they only ever increase — which is what "cumulative
            // and monotone" has to mean to be worth subtracting.
            selectorEvaluations: memory.evaluated,
            selectorEvaluationsSkipped: memory.skipped,
            settled: quiescent()
          }
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
              counters.retries++
              noteRetirement(inst, "retry")
              // Asked for by hand, so the backoff starts over: a control
              // plane that offers a Retry button has just been told the
              // situation changed, whatever the schedule believed.
              resetSupervisor(ident)
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
                // Every live generation is obsolete from this moment (§8.6),
                // and saying so here is what stops `status` and `snapshot`
                // reporting Running for a lifetime whose Scope is about to be
                // closed underneath it. The reconcile loop dies with the root
                // Scope, so no pass will ever do this on their behalf.
                for (const inst of live.all) {
                  if (!isObsolete(inst)) {
                    retire(live, inst)
                    noteRetirement(inst, "shutdown")
                  }
                }
              })
            ),
            Effect.andThen(Scope.close(rootScope, Exit.void)),
            // The close awaited every instance Scope and every in-flight stop
            // fiber, so this is a real finalization boundary for all of them
            // — and the one place the whole live state can be dropped at once
            // rather than one `beginStop` at a time.
            Effect.andThen(
              serialized(
                Effect.sync(() => {
                  for (const inst of [...live.all]) {
                    forget(live, inst)
                    counters.stopped++
                    emit(() => ({ _tag: "Stopped", lifetime: semanticRef(compiled, inst) }))
                  }
                })
              )
            ),
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
        events,
        status,
        snapshot,
        diagnostics,
        retry,
        shutdown,
        [TestHooksId]: {
          holding: serialized,
          idle,
          eventSubscribers: Effect.sync(() => eventSubscribers)
        }
      }
    })
  )
