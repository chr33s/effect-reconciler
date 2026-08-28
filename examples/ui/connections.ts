/**
 * The fixture every UI example drives: a control plane that opens connections.
 *
 * It is deliberately UI-shaped rather than editor-shaped. A component needs
 * exactly the three things this exercises — commit state, render a lifetime's
 * status, and retry one that failed — and connections fail often enough in
 * real applications that `Failed` is not a hypothetical branch.
 */
import { Context, Effect, Option } from "effect"
import * as Reconciler from "../../src/Reconciler.js"

export class ConnectionService extends Context.Service<
  ConnectionService,
  { readonly host: string }
>()("example/Connection") {}

/** What the example app's state looks like: the hosts the user wants open. */
export interface AppState {
  readonly hosts: ReadonlyArray<string>
}

export interface Behaviour {
  /** Hosts whose startup fails, so the example can show `Failed` and retry. */
  readonly failing: Set<string>
  /** Hosts whose startup blocks, so the example can show `Starting`. */
  readonly blocking: Map<string, Effect.Effect<void>>
  readonly opened: Array<string>
  readonly closed: Array<string>
}

export const makeBehaviour = (): Behaviour => ({
  failing: new Set(),
  blocking: new Map(),
  opened: [],
  closed: []
})

export class ConnectionFailed extends Error {
  constructor(readonly host: string) {
    super(`connection to ${host} failed`)
  }
}

export const defineConnections = (behaviour: Behaviour) =>
  Reconciler.define((define) => {
    const Connection = define.many("Connection", {
      start: (host: string) =>
        Effect.gen(function* () {
          const gate = behaviour.blocking.get(host)
          if (gate !== undefined) yield* gate
          if (behaviour.failing.has(host)) return yield* Effect.fail(new ConnectionFailed(host))
          behaviour.opened.push(host)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              behaviour.closed.push(host)
            })
          )
          return Context.make(ConnectionService, { host })
        })
    })
    return { Connection }
  })

export type Connections = ReturnType<typeof defineConnections>

export const bindConnections = (definition: Connections) =>
  definition.bind<AppState>((bind) => ({
    connections: bind.many(definition.Connection, (state) => state.hosts)
  }))

/** The semantic reference a component renders the status of. */
export const connectionRef = (definition: Connections, host: string) =>
  Reconciler.ref(definition.Connection, host, null)

export const emptyState: AppState = { hosts: [] }

export const withHosts = (...hosts: ReadonlyArray<string>): AppState => ({ hosts })

export const someOf = Option.some
