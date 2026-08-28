import type * as Cause from "effect/Cause"
import * as CauseModule from "effect/Cause"
import * as Context from "effect/Context"
import * as Equal from "effect/Equal"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import { pipe } from "effect/Function"
import * as MutableHashMap from "effect/MutableHashMap"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Semaphore from "effect/Semaphore"
import type { BindingEntry } from "../Binding.js"
import { ControllerClosed, type CommitError } from "../Errors.js"
import { asInternal, isHandle } from "../Definition.js"
import type { LifetimeFailure } from "../Failure.js"
import type { LifetimeRef } from "../LifetimeRef.js"
import type { LifetimeStatus } from "../Status.js"
import type { Compiled, CompiledFamily, CompiledRequirement } from "./compiledDefinition.js"
import {
  emptySnapshot,
  evaluate,
  type DesiredNode,
  type DesiredSnapshot
} from "./desiredSnapshot.js"
import { Ident } from "./identity.js"

type Status = "starting" | "running" | "stopping" | "failed"

/** One physical generation of a keyed lifetime. Semantic identity is the
 * path; physical identity is the object itself. */
interface LiveInstance {
  readonly familyId: number
  readonly key: unknown
  /** Structural semantic identity: family, key and owner chain. */
  readonly ident: Ident
  /** Identity of the replacement slot this generation occupies. */
  readonly slot: Ident
  readonly owner: LiveInstance | null
  /** Exact physical provider instances captured at admission. Never rebound. */
  readonly providers: ReadonlyMap<string, LiveInstance>
  readonly scope: Scope.Closeable
  readonly children: Set<LiveInstance>
  status: Status
  obsolete: boolean
  /** Cache of "is this still desired?" for one published snapshot: many
   * reconcile passes run against the same desire. */
  desiredRevision: number
  desiredNode: DesiredNode | undefined
  providedContext: Context.Context<never>
  /** Why startup failed, for `status`. Set only in the `failed` state. */
  failure: Cause.Cause<unknown> | null
  /**
   * Set when a dedicated close of this instance's Scope is initiated
   * (obsolescence or startup failure) and completed only when that close has
   * fully run its finalizers. `Scope.close` on an already-closing scope
   * returns immediately, so THIS deferred — not close-call completion — is
   * the finalization boundary the bookkeeping relies on.
   */
  closing: Deferred.Deferred<void> | null
}

interface Slot {
  current: LiveInstance | undefined
  /** Obsolete generations still finalizing. Sequential replacement waits for
   * this set to drain before admitting the latest desired replacement. */
  readonly retiring: Set<LiveInstance>
}

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
  entries: ReadonlyMap<number, BindingEntry<State>>,
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
    const wake = yield* Queue.sliding<void>(1)
    // Sliding: publishing a failure never blocks the controller, and with no
    // subscriber attached nothing is retained.
    const failureLog = yield* PubSub.sliding<LifetimeFailure>(64)

    let open = true
    let desired: DesiredSnapshot = emptySnapshot
    let desiredRevision = 0
    // Bookkeeping for the convergence barrier: `wakeVersion` counts requested
    // reconcile work, `reconciledVersion` the newest request a completed pass
    // has covered. Equal versions mean no pass is owed.
    let wakeVersion = 0
    let reconciledVersion = 0
    const slots = MutableHashMap.empty<Ident, Slot>()
    const currentByIdent = MutableHashMap.empty<Ident, LiveInstance>()
    const all = new Set<LiveInstance>()

    const wakeUp = Effect.suspend(() => {
      wakeVersion++
      return Effect.asVoid(Queue.offer(wake, void 0))
    })

    const getSlot = (id: Ident): Slot => {
      const existing = MutableHashMap.get(slots, id)
      if (Option.isSome(existing)) return existing.value
      const slot: Slot = { current: undefined, retiring: new Set() }
      MutableHashMap.set(slots, id, slot)
      return slot
    }

    /**
     * Initiate (or join) the dedicated close of one instance's Scope. The
     * returned Effect completes only when the instance's finalizers have
     * fully run, even when the Scope was already closing — a second
     * `Scope.close` on a closing scope returns immediately, so joiners await
     * the `closing` deferred of the close that actually ran instead.
     */
    const closeInstance = (
      inst: LiveInstance,
      exit: Exit.Exit<unknown, unknown>
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (inst.closing !== null) return Deferred.await(inst.closing)
        const done = Deferred.makeUnsafe<void>()
        inst.closing = done
        return pipe(
          Scope.close(inst.scope, exit),
          Effect.ensuring(Deferred.succeed(done, void 0)),
          Effect.asVoid
        )
      })

    /**
     * Collect the part of the subtree whose finalization this instance's
     * close actually covers. A descendant with its own dedicated close in
     * flight is skipped: the ancestor's Scope-close does not await it, and
     * that descendant's own close fiber performs its bookkeeping.
     */
    const collectOwnedSubtree = (inst: LiveInstance, acc: Array<LiveInstance>): void => {
      acc.push(inst)
      for (const child of inst.children) {
        if (child.closing === null) collectOwnedSubtree(child, acc)
      }
    }

    const onStopDone = (root: LiveInstance): Effect.Effect<void> =>
      pipe(
        mutex.withPermits(1)(
          Effect.sync(() => {
            const subtree: Array<LiveInstance> = []
            collectOwnedSubtree(root, subtree)
            for (const inst of subtree) {
              all.delete(inst)
              const slot = MutableHashMap.get(slots, inst.slot)
              if (Option.isSome(slot)) {
                slot.value.retiring.delete(inst)
                if (slot.value.current === inst) slot.value.current = undefined
                if (slot.value.current === undefined && slot.value.retiring.size === 0) {
                  MutableHashMap.remove(slots, inst.slot)
                }
              }
              const current = MutableHashMap.get(currentByIdent, inst.ident)
              if (Option.isSome(current) && current.value === inst) {
                MutableHashMap.remove(currentByIdent, inst.ident)
              }
              inst.owner?.children.delete(inst)
            }
          })
        ),
        Effect.andThen(wakeUp)
      )

    /** Close an obsolete instance and, once ITS finalization boundary is
     * reached, retire its bookkeeping. Uninterruptible so that controller
     * shutdown awaits these finalizers instead of abandoning them. */
    const beginStop = (inst: LiveInstance): Effect.Effect<void> =>
      pipe(
        Effect.uninterruptible(closeInstance(inst, Exit.void)),
        Effect.ensuring(onStopDone(inst)),
        Effect.forkIn(rootScope),
        Effect.asVoid
      )

    const onStartupDone = (
      inst: LiveInstance,
      exit: Exit.Exit<unknown, unknown>
    ): Effect.Effect<void> =>
      mutex.withPermits(1)(
        Effect.suspend((): Effect.Effect<void> => {
          // Late completion of an obsolete or superseded startup never
          // publishes capabilities or regains authority.
          if (!open || inst.obsolete || inst.status !== "starting") return Effect.void
          if (Exit.isSuccess(exit)) {
            inst.status = "running"
            inst.providedContext = Context.isContext(exit.value)
              ? (exit.value as Context.Context<never>)
              : Context.empty()
            return wakeUp
          }
          // Startup failure is a normal runtime condition: partial resources
          // finalize, the failed generation blocks its slot until desire
          // changes (no automatic retry in v0). External interruption always
          // marks the instance obsolete (or closes the controller) first, so
          // an interrupted exit reaching this point means the start Effect
          // interrupted itself — treated as failure, not left wedged.
          inst.status = "failed"
          inst.failure = exit.cause
          // Only a failure whose semantic desire is still current is an
          // application-visible failure. Desire can have been withdrawn
          // between admission and this completion, before the reconcile pass
          // that will obsolete this generation has even run.
          const stillDesired = MutableHashMap.has(desired.byIdent, inst.ident)
          return pipe(
            stillDesired
              ? PubSub.publish(failureLog, { lifetime: semanticRef(inst), cause: exit.cause })
              : Effect.void,
            Effect.andThen(
              pipe(
                Effect.uninterruptible(closeInstance(inst, exit)),
                Effect.forkIn(rootScope),
                Effect.asVoid
              )
            )
          )
        })
      )

    /** The purely semantic reference of a live instance. */
    const semanticRef = (inst: LiveInstance): LifetimeRef => ({
      family: compiled.families[inst.familyId]!.handle,
      key: inst.key,
      parent: inst.owner === null ? null : semanticRef(inst.owner)
    }) as LifetimeRef

    /**
     * The internal path a semantic reference names. A reference whose family
     * belongs to another Definition cannot name anything here and is a
     * programming error, so it is reported as a defect rather than silently
     * matching nothing.
     */
    const identOf = (ref: LifetimeRef): Ident => {
      if (!isHandle(ref.family) || asInternal(ref.family).identity !== compiled.identity) {
        throw new Error(
          "effect-reconciler: LifetimeRef names a family from a different Definition"
        )
      }
      const family = compiled.families[asInternal(ref.family).familyId]!
      const parent = ref.parent === null ? null : identOf(ref.parent as LifetimeRef)
      return new Ident(family.id, ref.key, parent)
    }

    const resolveProvider = (
      node: DesiredNode,
      requirement: CompiledRequirement
    ): LiveInstance | undefined => {
      if (requirement.kind === "ancestor") {
        const ancestor = node.chain[requirement.depth - 1]
        return ancestor === undefined
          ? undefined
          : Option.getOrUndefined(MutableHashMap.get(currentByIdent, ancestor.ident))
      }
      const ownerNode = requirement.depth === 0 ? null : node.chain[requirement.depth - 1]
      const candidates = ownerNode == null
        ? desired.rootsByFamily.get(requirement.familyId)
        : ownerNode.childrenByFamily.get(requirement.familyId)
      const providerNode = candidates?.[0]
      return providerNode === undefined
        ? undefined
        : Option.getOrUndefined(MutableHashMap.get(currentByIdent, providerNode.ident))
    }

    const admit = (
      node: DesiredNode,
      family: CompiledFamily,
      ownerLive: LiveInstance | null,
      providers: ReadonlyMap<string, LiveInstance>,
      slot: Slot,
      slotIdent: Ident
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const parentScope = ownerLive === null ? rootScope : ownerLive.scope
        const instScope = yield* Scope.fork(parentScope, "sequential")
        const inst: LiveInstance = {
          familyId: family.id,
          key: node.key,
          ident: node.ident,
          slot: slotIdent,
          owner: ownerLive,
          providers,
          scope: instScope,
          children: new Set(),
          status: "starting",
          obsolete: false,
          desiredRevision: -1,
          desiredNode: undefined,
          providedContext: Context.empty(),
          failure: null,
          closing: null
        }
        slot.current = inst
        MutableHashMap.set(currentByIdent, node.ident, inst)
        node.live = inst
        inst.desiredRevision = desiredRevision
        inst.desiredNode = node
        all.add(inst)
        ownerLive?.children.add(inst)

        // Immutable startup environment: root environment, then ancestor
        // capabilities (root-most first), then required provider capabilities,
        // then the instance Scope.
        let ctx: Context.Context<never> = rootContext
        const ancestors: Array<LiveInstance> = []
        for (let a = ownerLive; a !== null; a = a.owner) ancestors.unshift(a)
        for (const ancestor of ancestors) ctx = Context.merge(ctx, ancestor.providedContext)
        for (const provider of providers.values()) ctx = Context.merge(ctx, provider.providedContext)
        const startContext = Context.add(ctx, Scope.Scope, instScope)

        // Startup is forked explicitly interruptible: closing the instance
        // Scope must be able to cancel it, even though admission itself runs
        // inside the uninterruptible controller pass.
        const startFiber = yield* pipe(
          Effect.suspend(() => family.start(inst.key)) as Effect.Effect<
            unknown,
            unknown,
            Scope.Scope
          >,
          Effect.interruptible,
          Effect.provide(startContext),
          Effect.forkIn(instScope)
        )
        yield* pipe(
          Fiber.await(startFiber),
          Effect.flatMap((exit) => onStartupDone(inst, exit)),
          Effect.interruptible,
          Effect.forkIn(rootScope)
        )
      })

    const reconcilePass: Effect.Effect<void> = Effect.gen(function* () {
      if (!open) return

      // Phase A — obsolescence. A physical lifetime remains valid only while
      // its semantic desire is current, its physical owner is current and all
      // bound provider instances are current. Propagate to fixpoint.
      const newlyObsolete: Array<LiveInstance> = []
      let changed = true
      while (changed) {
        changed = false
        for (const inst of all) {
          if (inst.obsolete) continue
          if (inst.desiredRevision !== desiredRevision) {
            inst.desiredRevision = desiredRevision
            const node = Option.getOrUndefined(MutableHashMap.get(desired.byIdent, inst.ident))
            inst.desiredNode = node
            // Matching desire to live instances once per snapshot lets the
            // admission phase skip satisfied nodes without a lookup.
            if (node !== undefined) node.live = inst
          }
          let invalid = inst.desiredNode === undefined
          if (!invalid && inst.owner !== null && inst.owner.obsolete) invalid = true
          if (!invalid) {
            for (const provider of inst.providers.values()) {
              if (provider.obsolete) {
                invalid = true
                break
              }
            }
          }
          if (invalid) {
            inst.obsolete = true
            newlyObsolete.push(inst)
            changed = true
          }
        }
      }
      if (newlyObsolete.length > 0) {
        const newlySet = new Set(newlyObsolete)
        for (const inst of newlyObsolete) {
          const slot = getSlot(inst.slot)
          if (slot.current === inst) slot.current = undefined
          slot.retiring.add(inst)
          const current = MutableHashMap.get(currentByIdent, inst.ident)
          if (Option.isSome(current) && current.value === inst) {
            MutableHashMap.remove(currentByIdent, inst.ident)
          }
          inst.status = "stopping"
        }
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
      }

      // Phase B — admission, owners before children. A new physical lifetime
      // is admitted only while its desire is current, its owner is current
      // and Running, all required providers are current and Running, and the
      // replacement policy permits it.
      for (const node of desired.topo) {
        // Already satisfied by a current generation: nothing to admit, and no
        // need to hash anything to find that out.
        const satisfying = node.live as LiveInstance | undefined
        if (satisfying !== undefined && !satisfying.obsolete) continue

        const family = compiled.families[node.familyId]!
        let ownerLive: LiveInstance | null = null
        if (node.parent !== null) {
          const known = node.parent.live as LiveInstance | undefined
          const owner = known !== undefined && !known.obsolete
            ? known
            : Option.getOrUndefined(MutableHashMap.get(currentByIdent, node.parent.ident))
          if (owner === undefined || owner.obsolete || owner.status !== "running") continue
          ownerLive = owner
        }
        const slot = getSlot(node.slot)
        if (slot.current !== undefined) continue

        const providers = new Map<string, LiveInstance>()
        let ready = true
        for (const requirement of family.requires) {
          const provider = resolveProvider(node, requirement)
          if (provider === undefined || provider.obsolete || provider.status !== "running") {
            ready = false
            break
          }
          providers.set(requirement.name, provider)
        }
        if (!ready) continue
        if (family.replacement === "sequential" && slot.retiring.size > 0) continue

        yield* admit(node, family, ownerLive, providers, slot, node.slot)
      }
    })

    // Reconcile loop: converge toward the latest authoritative desired
    // snapshot whenever woken by a commit or a lifecycle event.
    // Explicitly interruptible even though construction is uninterruptible:
    // shutdown must be able to stop the loop, while each individual pass
    // still runs to completion under its own mask.
    const onePass = Effect.suspend(() => {
      const covered = wakeVersion
      return Effect.andThen(
        reconcilePass,
        Effect.sync(() => {
          reconciledVersion = covered
        })
      )
    })

    yield* pipe(
      Queue.take(wake),
      Effect.andThen(mutex.withPermits(1)(Effect.uninterruptible(onePass))),
      Effect.forever,
      Effect.interruptible,
      Effect.forkIn(rootScope)
    )

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
        return mutex.withPermits(1)(
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
      mutex.withPermits(1)(
        Effect.sync((): Option.Option<LifetimeStatus> => {
          const ident = identOf(ref)
          const inst = Option.getOrUndefined(MutableHashMap.get(currentByIdent, ident))
          if (inst !== undefined) {
            switch (inst.status) {
              case "starting":
                return Option.some({ _tag: "Starting" })
              case "running":
                return Option.some({ _tag: "Running" })
              case "failed":
                return Option.some({
                  _tag: "Failed",
                  cause: inst.failure ?? CauseModule.empty
                })
              case "stopping":
                return Option.some({ _tag: "Stopping" })
            }
          }
          // A generation that is no longer current but still finalizing is
          // still something that exists.
          for (const other of all) {
            if (Equal.equals(other.ident, ident)) return Option.some({ _tag: "Stopping" })
          }
          return Option.none()
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
      mutex.withPermits(1)(
        Effect.uninterruptible(
          Effect.suspend((): Effect.Effect<void, ControllerClosed> => {
            if (!open) return Effect.fail(new ControllerClosed())
            const ident = identOf(ref)
            const inst = Option.getOrUndefined(MutableHashMap.get(currentByIdent, ident))
            if (inst === undefined || inst.status !== "failed") return Effect.void
            if (!MutableHashMap.has(desired.byIdent, ident)) return Effect.void

            // Retire it exactly as obsolescence does, so the replacement
            // policy still governs when the fresh generation may start.
            inst.obsolete = true
            inst.status = "stopping"
            const slot = getSlot(inst.slot)
            if (slot.current === inst) slot.current = undefined
            slot.retiring.add(inst)
            MutableHashMap.remove(currentByIdent, ident)
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
          mutex.withPermits(1)(
            Effect.sync(() => {
              open = false
              desired = emptySnapshot
              desiredRevision++
            })
          ),
          Effect.andThen(Scope.close(rootScope, Exit.void)),
          Effect.andThen(Deferred.succeed(shutdownGate, void 0)),
          Effect.asVoid
        )
      })
    )

    yield* Effect.addFinalizer(() => shutdown)

    const quiescent = (): boolean => {
      if (reconciledVersion !== wakeVersion) return false
      for (const inst of all) {
        if (inst.status === "starting" || inst.status === "stopping") return false
        // A failed generation keeps its `closing` deferred forever; only a
        // close that has not reached its finalization boundary is unsettled.
        if (inst.closing !== null && !Deferred.isDoneUnsafe(inst.closing)) return false
      }
      for (const slot of MutableHashMap.values(slots)) {
        if (slot.retiring.size > 0) return false
      }
      return true
    }

    const idle: Effect.Effect<void> = Effect.suspend(() =>
      Effect.flatMap(
        mutex.withPermits(1)(Effect.sync(quiescent)),
        (settled) => (settled ? Effect.void : Effect.andThen(Effect.sleep(1), idle))
      )
    )

    return {
      commit,
      failures: Stream.fromPubSub(failureLog),
      status,
      retry,
      shutdown,
      [TestHooksId]: { holding: mutex.withPermits(1), idle }
    }
    })
  )
