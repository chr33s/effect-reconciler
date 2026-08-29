import * as Effect from "effect/Effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import {
  Document,
  emptyModel,
  makeLayers,
  makeProbe,
  type Family as EditorFamily,
  type Model,
  type Probe,
  Session,
  Workspace
} from "../editor.js"
import * as Kernel from "./kernel.js"

export interface RebasedEditor {
  readonly model: Atom.Writable<Model>
  readonly desired: Atom.Atom<ReadonlyArray<Kernel.DesiredNode>>
  readonly kernel: Kernel.Kernel
  readonly families: Readonly<Record<EditorFamily, Kernel.Family<any>>>
  readonly commit: (model: Model) => Effect.Effect<void>
  readonly idle: Effect.Effect<void>
  readonly status: (family: EditorFamily, key: unknown) => Effect.Effect<Kernel.Status["_tag"]>
  readonly retryLanguage: Effect.Effect<void>
  readonly runDocument: <A, E>(
    uri: string,
    effect: Effect.Effect<A, E, Session | Workspace | Document>
  ) => Effect.Effect<A, E | Kernel.LifetimeUnavailable>
  readonly shutdown: Effect.Effect<void>
  readonly probe: Probe
  readonly refs: (model: Model) => {
    readonly settings: Kernel.Ref<number>
    readonly session: Kernel.Ref<string> | null
    readonly workspace: Kernel.Ref<string> | null
    readonly language: Kernel.Ref<string> | null
    readonly documents: ReadonlyMap<string, Kernel.Ref<string>>
    readonly diagnostics: ReadonlyMap<string, Kernel.Ref<string>>
  }
}

export const make = (
  probe: Probe = makeProbe(),
  options?: { readonly sessionReplacement?: Kernel.Replacement }
): Effect.Effect<RebasedEditor, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        task()
        return () => {}
      }
    })
    // Registered before Kernel.make, so the kernel shuts its generations down
    // before this externally supplied registry is disposed.
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()))

    const layers = makeLayers(probe)
    const families = {
      Settings: Kernel.family<number>({
        name: "Settings",
        cardinality: "one",
        layer: layers.settings
      }),
      Session: Kernel.family<string>({
        name: "Session",
        cardinality: "one",
        replacement: options?.sessionReplacement,
        layer: layers.session
      }),
      Workspace: Kernel.family<string>({
        name: "Workspace",
        cardinality: "one",
        layer: layers.workspace
      }),
      Language: Kernel.family<string>({
        name: "Language",
        cardinality: "one",
        layer: layers.language
      }),
      Document: Kernel.family<string>({
        name: "Document",
        cardinality: "many",
        layer: layers.document
      }),
      Diagnostics: Kernel.family<string>({
        name: "Diagnostics",
        cardinality: "one",
        layer: layers.diagnostics
      })
    } as const

    // Atom owns desire; the kernel's RefCache interns owner-relative semantic
    // identities while retaining Effect Equal / Hash behavior for keys.
    const refCache = Kernel.makeRefCache()
    const refs = (state: Model) => {
      const settings = refCache.get(families.Settings, state.settingsRevision, null)
      const session = state.session === null ? null : refCache.get(families.Session, state.session, null)
      const workspace = session === null || state.workspace === null
        ? null
        : refCache.get(families.Workspace, state.workspace, session)
      const language = workspace === null
        ? null
        : refCache.get(families.Language, state.language, workspace)
      const documents = new Map<string, Kernel.Ref<string>>()
      const diagnostics = new Map<string, Kernel.Ref<string>>()
      if (workspace !== null) {
        for (const uri of state.documents) {
          const document = refCache.get(families.Document, uri, workspace)
          documents.set(uri, document)
          diagnostics.set(uri, refCache.get(families.Diagnostics, uri, document))
        }
      }
      return { settings, session, workspace, language, documents, diagnostics }
    }

    const model = Atom.make(emptyModel)
    const desired = Atom.make((get): ReadonlyArray<Kernel.DesiredNode> => {
      const current = get(model)
      const identities = refs(current)
      const nodes: Array<Kernel.DesiredNode> = [{ ref: identities.settings }]
      if (identities.session === null) return nodes
      nodes.push({ ref: identities.session })
      if (identities.workspace === null) return nodes
      nodes.push({ ref: identities.workspace })
      if (identities.language === null) return nodes
      nodes.push({ ref: identities.language })
      for (const document of identities.documents.values()) nodes.push({ ref: document })
      for (const [uri, diagnostic] of identities.diagnostics) {
        nodes.push({
          ref: diagnostic,
          providers: [identities.settings, identities.language]
        })
        // The map lookup is also a runtime assertion that every Diagnostics
        // owner was emitted in the preceding topological group.
        if (!identities.documents.has(uri)) throw new Error(`missing Document for ${uri}`)
      }
      return nodes
    }).pipe(Atom.withEquality<ReadonlyArray<Kernel.DesiredNode>>((left, right) =>
      left.length === right.length && left.every((node, index) => {
        const other = right[index]!
        if (node.ref !== other.ref) return false
        const providers = node.providers ?? []
        const otherProviders = other.providers ?? []
        return providers.length === otherProviders.length &&
          providers.every((provider, providerIndex) => provider === otherProviders[providerIndex])
      })))

    const kernel = yield* Kernel.make(desired, { registry })

    const currentRef = (family: EditorFamily, key: unknown): Kernel.Ref | null => {
      const current = refs(registry.get(model))
      switch (family) {
        case "Settings": return refCache.get(families.Settings, key as number, null)
        case "Session": return refCache.get(families.Session, key as string, null)
        case "Workspace":
          return current.session === null
            ? null
            : refCache.get(families.Workspace, key as string, current.session)
        case "Language":
          return current.workspace === null
            ? null
            : refCache.get(families.Language, key as string, current.workspace)
        case "Document": return current.documents.get(key as string) ?? null
        case "Diagnostics": return current.diagnostics.get(key as string) ?? null
      }
    }

    const status = (family: EditorFamily, key: unknown): Effect.Effect<Kernel.Status["_tag"]> =>
      Effect.sync(() => {
        const identity = currentRef(family, key)
        return identity === null ? "None" : registry.get(kernel.status(identity))._tag
      })

    const retryLanguage = Effect.suspend(() => {
      const identity = refs(registry.get(model)).language
      return identity === null ? Effect.void : kernel.retry(identity)
    })

    const runDocument = <A, E>(
      uri: string,
      effect: Effect.Effect<A, E, Session | Workspace | Document>
    ) => {
      const identity = refs(registry.get(model)).documents.get(uri)
      return identity === undefined
        ? Effect.fail(new Kernel.LifetimeUnavailable(Kernel.ref(families.Document, uri, null)))
        : kernel.run(identity, effect)
    }

    return {
      model,
      desired,
      kernel,
      families,
      commit: (state) => Effect.sync(() => registry.set(model, state)),
      idle: kernel.idle,
      status,
      retryLanguage,
      runDocument,
      shutdown: kernel.shutdown,
      probe,
      refs
    }
  })
