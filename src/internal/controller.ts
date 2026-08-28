import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { pipe } from "effect/Function"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type { BindingEntry } from "../Binding.js"
import { ControllerClosed, type CommitError } from "../Errors.js"
import type { LifetimeFailure } from "../Failure.js"
import type { Owner } from "../Owner.js"
import type { Compiled, CompiledFamily, CompiledRequirement } from "./compiledDefinition.js"
import {
  emptySnapshot,
  evaluate,
  type DesiredNode,
  type DesiredSnapshot
} from "./desiredSnapshot.js"

type Status = "starting" | "running" | "stopping" | "failed"

/** One physical generation of a keyed lifetime. Semantic identity is the
 * path; physical identity is the object itself. */
interface LiveInstance {
  readonly familyId: number
  readonly key: unknown
  readonly path: string
  readonly slotId: string
  readonly owner: LiveInstance | null
  /** Exact physical provider instances captured at admission. Never rebound. */
  readonly providers: ReadonlyMap<string, LiveInstance>
  readonly scope: Scope.Closeable
  readonly children: Set<LiveInstance>
  status: Status
  obsolete: boolean
  providedContext: Context.Context<never>
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
  readonly failures: Effect.Effect<PubSub.Subscription<LifetimeFailure>, never, Scope.Scope>
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
    // Bookkeeping for the convergence barrier: `wakeVersion` counts requested
    // reconcile work, `reconciledVersion` the newest request a completed pass
    // has covered. Equal versions mean no pass is owed.
    let wakeVersion = 0
    let reconciledVersion = 0
    const slots = new Map<string, Slot>()
    const currentByPath = new Map<string, LiveInstance>()
    const all = new Set<LiveInstance>()

    const wakeUp = Effect.suspend(() => {
      wakeVersion++
      return Effect.asVoid(Queue.offer(wake, void 0))
    })

    const slotIdFor = (family: CompiledFamily, ownerPath: string, keyStr: string): string =>
      family.cardinality === "one"
        ? `${ownerPath}|${family.id}`
        : `${ownerPath}|${family.id}:${keyStr}`

    const getSlot = (id: string): Slot => {
      let slot = slots.get(id)
      if (slot === undefined) {
        slot = { current: undefined, retiring: new Set() }
        slots.set(id, slot)
      }
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
              const slot = slots.get(inst.slotId)
              if (slot !== undefined) {
                slot.retiring.delete(inst)
                if (slot.current === inst) slot.current = undefined
                if (slot.current === undefined && slot.retiring.size === 0) {
                  slots.delete(inst.slotId)
                }
              }
              if (currentByPath.get(inst.path) === inst) currentByPath.delete(inst.path)
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
          return pipe(
            PubSub.publish(failureLog, {
              family: compiled.families[inst.familyId]!.name,
              key: inst.key,
              owner: semanticOwner(inst.owner),
              cause: exit.cause
            }),
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

    /** The purely semantic reference chain of a live instance. */
    const semanticOwner = (inst: LiveInstance | null): Owner<unknown, unknown> | null =>
      inst === null ? null : {
        family: compiled.families[inst.familyId]!.name,
        key: inst.key,
        parent: semanticOwner(inst.owner)
      }

    const resolveProvider = (
      node: DesiredNode,
      requirement: CompiledRequirement
    ): LiveInstance | undefined => {
      if (requirement.kind === "ancestor") {
        const ancestor = node.chain[requirement.depth - 1]
        return ancestor === undefined ? undefined : currentByPath.get(ancestor.path)
      }
      const ownerNode = requirement.depth === 0 ? null : node.chain[requirement.depth - 1]
      const candidates = ownerNode == null
        ? desired.rootsByFamily.get(requirement.familyId)
        : ownerNode.childrenByFamily.get(requirement.familyId)
      const providerNode = candidates?.[0]
      return providerNode === undefined ? undefined : currentByPath.get(providerNode.path)
    }

    const admit = (
      node: DesiredNode,
      family: CompiledFamily,
      ownerLive: LiveInstance | null,
      providers: ReadonlyMap<string, LiveInstance>,
      slot: Slot,
      slotId: string
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const parentScope = ownerLive === null ? rootScope : ownerLive.scope
        const instScope = yield* Scope.fork(parentScope, "sequential")
        const inst: LiveInstance = {
          familyId: family.id,
          key: node.key,
          path: node.path,
          slotId,
          owner: ownerLive,
          providers,
          scope: instScope,
          children: new Set(),
          status: "starting",
          obsolete: false,
          providedContext: Context.empty(),
          closing: null
        }
        slot.current = inst
        currentByPath.set(node.path, inst)
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
          let invalid = !desired.byPath.has(inst.path)
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
          const slot = getSlot(inst.slotId)
          if (slot.current === inst) slot.current = undefined
          slot.retiring.add(inst)
          if (currentByPath.get(inst.path) === inst) currentByPath.delete(inst.path)
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
        const family = compiled.families[node.familyId]!
        let ownerLive: LiveInstance | null = null
        if (node.parent !== null) {
          const owner = currentByPath.get(node.parent.path)
          if (owner === undefined || owner.obsolete || owner.status !== "running") continue
          ownerLive = owner
        }
        const ownerPath = node.parent === null ? "" : node.parent.path
        const slotId = slotIdFor(family, ownerPath, node.keyStr)
        const slot = getSlot(slotId)
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

        yield* admit(node, family, ownerLive, providers, slot, slotId)
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
              return wakeUp
            })
          )
        )
      })

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
      for (const slot of slots.values()) {
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
      failures: PubSub.subscribe(failureLog),
      shutdown,
      [TestHooksId]: { holding: mutex.withPermits(1), idle }
    }
    })
  )
