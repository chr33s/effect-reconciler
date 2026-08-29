import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Latch from "effect/Latch"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"

/**
 * The Layer + Atom experiment requested by docs/feedback.md.
 *
 * This is deliberately not a second public API. It is one concrete editor DAG
 * and the smallest lifecycle helper found while trying to make current Atom
 * resource semantics satisfy the reconciler's physical-generation invariants.
 * The accompanying report counts and classifies this code.
 */

export interface Model {
  readonly settingsRevision: number
  readonly session: string | null
  readonly workspace: string | null
  readonly language: string
  readonly documents: ReadonlyArray<string>
}

export const emptyModel: Model = {
  settingsRevision: 1,
  session: null,
  workspace: null,
  language: "typescript",
  documents: []
}

export type Family =
  | "Settings"
  | "Session"
  | "Workspace"
  | "Language"
  | "Document"
  | "Diagnostics"

export type Replacement = "sequential" | "overlap"

export interface Desired {
  readonly settingsRevision: number
  readonly session: string | null
  readonly workspace: string | null
  readonly language: string
  readonly documents: ReadonlyArray<string>
}

export interface AtomCounts {
  model: number
  settings: number
  session: number
  workspace: number
  language: number
  documents: number
  desired: number
}

export interface LifecycleEvent {
  readonly type: "start" | "running" | "failed" | "stopping" | "stop"
  readonly family: Family
  readonly key: unknown
  readonly generation: number
}

export interface DiagnosticCapture {
  readonly uri: string
  readonly diagnosticsGeneration: number
  readonly settingsRevision: number
  readonly settingsGeneration: number
  readonly session: string
  readonly sessionGeneration: number
  readonly workspace: string
  readonly workspaceGeneration: number
  readonly language: string
  readonly languageGeneration: number
  readonly documentGeneration: number
}

export class StartupFailed extends Data.TaggedError("LayerAtomStartupFailed")<{
  readonly family: Family
  readonly key: unknown
}> {}

export class LifetimeUnavailable extends Data.TaggedError("LayerAtomLifetimeUnavailable")<{
  readonly family: Family
  readonly key: unknown
}> {}

interface GenerationService {
  readonly generation: number
}

export class Settings extends Context.Service<Settings, GenerationService & {
  readonly revision: number
}>()("experiment/layer-atom/Settings") {}

export class Session extends Context.Service<Session, GenerationService & {
  readonly user: string
}>()("experiment/layer-atom/Session") {}

export class Workspace extends Context.Service<Workspace, GenerationService & {
  readonly id: string
  readonly sessionGeneration: number
}>()("experiment/layer-atom/Workspace") {}

export class Language extends Context.Service<Language, GenerationService & {
  readonly language: string
  readonly workspaceGeneration: number
}>()("experiment/layer-atom/Language") {}

export class Document extends Context.Service<Document, GenerationService & {
  readonly uri: string
  readonly workspaceGeneration: number
}>()("experiment/layer-atom/Document") {}

export class Diagnostics extends Context.Service<Diagnostics, GenerationService & {
  readonly capture: DiagnosticCapture
}>()("experiment/layer-atom/Diagnostics") {}

const label = (family: Family, key: unknown): string => `${family}:${String(key)}`

/** Instrumented Layer constructors. Gates make lifecycle races deterministic. */
export interface Probe {
  readonly events: Array<LifecycleEvent>
  readonly captures: Array<DiagnosticCapture>
  readonly failures: Set<string>
  readonly startGates: Map<string, Deferred.Deferred<void>>
  readonly stopGates: Map<string, Deferred.Deferred<void>>
  readonly fail: (family: Family, key: unknown) => void
  readonly fix: (family: Family, key: unknown) => void
  readonly pauseStart: (family: Family, key: unknown) => Effect.Effect<Deferred.Deferred<void>>
  readonly pauseStop: (family: Family, key: unknown) => Effect.Effect<Deferred.Deferred<void>>
  readonly resumeStart: (family: Family, key: unknown) => Effect.Effect<void>
  readonly resumeStop: (family: Family, key: unknown) => Effect.Effect<void>
}

export const makeProbe = (): Probe => {
  const events: Array<LifecycleEvent> = []
  const captures: Array<DiagnosticCapture> = []
  const failures = new Set<string>()
  const startGates = new Map<string, Deferred.Deferred<void>>()
  const stopGates = new Map<string, Deferred.Deferred<void>>()
  const resume = (
    map: Map<string, Deferred.Deferred<void>>,
    family: Family,
    key: unknown
  ): Effect.Effect<void> => {
    const gate = map.get(label(family, key))
    map.delete(label(family, key))
    return gate === undefined ? Effect.void : Effect.asVoid(Deferred.succeed(gate, void 0))
  }
  return {
    events,
    captures,
    failures,
    startGates,
    stopGates,
    fail: (family, key) => failures.add(label(family, key)),
    fix: (family, key) => failures.delete(label(family, key)),
    pauseStart: (family, key) =>
      Effect.tap(Deferred.make<void>(), (gate) =>
        Effect.sync(() => startGates.set(label(family, key), gate))),
    pauseStop: (family, key) =>
      Effect.tap(Deferred.make<void>(), (gate) =>
        Effect.sync(() => stopGates.set(label(family, key), gate))),
    resumeStart: (family, key) => resume(startGates, family, key),
    resumeStop: (family, key) => resume(stopGates, family, key)
  }
}

interface Layers {
  readonly settings: (key: number, generation: number) => Layer.Layer<Settings, StartupFailed>
  readonly session: (key: string, generation: number) => Layer.Layer<Session, StartupFailed>
  readonly workspace: (
    key: string,
    generation: number
  ) => Layer.Layer<Workspace, StartupFailed, Session>
  readonly language: (
    key: string,
    generation: number
  ) => Layer.Layer<Language, StartupFailed, Workspace>
  readonly document: (
    key: string,
    generation: number
  ) => Layer.Layer<Document, StartupFailed, Workspace>
  readonly diagnostics: (
    key: string,
    generation: number
  ) => Layer.Layer<Diagnostics, StartupFailed, Settings | Session | Workspace | Language | Document>
}

const makeLayers = (probe: Probe): Layers => {
  const acquire = <A, R>(
    family: Family,
    key: unknown,
    generation: number,
    value: Effect.Effect<A, never, R>
  ): Effect.Effect<A, StartupFailed, Scope.Scope | R> =>
    Effect.gen(function* () {
      probe.events.push({ type: "start", family, key, generation })
      const startGate = probe.startGates.get(label(family, key))
      if (startGate !== undefined) yield* Deferred.await(startGate)
      if (probe.failures.has(label(family, key))) {
        return yield* new StartupFailed({ family, key })
      }
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          probe.events.push({ type: "stopping", family, key, generation })
          const stopGate = probe.stopGates.get(label(family, key))
          if (stopGate !== undefined) yield* Deferred.await(stopGate)
          probe.events.push({ type: "stop", family, key, generation })
        }))
      return yield* value
    })

  return {
    settings: (revision, generation) =>
      Layer.effect(
        Settings,
        acquire(
          "Settings",
          revision,
          generation,
          Effect.succeed({ revision, generation })
        )
      ),
    session: (user, generation) =>
      Layer.effect(
        Session,
        acquire("Session", user, generation, Effect.succeed({ user, generation }))
      ),
    workspace: (id, generation) =>
      Layer.effect(
        Workspace,
        acquire(
          "Workspace",
          id,
          generation,
          Effect.map(Session, (session) => ({
            id,
            generation,
            sessionGeneration: session.generation
          }))
        )
      ),
    language: (language, generation) =>
      Layer.effect(
        Language,
        acquire(
          "Language",
          language,
          generation,
          Effect.map(Workspace, (workspace) => ({
            language,
            generation,
            workspaceGeneration: workspace.generation
          }))
        )
      ),
    document: (uri, generation) =>
      Layer.effect(
        Document,
        acquire(
          "Document",
          uri,
          generation,
          Effect.map(Workspace, (workspace) => ({
            uri,
            generation,
            workspaceGeneration: workspace.generation
          }))
        )
      ),
    diagnostics: (uri, generation) =>
      Layer.effect(
        Diagnostics,
        acquire(
          "Diagnostics",
          uri,
          generation,
          Effect.gen(function* () {
            const settings = yield* Settings
            const session = yield* Session
            const workspace = yield* Workspace
            const language = yield* Language
            const document = yield* Document
            const capture: DiagnosticCapture = {
              uri,
              diagnosticsGeneration: generation,
              settingsRevision: settings.revision,
              settingsGeneration: settings.generation,
              session: session.user,
              sessionGeneration: session.generation,
              workspace: workspace.id,
              workspaceGeneration: workspace.generation,
              language: language.language,
              languageGeneration: language.generation,
              documentGeneration: document.generation
            }
            probe.captures.push(capture)
            return { generation, capture }
          })
        )
      )
  }
}

interface Generation {
  readonly generation: number
  readonly family: Family
  readonly key: unknown
  readonly ident: string
  readonly slotId: string
  readonly owner: Generation | null
  readonly providers: ReadonlyArray<Generation>
  readonly scope: Scope.Closeable
  readonly children: Set<Generation>
  readonly contextAtAdmission: Context.Context<never>
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

export interface ExperimentOptions {
  readonly replacement?: Partial<Record<Family, Replacement>>
}

export interface Experiment {
  readonly modelAtom: Atom.Writable<Model>
  readonly desiredAtom: Atom.Atom<Desired>
  readonly atomCounts: AtomCounts
  readonly commit: (model: Model) => Effect.Effect<void>
  readonly idle: Effect.Effect<void>
  readonly retryLanguage: Effect.Effect<void>
  readonly status: (
    family: Family,
    key: unknown
  ) => Effect.Effect<"None" | "Starting" | "Running" | "Failed" | "Stopping">
  readonly runDocument: <A, E>(
    uri: string,
    effect: Effect.Effect<A, E, Session | Workspace | Document>
  ) => Effect.Effect<A, E | LifetimeUnavailable>
  readonly shutdown: Effect.Effect<void>
  readonly registry: AtomRegistry.AtomRegistry
  readonly probe: Probe
  readonly lifecycleHelper: {
    readonly slots: () => number
    readonly generations: () => number
  }
}

const desiredEquality = (a: Desired, b: Desired): boolean => Equal.equals(a, b)

/** Build the editor experiment in the surrounding Scope. */
export const make = (
  probe: Probe = makeProbe(),
  options: ExperimentOptions = {}
): Effect.Effect<Experiment, never, Scope.Scope> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const rootScope = yield* Scope.make()
      const mutex = yield* Semaphore.make(1)
      const serialized = mutex.withPermits(1)
      const wake = yield* Latch.make(false)
      const converged = yield* Latch.make(false)
      const registry = AtomRegistry.make({
        // Deterministic for the experiment: an Atom write publishes all
        // invalidations before commit returns, while lifecycle convergence is
        // still asynchronous.
        scheduleTask: (task) => {
          task()
          return () => {}
        }
      })
      const atomCounts: AtomCounts = {
        model: 0,
        settings: 0,
        session: 0,
        workspace: 0,
        language: 0,
        documents: 0,
        desired: 0
      }
      const modelAtom = Atom.make(emptyModel)
      const settingsAtom = Atom.make((get) => {
        atomCounts.settings++
        return get(modelAtom).settingsRevision
      })
      const sessionAtom = Atom.make((get) => {
        atomCounts.session++
        return get(modelAtom).session
      })
      const workspaceAtom = Atom.make((get) => {
        atomCounts.workspace++
        return get(modelAtom).workspace
      })
      const languageAtom = Atom.make((get) => {
        atomCounts.language++
        return get(modelAtom).language
      })
      const documentsAtom = Atom.make((get) => {
        atomCounts.documents++
        return get(modelAtom).documents
      }).pipe(Atom.withEquality(Equal.equals))
      const desiredAtom = Atom.make((get): Desired => {
        atomCounts.desired++
        const session = get(sessionAtom)
        const workspace = session === null ? null : get(workspaceAtom)
        return {
          settingsRevision: get(settingsAtom),
          session,
          workspace,
          language: get(languageAtom),
          documents: workspace === null ? [] : get(documentsAtom)
        }
      }).pipe(Atom.withEquality(desiredEquality))

      const layers = makeLayers(probe)
      const replacement = (family: Family): Replacement =>
        options.replacement?.[family] ?? "sequential"
      const slots = new Map<string, Slot>()
      const all = new Set<Generation>()
      let nextGeneration = 1
      let open = true
      let desired: Desired = {
        settingsRevision: 1,
        session: null,
        workspace: null,
        language: "typescript",
        documents: []
      }
      let wakeVersion = 0
      let reconciledVersion = 0

      let settings: Generation | undefined
      let session: Generation | undefined
      let workspace: Generation | undefined
      let language: Generation | undefined
      const documents = new Map<string, Generation>()
      const diagnostics = new Map<string, Generation>()

      const wakeUp = (): void => {
        wakeVersion++
        Latch.closeUnsafe(converged)
        Latch.openUnsafe(wake)
      }

      const slotFor = (id: string): Slot => {
        const known = slots.get(id)
        if (known !== undefined) return known
        const slot: Slot = { current: undefined, retiring: new Set() }
        slots.set(id, slot)
        return slot
      }

      const currentFor = (inst: Generation): boolean => slotFor(inst.slotId).current === inst

      const clearCurrent = (inst: Generation): void => {
        switch (inst.family) {
          case "Settings":
            if (settings === inst) settings = undefined
            break
          case "Session":
            if (session === inst) session = undefined
            break
          case "Workspace":
            if (workspace === inst) workspace = undefined
            break
          case "Language":
            if (language === inst) language = undefined
            break
          case "Document":
            if (documents.get(inst.key as string) === inst) documents.delete(inst.key as string)
            break
          case "Diagnostics":
            if (diagnostics.get(inst.key as string) === inst) diagnostics.delete(inst.key as string)
            break
        }
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
                const slot = slotFor(inst.slotId)
                slot.retiring.delete(inst)
                if (slot.current === undefined && slot.retiring.size === 0) slots.delete(inst.slotId)
                wakeUp()
              })
            )
          ),
          Effect.forkIn(rootScope, { uninterruptible: true }),
          Effect.asVoid
        )

      const retire = (inst: Generation): Effect.Effect<void> => {
        if (inst.status === "stopping") return Effect.void
        inst.status = "stopping"
        const slot = slotFor(inst.slotId)
        if (slot.current === inst) slot.current = undefined
        slot.retiring.add(inst)
        clearCurrent(inst)
        return beginStop(inst)
      }

      const canAdmit = (slotId: string, family: Family): boolean => {
        const slot = slots.get(slotId)
        if (slot === undefined) return true
        if (slot.current !== undefined) return false
        return replacement(family) === "overlap" || slot.retiring.size === 0
      }

      const provideLayer = <A, E>(
        layer: Layer.Layer<A, E, any>,
        context: Context.Context<never>
      ): Layer.Layer<A, E> =>
        Layer.provide(
          layer,
          Layer.succeedContext(context) as Layer.Layer<any>
        ) as Layer.Layer<A, E>

      const start = (
        family: Family,
        key: unknown,
        ident: string,
        slotId: string,
        owner: Generation | null,
        providers: ReadonlyArray<Generation>,
        layer: Layer.Layer<any, StartupFailed, any>,
        contextAtAdmission: Context.Context<never>
      ): Effect.Effect<Generation> =>
        Effect.gen(function* () {
          const scope = yield* Scope.fork(owner?.scope ?? rootScope, "sequential")
          const generation = nextGeneration++
          const inst: Generation = {
            generation,
            family,
            key,
            ident,
            slotId,
            owner,
            providers,
            scope,
            children: new Set(),
            contextAtAdmission,
            status: "starting",
            output: Context.empty(),
            childContext: contextAtAdmission,
            failure: null,
            closing: null
          }
          owner?.children.add(inst)
          all.add(inst)
          slotFor(slotId).current = inst
          switch (family) {
            case "Settings": settings = inst; break
            case "Session": session = inst; break
            case "Workspace": workspace = inst; break
            case "Language": language = inst; break
            case "Document": documents.set(key as string, inst); break
            case "Diagnostics": diagnostics.set(key as string, inst); break
          }

          const built = Layer.buildWithScope(
            provideLayer(layer, contextAtAdmission),
            scope
          )
          const fiber = yield* Effect.forkIn(built, scope)
          yield* Effect.forkIn(
            Fiber.await(fiber).pipe(
              Effect.flatMap((exit) =>
                serialized(
                  Effect.suspend(() => {
                    if (!open || inst.status !== "starting" || !currentFor(inst)) {
                      return Effect.void
                    }
                    if (Exit.isSuccess(exit)) {
                      inst.output = exit.value
                      inst.childContext = Context.merge(contextAtAdmission, exit.value)
                      inst.status = "running"
                      probe.events.push({
                        type: "running",
                        family,
                        key,
                        generation
                      })
                      wakeUp()
                      return Effect.void
                    }
                    inst.status = "failed"
                    inst.failure = exit.cause
                    probe.events.push({ type: "failed", family, key, generation })
                    wakeUp()
                    // Failed holds the slot, but partial Layer acquisitions are
                    // finalized now. Retry later joins this boundary.
                    return closeInstance(inst).pipe(
                      Effect.ensuring(Effect.sync(wakeUp)),
                      Effect.forkIn(rootScope, { uninterruptible: true }),
                      Effect.asVoid
                    )
                  })
                )),
              Effect.asVoid
            ),
            rootScope
          )
          return inst
        })

      const running = (inst: Generation | undefined): inst is Generation =>
        inst !== undefined && inst.status === "running"

      const invalidate: Effect.Effect<void> = Effect.gen(function* () {
        if (settings !== undefined && settings.key !== desired.settingsRevision) yield* retire(settings)
        if (session !== undefined && session.key !== desired.session) yield* retire(session)
        if (
          workspace !== undefined &&
          (desired.workspace === null || workspace.key !== desired.workspace || workspace.owner !== session)
        ) yield* retire(workspace)
        if (
          language !== undefined &&
          (language.key !== desired.language || language.owner !== workspace)
        ) yield* retire(language)

        const wanted = new Set(desired.documents)
        for (const [uri, document] of [...documents]) {
          if (!wanted.has(uri) || document.owner !== workspace) yield* retire(document)
        }
        for (const [uri, diagnostic] of [...diagnostics]) {
          const document = documents.get(uri)
          if (
            diagnostic.owner !== document ||
            diagnostic.providers[0] !== settings ||
            diagnostic.providers[1] !== language
          ) yield* retire(diagnostic)
        }
      })

      const admit: Effect.Effect<void> = Effect.gen(function* () {
        if (settings === undefined && canAdmit("Settings", "Settings")) {
          const generation = nextGeneration
          yield* start(
            "Settings",
            desired.settingsRevision,
            `Settings[${desired.settingsRevision}]`,
            "Settings",
            null,
            [],
            layers.settings(desired.settingsRevision, generation),
            Context.empty()
          )
        }
        if (
          desired.session !== null && session === undefined && canAdmit("Session", "Session")
        ) {
          const generation = nextGeneration
          yield* start(
            "Session",
            desired.session,
            `Session[${desired.session}]`,
            "Session",
            null,
            [],
            layers.session(desired.session, generation),
            Context.empty()
          )
        }
        if (
          desired.workspace !== null && running(session) && workspace === undefined
        ) {
          const slotId = `Workspace@${session.ident}`
          if (canAdmit(slotId, "Workspace")) {
            const generation = nextGeneration
            yield* start(
              "Workspace",
              desired.workspace,
              `${slotId}[${desired.workspace}]`,
              slotId,
              session,
              [],
              layers.workspace(desired.workspace, generation),
              session.childContext
            )
          }
        }
        if (running(workspace) && language === undefined) {
          const slotId = `Language@${workspace.ident}`
          if (canAdmit(slotId, "Language")) {
            const generation = nextGeneration
            yield* start(
              "Language",
              desired.language,
              `${slotId}[${desired.language}]`,
              slotId,
              workspace,
              [],
              layers.language(desired.language, generation),
              workspace.childContext
            )
          }
        }
        if (running(workspace)) {
          for (const uri of desired.documents) {
            if (documents.has(uri)) continue
            const slotId = `Document@${workspace.ident}[${uri}]`
            if (!canAdmit(slotId, "Document")) continue
            const generation = nextGeneration
            yield* start(
              "Document",
              uri,
              slotId,
              slotId,
              workspace,
              [],
              layers.document(uri, generation),
              workspace.childContext
            )
          }
        }
        if (running(settings) && running(language)) {
          for (const uri of desired.documents) {
            const document = documents.get(uri)
            if (!running(document) || diagnostics.has(uri)) continue
            const slotId = `Diagnostics@${document.ident}`
            if (!canAdmit(slotId, "Diagnostics")) continue
            const generation = nextGeneration
            const captured = Context.merge(
              document.childContext,
              Context.merge(settings.output, language.output)
            )
            yield* start(
              "Diagnostics",
              uri,
              slotId,
              slotId,
              document,
              [settings, language],
              layers.diagnostics(uri, generation),
              captured
            )
          }
        }
      })

      const isSettled = (): boolean => {
        if (wakeVersion !== reconciledVersion) return false
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
        if (isSettled()) Latch.openUnsafe(converged)
      })

      yield* wake.await.pipe(
        Effect.andThen(wake.close),
        Effect.andThen(serialized(Effect.uninterruptible(pass))),
        Effect.forever,
        Effect.forkIn(rootScope)
      )

      const request = (next: Desired): void => {
        if (!open) return
        desired = next
        wakeUp()
      }
      const unsubscribe = registry.subscribe(desiredAtom, request, { immediate: true })

      const idle: Effect.Effect<void> = Effect.suspend(() =>
        Effect.flatMap(
          serialized(Effect.sync(isSettled)),
          (done) => done ? Effect.void : Effect.andThen(converged.await, idle)
        )
      )

      const status = (family: Family, key: unknown) =>
        serialized(
          Effect.sync((): "None" | "Starting" | "Running" | "Failed" | "Stopping" => {
            const candidates = [...all].filter((inst) => inst.family === family && Equal.equals(inst.key, key))
            const inst = candidates.find((candidate) => candidate.status !== "stopping") ?? candidates[0]
            if (inst === undefined) return "None"
            switch (inst.status) {
              case "starting": return "Starting"
              case "running": return "Running"
              case "failed": return "Failed"
              case "stopping": return "Stopping"
            }
          })
        )

      const retryLanguage = serialized(
        Effect.suspend(() => {
          if (language === undefined || language.status !== "failed") return Effect.void
          return Effect.andThen(retire(language), Effect.sync(wakeUp))
        })
      )

      const runDocument = <A, E>(
        uri: string,
        effect: Effect.Effect<A, E, Session | Workspace | Document>
      ): Effect.Effect<A, E | LifetimeUnavailable> =>
        Effect.flatMap(
          serialized(
            Effect.gen(function* () {
              const inst = documents.get(uri)
              if (!running(inst)) {
                return yield* new LifetimeUnavailable({ family: "Document", key: uri })
              }
              return yield* Effect.forkIn(
                Effect.provide(
                  effect,
                  inst.childContext as unknown as Context.Context<Session | Workspace | Document>
                ),
                inst.scope
              )
            })
          ),
          Fiber.join
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
                registry.dispose()
                all.clear()
                slots.clear()
              })
            )
          )
        })
      )

      yield* Effect.addFinalizer(() => shutdown)

      return {
        modelAtom,
        desiredAtom,
        atomCounts,
        commit: (model) => Effect.sync(() => registry.set(modelAtom, model)),
        idle,
        retryLanguage,
        status,
        runDocument,
        shutdown,
        registry,
        probe,
        lifecycleHelper: {
          slots: () => slots.size,
          generations: () => all.size
        }
      }
    })
  )

/** Read an AsyncResult atom without importing its representation in tests. */
export const asyncTag = <A, E>(result: AsyncResult.AsyncResult<A, E>): string =>
  result.waiting ? `${result._tag}(waiting)` : result._tag
