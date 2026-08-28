/**
 * React bindings over the mirror.
 *
 * Three rules the hooks are built around, each of which is a real hazard
 * rather than a style preference:
 *
 * - **The Controller is not owned by a component.** It is created once, next
 *   to the application's own runtime, and handed to the provider. A component
 *   that owned it would tear down and restart *every lifetime* on React 19's
 *   StrictMode remount, and again on any Fast Refresh.
 *
 * - **Commit from an effect, never during render.** `useCommitState` runs
 *   after the commit phase. StrictMode's double invocation is free here:
 *   committing semantically equal state is exactly zero churn — no lifetime is
 *   started, stopped or even touched — which `examples/ui/react.test.tsx`
 *   asserts directly.
 *
 * - **A lifetime reference is stable by value, not by identity.** Components
 *   build references inline, so `useLifetimeStatus` keeps the previous object
 *   while `Equal.equals` holds. That keeps `useSyncExternalStore` from
 *   resubscribing on every render without asking callers to memoize.
 */
import { Equal } from "effect"
import type { Option } from "effect"
import * as React from "react"
import type { LifetimeRef } from "../../src/LifetimeRef.js"
import type { LifetimeStatus } from "../../src/Status.js"
import type { Mirror, StatusMirror } from "./mirror.js"

// `Mirror<State>` is contravariant in `State`, so `Mirror<never>` is the type
// every mirror widens to — the provider needs no cast, and neither do the
// hooks that only read status.
const MirrorContext = React.createContext<Mirror<never> | null>(null)

export const MirrorProvider = <State,>(
  props: { readonly mirror: Mirror<State>; readonly children: React.ReactNode }
): React.ReactElement =>
  React.createElement(MirrorContext.Provider, { value: props.mirror }, props.children)

export const useMirror = (): StatusMirror => {
  const mirror = React.useContext(MirrorContext)
  if (mirror === null) throw new Error("useMirror: no <MirrorProvider> above this component")
  return mirror
}

/** The previous reference while it is still semantically the same lifetime. */
const useStableRef = (ref: LifetimeRef): LifetimeRef => {
  const box = React.useRef(ref)
  if (!Equal.equals(box.current, ref)) box.current = ref
  return box.current
}

/**
 * The runtime's current answer for one lifetime. `None` means no physical
 * generation exists — not desired, not yet admitted, or superseded — and is
 * also what a lifetime reads for the first tick after it comes on screen.
 */
export const useLifetimeStatus = (ref: LifetimeRef): Option.Option<LifetimeStatus> => {
  const mirror = useMirror()
  const stable = useStableRef(ref)
  const subscribe = React.useCallback(
    (onChange: () => void) => mirror.watch(stable, onChange),
    [mirror, stable]
  )
  const read = React.useCallback(() => mirror.statusOf(stable), [mirror, stable])
  return React.useSyncExternalStore(subscribe, read, read)
}

/** The status tag as a plain string, for components that only branch on it. */
export const useLifetimeTag = (ref: LifetimeRef): LifetimeStatus["_tag"] | "None" => {
  const status = useLifetimeStatus(ref)
  return status._tag === "None" ? "None" : status.value._tag
}

/** Publish this state as the desired state whenever it changes. */
export const useCommitState = <State,>(state: State): void => {
  // The one place the state type has to be recovered: a React context cannot
  // be generic, and the provider stored the mirror at its widest type.
  const mirror = useMirror() as Mirror<State>
  React.useEffect(() => {
    mirror.commit(state)
  }, [mirror, state])
}

export const useRetry = (): ((ref: LifetimeRef) => void) => {
  const mirror = useMirror()
  return React.useCallback((ref: LifetimeRef) => mirror.retry(ref), [mirror])
}
