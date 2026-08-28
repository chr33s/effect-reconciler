/**
 * The two versions of the feature behind one interface, so the same scripted
 * user story can be run against both and compared on what it did to the
 * backend.
 */
import { Effect, type Scope } from "effect"
import * as After from "./after/app.js"
import type { BackendApi, BackendControl, Diagnostic } from "./backend.js"
import * as Before from "./before/app.js"
import type { Session } from "./driver.js"

export interface Actions {
  readonly signIn: (user: string) => Effect.Effect<void>
  readonly signOut: Effect.Effect<void>
  readonly openWorkspace: (workspace: string) => Effect.Effect<void>
  readonly closeWorkspace: Effect.Effect<void>
  readonly changeLanguage: (language: string) => Effect.Effect<void>
  readonly changeSettings: (revision: number) => Effect.Effect<void>
  readonly openDocument: (uri: string) => Effect.Effect<void>
  readonly closeDocument: (uri: string) => Effect.Effect<void>
  /** The user presses "Retry" on the unavailable-server banner. */
  readonly pressRetry: Effect.Effect<void>
  /** Dispatch without waiting for the application to settle. */
  readonly fire: {
    readonly changeLanguage: (language: string) => Effect.Effect<void>
    readonly changeSettings: (revision: number) => Effect.Effect<void>
    readonly openDocument: (uri: string) => Effect.Effect<void>
    readonly closeDocument: (uri: string) => Effect.Effect<void>
  }
  readonly settle: Effect.Effect<void>
  /** What the user would see. */
  readonly diagnostics: () => ReadonlyArray<Diagnostic>
  readonly serverUnavailable: () => boolean
}

export interface Subject {
  readonly name: string
  readonly start: (
    backend: BackendApi,
    control: BackendControl
  ) => Effect.Effect<Actions, never, Scope.Scope>
}

/** The Model fields the tests read, which both versions keep. */
interface Observable {
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly serverUnavailable: boolean
}

/** The Messages the tests send, which both versions declare. */
interface Constructors<Message> {
  readonly SignedIn: (fields: { readonly user: string }) => Message
  readonly SignedOut: () => Message
  readonly OpenedWorkspace: (fields: { readonly workspace: string }) => Message
  readonly ClosedWorkspace: () => Message
  readonly ChangedLanguage: (fields: { readonly language: string }) => Message
  readonly ChangedSettings: (fields: { readonly revision: number }) => Message
  readonly OpenedDocument: (fields: { readonly uri: string }) => Message
  readonly ClosedDocument: (fields: { readonly uri: string }) => Message
  readonly PressedRetry: () => Message
}

/**
 * Both versions converge asynchronously and neither exposes a convergence
 * barrier to its application, so the tests wait the way an application would:
 * until the backend stops changing.
 */
const quiet = (control: BackendControl): Effect.Effect<void> => {
  const loop = (previous: number, stable: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      const size = control.events.length
      if (size === previous && stable >= 3) return Effect.void
      return Effect.andThen(Effect.sleep(2), loop(size, size === previous ? stable + 1 : 0))
    })
  return loop(-1, 0)
}

const actions = <Message>(
  session: Session<Observable, Message>,
  control: BackendControl,
  Message: Constructors<Message>
): Actions => {
  const settle = Effect.andThen(session.settled, quiet(control))
  const fire = (message: Message) => session.dispatch(message)
  const send = (message: Message) => Effect.andThen(fire(message), settle)
  return {
    signIn: (user) => send(Message.SignedIn({ user })),
    signOut: send(Message.SignedOut()),
    openWorkspace: (workspace) => send(Message.OpenedWorkspace({ workspace })),
    closeWorkspace: send(Message.ClosedWorkspace()),
    changeLanguage: (language) => send(Message.ChangedLanguage({ language })),
    changeSettings: (revision) => send(Message.ChangedSettings({ revision })),
    openDocument: (uri) => send(Message.OpenedDocument({ uri })),
    closeDocument: (uri) => send(Message.ClosedDocument({ uri })),
    pressRetry: send(Message.PressedRetry()),
    fire: {
      changeLanguage: (language) => fire(Message.ChangedLanguage({ language })),
      changeSettings: (revision) => fire(Message.ChangedSettings({ revision })),
      openDocument: (uri) => fire(Message.OpenedDocument({ uri })),
      closeDocument: (uri) => fire(Message.ClosedDocument({ uri }))
    },
    settle,
    diagnostics: () => session.model().diagnostics,
    serverUnavailable: () => session.model().serverUnavailable
  }
}

export const beforeSubject: Subject = {
  name: "before (application-coordinated)",
  start: (backend, control) =>
    Effect.map(Before.start(backend), (session) => actions(session, control, Before.Message))
}

export const afterSubject: Subject = {
  name: "after (reconciler-coordinated)",
  start: (backend, control) =>
    Effect.map(After.start(backend), (session) => actions(session, control, After.Message))
}

export const subjects: ReadonlyArray<Subject> = [beforeSubject, afterSubject]
