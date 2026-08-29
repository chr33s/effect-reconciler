import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Latch from "effect/Latch"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

/**
 * Experimental REBASE kernel: Atom owns authoritative desire and status,
 * Layer owns capability construction, and this module owns only physical
 * generation policy. It intentionally has no Binding evaluator, change/failure
 * streams, diagnostics event log, observation channel or nested Controller.
 */

export type Cardinality = "one" | "many"
export type Replacement = "sequential" | "overlap"

export interface Family<K = any> {
  readonly name: string
  readonly cardinality: Cardinality
  readonly replacement: Replacement
  /** The second argument is instrumentation-only and is not semantic input. */
  readonly layer: (key: K, physicalGeneration: number) => Layer.Layer<any, any, any>
}

export const family = <K>(options: {
  readonly name: string
  readonly cardinality: Cardinality
  readonly replacement?: Replacement
  readonly layer: (key: K, physicalGeneration: number) => Layer.Layer<any, any, any>
}): Family<K> => Equal.byReference({
  ...options,
  replacement: options.replacement ?? "sequential"
})

export interface Ref<K = any> {
  readonly family: Family<K>
  readonly key: K
  readonly parent: Ref<any> | null
}

export const ref = <K>(family: Family<K>, key: K, parent: Ref | null): Ref<K> => ({
  family,
  key,
  parent
})

export interface RefCache {
  /** Interns owner-relative identities using Effect Equal / Hash for the key. */
  readonly get: <K>(family: Family<K>, key: K, parent: Ref | null) => Ref<K>
}

export const makeRefCache = (): RefCache => {
  const roots = new Map<Family, MutableHashMap.MutableHashMap<any, Ref>>()
  const children = new WeakMap<Ref, Map<Family, MutableHashMap.MutableHashMap<any, Ref>>>()
  return {
    get: <K>(family: Family<K>, key: K, parent: Ref | null): Ref<K> => {
      const byFamily = parent === null
        ? roots
        : (() => {
            let known = children.get(parent)
            if (known === undefined) {
              known = new Map()
              children.set(parent, known)
            }
            return known
          })()
      let byKey = byFamily.get(family)
      if (byKey === undefined) {
        byKey = MutableHashMap.empty<any, Ref>()
        byFamily.set(family, byKey)
      }
      const known = Option.getOrUndefined(MutableHashMap.get(byKey, key))
      if (known !== undefined) return known as Ref<K>
      const created = ref(family, key, parent)
      MutableHashMap.set(byKey, key, created)
      return created
    }
  }
}

export interface DesiredNode<K = any> {
  readonly ref: Ref<K>
  /** Exact semantic provider identities this generation must capture. */
  readonly providers?: ReadonlyArray<Ref>
}

export type Status =
  | { readonly _tag: "None" }
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> }
  | { readonly _tag: "Stopping" }

export interface SnapshotEntry {
  readonly ref: Ref
  readonly generation: number
  readonly owner: number | null
  readonly status: Exclude<Status, { readonly _tag: "None" }>
}

export interface Snapshot {
  readonly generations: ReadonlyArray<SnapshotEntry>
}

export class LifetimeUnavailable {
  readonly _tag = "RebaseLifetimeUnavailable"
  constructor(readonly ref: Ref) {}
}

interface Generation {
  readonly generation: number
  readonly desiredRef: Ref
  readonly slot: Slot
  readonly owner: Generation | null
  readonly providers: ReadonlyArray<Generation>
  readonly scope: Scope.Closeable
  readonly children: Set<Generation>
  status: "starting" | "running" | "failed" | "stopping"
  output: Context.Context<never>
  childContext: Context.Context<never>
  failure: Cause.Cause<unknown> | null
  closing: Deferred.Deferred<void> | null
}

interface Slot {
  current: Generation | undefined
  readonly retiring: Set<Generation>
}

const none: Status = { _tag: "None" }

export interface Kernel {
  readonly registry: AtomRegistry.AtomRegistry
  /** One authoritative reactive status value per semantic identity. */
  readonly status: (ref: Ref) => Atom.Atom<Status>
  readonly retry: (ref: Ref) => Effect.Effect<void>
  readonly run: <A, E, R>(
    ref: Ref,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | LifetimeUnavailable>
  readonly snapshot: Effect.Effect<Snapshot>
  readonly idle: Effect.Effect<void>
  readonly shutdown: Effect.Effect<void>
}

export const make = (
  desiredAtom: Atom.Atom<ReadonlyArray<DesiredNode>>,
  options?: { readonly registry?: AtomRegistry.AtomRegistry }
): Effect.Effect<Kernel, never, Scope.Scope> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const registry = options?.registry ?? AtomRegistry.make({
        scheduleTask: (task) => {
          task()
          return () => {}
        }
      })
      const ownsRegistry = options?.registry === undefined
      const rootScope = yield* Scope.make()
      const mutex = yield* Semaphore.make(1)
      const serialized = mutex.withPermits(1)
      const wake = yield* Latch.make(false)
      const converged = yield* Latch.make(false)

      // Ref values are canonical identities. Native maps avoid re-hashing the
      // complete owner path on every lookup; the application-facing ref cache
      // is therefore an explicit part of this small kernel contract.
      const rootOneSlots = new Map<Family, Slot>()
      const childOneSlots = new WeakMap<Ref, Map<Family, Slot>>()
      const manySlots = new Map<Ref, Slot>()
      const currentByRef = new Map<Ref, Generation>()
      const all = new Set<Generation>()
      // Status is Atom-native but remains pay-for-play: an identity nobody has
      // asked to observe gets no Atom node and no registry writes. Creating an
      // Atom eagerly for every generation made a 10k build retain tens of
      // thousands of otherwise invisible reactive nodes.
      const statusAtoms = new Map<Ref, Atom.Writable<Status>>()
      let desired: ReadonlyArray<DesiredNode> = []
      let desiredByRef = new Map<Ref, DesiredNode>()
      let nextGeneration = 1
      let open = true
      let wakeVersion = 0
      let reconciledVersion = 0
      let asyncWakeScheduled = false

      const wakeUp = (): void => {
        wakeVersion++
        Latch.closeUnsafe(converged)
        Latch.openUnsafe(wake)
      }

      // Startup/finalizer completions commonly arrive in large batches. A wake
      // per completion turns the topological desired scan into O(n²) work.
      // One zero-delay timer lets the runnable batch drain before reconciling.
      const scheduleAsyncWake = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (asyncWakeScheduled) return Effect.void
          asyncWakeScheduled = true
          return Effect.sleep(0).pipe(
            Effect.andThen(
              serialized(
                Effect.sync(() => {
                  asyncWakeScheduled = false
                  wakeUp()
                })
              )
            ),
            Effect.forkIn(rootScope),
            Effect.asVoid
          )
        })

      const current = (identity: Ref): Generation | undefined => currentByRef.get(identity)

      const slotFor = (identity: Ref): Slot => {
        if (identity.family.cardinality === "many") {
          const known = manySlots.get(identity)
          if (known !== undefined) return known
          const created: Slot = { current: undefined, retiring: new Set() }
          manySlots.set(identity, created)
          return created
        }
        if (identity.parent === null) {
          const known = rootOneSlots.get(identity.family)
          if (known !== undefined) return known
          const created: Slot = { current: undefined, retiring: new Set() }
          rootOneSlots.set(identity.family, created)
          return created
        }
        let byFamily = childOneSlots.get(identity.parent)
        if (byFamily === undefined) {
          byFamily = new Map()
          childOneSlots.set(identity.parent, byFamily)
        }
        const known = byFamily.get(identity.family)
        if (known !== undefined) return known
        const created: Slot = { current: undefined, retiring: new Set() }
        byFamily.set(identity.family, created)
        return created
      }

      const statusOf = (inst: Generation): Exclude<Status, { readonly _tag: "None" }> => {
        switch (inst.status) {
          case "starting": return { _tag: "Starting" }
          case "running": return { _tag: "Running" }
          case "failed": return { _tag: "Failed", cause: inst.failure ?? Cause.empty }
          case "stopping": return { _tag: "Stopping" }
        }
      }

      const readStatus = (identity: Ref): Status => {
        const live = current(identity)
        if (live !== undefined) return statusOf(live)
        const slot = slotFor(identity)
        const retiring = [...slot.retiring].find((inst) => inst.desiredRef === identity)
        return retiring === undefined ? none : { _tag: "Stopping" }
      }

      const publishStatus = (identity: Ref): void => {
        const atom = statusAtoms.get(identity)
        if (atom !== undefined) registry.set(atom, readStatus(identity))
      }

      const status = (identity: Ref): Atom.Atom<Status> => {
        const known = statusAtoms.get(identity)
        if (known !== undefined) return known
        const created = Atom.make<Status>(readStatus(identity))
        statusAtoms.set(identity, created)
        return created
      }

      const closeInstance = (inst: Generation): Effect.Effect<void> => {
        if (inst.closing !== null) return Deferred.await(inst.closing)
        const done = Deferred.makeUnsafe<void>()
        inst.closing = done
        return Scope.close(inst.scope, Exit.void).pipe(
          Effect.ensuring(Deferred.succeed(done, void 0)),
          Effect.asVoid
        )
      }

      const beginStop = (inst: Generation): Effect.Effect<void> =>
        closeInstance(inst).pipe(
          Effect.ensuring(
            serialized(
              Effect.sync(() => {
                all.delete(inst)
                inst.owner?.children.delete(inst)
                inst.slot.retiring.delete(inst)
                publishStatus(inst.desiredRef)
              }).pipe(Effect.andThen(scheduleAsyncWake()))
            )
          ),
          Effect.forkIn(rootScope, { uninterruptible: true }),
          Effect.asVoid
        )

      const retire = (inst: Generation): Effect.Effect<void> => {
        if (inst.status === "stopping") return Effect.void
        inst.status = "stopping"
        if (inst.slot.current === inst) inst.slot.current = undefined
        inst.slot.retiring.add(inst)
        if (current(inst.desiredRef) === inst) currentByRef.delete(inst.desiredRef)
        publishStatus(inst.desiredRef)
        return beginStop(inst)
      }

      const startupIsAuthoritative = (
        inst: Generation,
        checked: Set<Generation> = new Set()
      ): boolean => {
        if (checked.has(inst)) return true
        checked.add(inst)
        if (current(inst.desiredRef) !== inst) return false
        const node = desiredByRef.get(inst.desiredRef)
        if (node === undefined) return false
        if (node.ref.parent === null) {
          if (inst.owner !== null) return false
        } else {
          const owner = current(node.ref.parent)
          if (owner === undefined || owner !== inst.owner || !startupIsAuthoritative(owner, checked)) {
            return false
          }
        }
        const providerRefs = node.providers ?? []
        if (providerRefs.length !== inst.providers.length) return false
        for (let index = 0; index < providerRefs.length; index++) {
          const provider = current(providerRefs[index]!)
          if (
            provider === undefined ||
            provider !== inst.providers[index] ||
            !startupIsAuthoritative(provider, checked)
          ) return false
        }
        return true
      }

      const provideLayer = (
        layer: Layer.Layer<any, any, any>,
        context: Context.Context<never>
      ): Layer.Layer<any, any> =>
        Layer.provide(
          layer,
          Layer.succeedContext(context) as Layer.Layer<any>
        ) as Layer.Layer<any, any>

      const start = (
        node: DesiredNode,
        owner: Generation | null,
        providers: ReadonlyArray<Generation>
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const scope = yield* Scope.fork(owner?.scope ?? rootScope, "sequential")
          const generation = nextGeneration++
          let context = owner?.childContext ?? Context.empty()
          for (const provider of providers) context = Context.merge(context, provider.output)
          const slot = slotFor(node.ref)
          const inst: Generation = {
            generation,
            desiredRef: node.ref,
            slot,
            owner,
            providers,
            scope,
            children: new Set(),
            status: "starting",
            output: Context.empty(),
            childContext: context,
            failure: null,
            closing: null
          }
          owner?.children.add(inst)
          all.add(inst)
          slot.current = inst
          currentByRef.set(node.ref, inst)
          publishStatus(node.ref)

          const built = Layer.buildWithScope(
            provideLayer(node.ref.family.layer(node.ref.key, generation), context),
            scope
          )
          const fiber = yield* Effect.forkIn(built, scope)
          yield* Effect.forkIn(
            Fiber.await(fiber).pipe(
              Effect.flatMap((exit) =>
                serialized(
                  Effect.suspend(() => {
                    if (!open || inst.status !== "starting" || current(inst.desiredRef) !== inst) {
                      return Effect.void
                    }
                    if (!startupIsAuthoritative(inst)) return retire(inst)
                    if (Exit.isSuccess(exit)) {
                      inst.output = exit.value
                      inst.childContext = Context.merge(context, exit.value)
                      inst.status = "running"
                      publishStatus(inst.desiredRef)
                      return scheduleAsyncWake()
                    }
                    inst.status = "failed"
                    inst.failure = exit.cause
                    publishStatus(inst.desiredRef)
                    return Effect.andThen(
                      scheduleAsyncWake(),
                      closeInstance(inst).pipe(
                        Effect.ensuring(scheduleAsyncWake()),
                        Effect.forkIn(rootScope, { uninterruptible: true }),
                        Effect.asVoid
                      )
                    )
                  })
                )),
              Effect.asVoid
            ),
            rootScope
          )
        })

      const invalidate: Effect.Effect<void> = Effect.gen(function* () {
        // Admission is topological, so insertion order is owner/provider first.
        // Removing those current indexes first makes invalidity cascade in one
        // pass without a second dependency graph.
        for (const inst of all) {
          if (inst.status === "stopping" || current(inst.desiredRef) !== inst) continue
          const node = desiredByRef.get(inst.desiredRef)
          if (node === undefined) {
            yield* retire(inst)
            continue
          }
          const wantedOwner = node.ref.parent === null ? null : current(node.ref.parent)
          if (wantedOwner !== inst.owner) {
            yield* retire(inst)
            continue
          }
          const wantedProviders = node.providers ?? []
          let valid = wantedProviders.length === inst.providers.length
          for (let index = 0; valid && index < wantedProviders.length; index++) {
            valid = current(wantedProviders[index]!) === inst.providers[index]
          }
          if (!valid) yield* retire(inst)
        }
      })

      const admit: Effect.Effect<void> = Effect.gen(function* () {
        for (const node of desired) {
          if (current(node.ref) !== undefined) continue
          const owner = node.ref.parent === null ? null : current(node.ref.parent)
          if (node.ref.parent !== null && (owner == null || owner.status !== "running")) continue
          const providers: Array<Generation> = []
          let providersReady = true
          for (const providerRef of node.providers ?? []) {
            const provider = current(providerRef)
            if (provider === undefined || provider.status !== "running") {
              providersReady = false
              break
            }
            providers.push(provider)
          }
          if (!providersReady) continue
          const slot = slotFor(node.ref)
          if (slot.current !== undefined) continue
          if (node.ref.family.replacement === "sequential" && slot.retiring.size > 0) continue
          yield* start(node, owner ?? null, providers)
        }
      })

      const settled = (): boolean => {
        if (asyncWakeScheduled || wakeVersion !== reconciledVersion) return false
        for (const inst of all) {
          if (inst.status === "starting" || inst.status === "stopping") return false
          if (inst.closing !== null && !Deferred.isDoneUnsafe(inst.closing)) return false
        }
        return true
      }

      const pass: Effect.Effect<void> = Effect.gen(function* () {
        if (!open) return
        const covered = wakeVersion
        yield* invalidate
        yield* admit
        reconciledVersion = covered
        if (settled()) Latch.openUnsafe(converged)
      })

      yield* wake.await.pipe(
        Effect.andThen(wake.close),
        Effect.andThen(serialized(Effect.uninterruptible(pass))),
        Effect.forever,
        Effect.forkIn(rootScope)
      )

      const publishDesired = (next: ReadonlyArray<DesiredNode>): void => {
        if (!open) return
        const index = new Map<Ref, DesiredNode>()
        for (const node of next) {
          if (index.has(node.ref)) throw new Error(`duplicate desired identity: ${node.ref.family.name}`)
          index.set(node.ref, node)
        }
        desired = next
        desiredByRef = index
        wakeUp()
      }
      const unsubscribe = registry.subscribe(desiredAtom, publishDesired, { immediate: true })

      const idle: Effect.Effect<void> = Effect.suspend(() =>
        Effect.flatMap(
          serialized(Effect.sync(settled)),
          (done) => done ? Effect.void : Effect.andThen(converged.await, idle)
        )
      )

      const retry = (identity: Ref): Effect.Effect<void> =>
        serialized(
          Effect.suspend(() => {
            const inst = current(identity)
            if (inst === undefined || inst.status !== "failed") return Effect.void
            if (!desiredByRef.has(identity)) return Effect.void
            return Effect.andThen(retire(inst), Effect.sync(wakeUp))
          })
        )

      const run = <A, E, R>(
        identity: Ref,
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E | LifetimeUnavailable> =>
        Effect.flatMap(
          serialized(
            Effect.gen(function* () {
              const inst = current(identity)
              if (inst === undefined || inst.status !== "running") {
                return yield* Effect.fail(new LifetimeUnavailable(identity))
              }
              return yield* Effect.forkIn(
                Effect.provide(effect, inst.childContext as unknown as Context.Context<R>),
                inst.scope
              )
            })
          ),
          Fiber.join
        )

      const snapshot: Effect.Effect<Snapshot> = serialized(
        Effect.sync(() => ({
          generations: [...all]
            .sort((a, b) => {
              const depth = (inst: Generation): number => {
                let value = 0
                for (let owner = inst.owner; owner !== null; owner = owner.owner) value++
                return value
              }
              return depth(a) - depth(b)
            })
            .map((inst) => ({
              ref: inst.desiredRef,
              generation: inst.generation,
              owner: inst.owner?.generation ?? null,
              status: statusOf(inst)
            }))
        }))
      )

      let shutdownStarted = false
      const shutdown = Effect.uninterruptible(
        Effect.suspend(() => {
          if (shutdownStarted) return Effect.void
          shutdownStarted = true
          unsubscribe()
          return Effect.andThen(
            serialized(
              Effect.gen(function* () {
                open = false
                for (const inst of [...all]) yield* retire(inst)
              })
            ),
            Effect.andThen(
              Scope.close(rootScope, Exit.void),
              Effect.sync(() => {
                if (ownsRegistry) registry.dispose()
                all.clear()
                rootOneSlots.clear()
                manySlots.clear()
                currentByRef.clear()
                statusAtoms.clear()
              })
            )
          )
        })
      )

      yield* Effect.addFinalizer(() => shutdown)

      return {
        registry,
        status,
        retry,
        run,
        snapshot,
        idle,
        shutdown
      }
    })
  )
