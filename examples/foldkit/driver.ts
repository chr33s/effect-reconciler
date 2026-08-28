/**
 * A headless stand-in for the parts of the Foldkit runtime this comparison
 * needs: the Message loop, Commands, Managed Resources and Subscriptions.
 *
 * The Foldkit runtime itself mounts into a DOM document, and the view layer is
 * irrelevant to what Phases 4 and 5 measure — application *coordination* code.
 * So the two app modules are written as real Foldkit values (`Update.Return`,
 * `Command`, `ManagedResource.make`, `Subscription.make`) and this driver runs
 * them the way the framework documents:
 *
 * - after every update the Managed Resource requirements are recomputed and
 *   structurally compared: `none → some` acquires, `some → none` releases,
 *   `some(a) → some(b)` releases then re-acquires, and a failed acquire
 *   dispatches `onAcquireError` rather than crashing;
 * - subscription dependencies are recomputed the same way, and any change
 *   tears the Stream down and restarts it;
 * - Commands run as forked Effects whose result Message is dispatched back.
 *
 * It is deliberately dumb: no batching, no interruption keys, no view. Both
 * versions of the app run on exactly this driver, so the comparison between
 * them is unaffected by what it leaves out.
 */
import { Context, Effect, Exit, Fiber, Option, Ref, Scope, Stream } from "effect"
import type { ManagedResource, Subscription, Update } from "foldkit"

export interface App<Model, Message, R = never> {
  readonly init: Model
  readonly update: (model: Model, message: Message) => Update.Return<Model, Message, R>
  readonly managedResources?: ManagedResource.ManagedResources<Model, Message>
  readonly subscriptions?: Subscription.Subscriptions<Model, Message, R>
  /** Runs after every committed Model. The Reconciler commits from here. */
  readonly onCommitted?: (model: Model) => Effect.Effect<void, never, R>
}

export interface Session<Model, Message> {
  readonly dispatch: (message: Message) => Effect.Effect<void>
  readonly model: () => Model
  /** Completes once no command, acquisition or release is still in flight. */
  readonly settled: Effect.Effect<void>
}

/** Structural comparison of requirement/dependency values, as the framework
 * does through their schemas. */
const normalize = (value: unknown): unknown => {
  if (Option.isOption(value)) {
    return Option.isSome(value) ? { _some: normalize(value.value) } : { _none: true }
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.keys(record)
      .sort()
      .map((key) => [key, normalize(record[key])])
  }
  return value
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))

interface ResourceState {
  requirements: unknown
  value: unknown
  scope: Scope.Closeable
}

/**
 * The Context a Managed Resource contributes to Commands, which is what makes
 * `Resource.get` work inside them. The framework's service is a
 * `Ref<Option<Value>>`, empty while the resource is not acquired.
 */
const resourceContext = (
  entries: Iterable<readonly [ManagedResource.ManagedResource<any, any>, Ref.Ref<Option.Option<unknown>>]>
): Context.Context<never> => {
  let context = Context.empty()
  for (const [resource, ref] of entries) {
    context = Context.add(context, (resource as { readonly _tag: any })._tag, ref)
  }
  return context as Context.Context<never>
}

/** Services this driver supplies itself, so callers need not provide them. */
type Provided = ManagedResource.ManagedResourceService<any>

export const start = <Model, Message, R>(
  app: App<Model, Message, R>
): Effect.Effect<Session<Model, Message>, never, Exclude<R, Provided> | Scope.Scope> =>
  Effect.gen(function* () {
    const runtimeScope = yield* Effect.scope
    const context = (yield* Effect.context<Exclude<R, Provided>>()) as Context.Context<R>

    let model = app.init
    let inFlight = 0

    const resources = new Map<string, ResourceState>()
    const resourceValues = new Map<
      string,
      readonly [ManagedResource.ManagedResource<any, any>, Ref.Ref<Option.Option<unknown>>]
    >()

    /** The holder a Command reads through `Resource.get`. */
    const holderFor = (
      name: string,
      resource: ManagedResource.ManagedResource<any, any>
    ): Ref.Ref<Option.Option<unknown>> => {
      const existing = resourceValues.get(name)
      if (existing !== undefined) return existing[1]
      const ref = Ref.makeUnsafe<Option.Option<unknown>>(Option.none())
      resourceValues.set(name, [resource, ref])
      return ref
    }
    const acquiring = new Set<string>()
    // A failed acquire is not retried until the requirements change, as the
    // framework documents.
    const failed = new Map<string, unknown>()
    const subscriptions = new Map<string, { dependencies: unknown; fiber: Fiber.Fiber<void> }>()

    const track = <A, E>(effect: Effect.Effect<A, E, R>): Effect.Effect<void> =>
      Effect.gen(function* () {
        inFlight++
        yield* Effect.forkIn(
          Effect.ensuring(
            Effect.provide(Effect.interruptible(Effect.orDie(effect)), context),
            Effect.sync(() => {
              inFlight--
            })
          ),
          runtimeScope
        )
      })

    const syncResources: Effect.Effect<void> = Effect.gen(function* () {
      for (const [name, entry] of Object.entries(app.managedResources ?? {})) {
        if (acquiring.has(name)) continue
        const required = entry.modelToMaybeRequirements(model)
        const state = resources.get(name)
        const wanted = Option.isOption(required)
          ? (Option.isSome(required) ? Option.some(required.value) : Option.none())
          : Option.some(required)

        if (Option.isNone(wanted)) {
          // Desire withdrawn: a later request is a fresh attempt, not the
          // retry of a failure that is being suppressed.
          failed.delete(name)
          if (state === undefined) continue
          resources.delete(name)
          yield* Ref.set(holderFor(name, entry.resource), Option.none())
          yield* track(
            Effect.gen(function* () {
              yield* entry.release(state.value)
              yield* Scope.close(state.scope, Exit.void)
              yield* dispatch(entry.onReleased())
            }) as Effect.Effect<void, never, R>
          )
          continue
        }

        if (state !== undefined && same(state.requirements, wanted.value)) continue
        const lastFailure = failed.get(name)
        if (state === undefined && lastFailure !== undefined && same(lastFailure, wanted.value)) {
          continue
        }

        if (state !== undefined) {
          resources.delete(name)
          yield* Ref.set(holderFor(name, entry.resource), Option.none())
          yield* track(
            Effect.gen(function* () {
              yield* entry.release(state.value)
              yield* Scope.close(state.scope, Exit.void)
              yield* dispatch(entry.onReleased())
            }) as Effect.Effect<void, never, R>
          )
        }

        acquiring.add(name)
        const params = wanted.value
        yield* track(
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            const acquired = yield* Effect.result(
              Scope.provide(entry.acquire(params), scope) as Effect.Effect<unknown, unknown, R>
            )
            acquiring.delete(name)
            if (acquired._tag === "Failure") {
              failed.set(name, params)
              yield* Scope.close(scope, Exit.void)
              yield* dispatch(entry.onAcquireError(acquired.failure))
              return
            }
            failed.delete(name)
            resources.set(name, { requirements: params, value: acquired.success, scope })
            yield* Ref.set(holderFor(name, entry.resource), Option.some(acquired.success))
            yield* dispatch(entry.onAcquired(acquired.success))
          }) as Effect.Effect<void, never, R>
        )
      }
    })

    const syncSubscriptions: Effect.Effect<void> = Effect.gen(function* () {
      for (const [name, entry] of Object.entries(app.subscriptions ?? {})) {
        const dependencies = entry.modelToDependencies(model)
        const running = subscriptions.get(name)
        if (running !== undefined && same(running.dependencies, dependencies)) continue
        if (running !== undefined) yield* Fiber.interrupt(running.fiber)
        const stream = entry.dependenciesToStream(dependencies, () =>
          entry.modelToDependencies(model)
        )
        const fiber = yield* Effect.forkIn(
          Effect.provide(
            Effect.interruptible(
              Stream.runForEach(stream, (message: Message) => dispatch(message))
            ),
            context
          ),
          runtimeScope
        )
        subscriptions.set(name, { dependencies, fiber })
      }
    })

    const dispatch = (message: Message): Effect.Effect<void> =>
      Effect.gen(function* () {
        const result = app.update(model, message)
        model = result.model
        for (const command of result.commands ?? []) {
          // Commands run with the services of every currently acquired
          // Managed Resource, as they do under the real runtime.
          yield* track(
            Effect.provide(
              Effect.flatMap(command.effect as Effect.Effect<Message, never, R>, dispatch),
              resourceContext(resourceValues.values())
            ) as Effect.Effect<void, never, R>
          )
        }
        if (app.onCommitted !== undefined) {
          yield* Effect.provide(app.onCommitted(model), context)
        }
        yield* syncResources
        yield* syncSubscriptions
      })

    const settled: Effect.Effect<void> = Effect.suspend(() =>
      inFlight === 0 && acquiring.size === 0
        ? Effect.void
        : Effect.andThen(Effect.sleep(1), settled)
    )

    // Commit the initial Model, as the runtime does after `init`.
    if (app.onCommitted !== undefined) yield* Effect.provide(app.onCommitted(model), context)
    yield* syncResources
    yield* syncSubscriptions

    return { dispatch, model: () => model, settled }
  })
