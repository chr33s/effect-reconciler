# React, Solid and Lit

A UI framework is a control plane, and a Controller already takes one: commit
immutable state, converge resources, read status. So "support" here is not a
renderer — it is an adapter that does three things a component needs, and
nothing else:

1. commit the application's state as desired state,
2. render a lifetime's status reactively,
3. retry one that failed.

Everything framework-independent lives in [`mirror.ts`](mirror.ts). The
[React](react.tsx), [Solid](solid.ts) and [Lit](lit.ts) files on top of it are
thin on purpose: what is worth testing is in the mirror, and what is left is
what only goes wrong inside a particular framework.

Three adapters is one more than is needed to make the point, and that is the
point: the mirror did not change to accommodate any of them. Each framework
contributes exactly one hazard of its own — React's StrictMode remount, Solid
2.0's owned-scope write rule, Lit's disconnect-then-reconnect — and each is
handled in its own file.

## Why there is a mirror at all

Both frameworks need a **synchronous** read. React calls `getSnapshot` during
render; a Solid signal is read the same way. `Controller.status` is an Effect
that takes the controller's mutex, so it cannot answer during a render. The
mirror keeps the answer cached and refreshes it in the background.

Two facts make that cheap, and both are load-bearing:

**A `LifetimeRef` is already a valid Effect key.** Two independently built
references to the same lifetime are `Equal` and hash identically, and the hash
is cached on the object — 100,000 hashes of a two-deep reference take 1.9 ms.
So the cache is an ordinary `MutableHashMap` keyed by the reference itself. A
component builds its reference inline on every render, no memoization, and no
UI-specific identity type has to exist.

**A status read returns the same object while nothing has changed.**
`Option.some({ _tag: "Running" })` allocates a fresh value every call, and a
`getSnapshot` that never settles re-renders forever. The mirror replaces a
cached status only when `Equal.equals` says it differs. `mirror.test.ts`
asserts this directly, because it is the failure that is hardest to read from a
stack trace.

Two smaller decisions worth knowing:

- **The mirror never calls `Effect.runFork`.** Every interaction with the
  Controller happens on the one fiber the mirror owns; a UI event handler only
  writes a cell and opens a latch. That is synchronous, safe to call from any
  handler, and means the adapter imposes no runtime on the host application.
- **Commits coalesce.** A UI produces state faster than resources converge, so
  `commit` records the latest state rather than queueing every one. Committing
  A then B is indistinguishable from committing B alone — desire is a function
  of the latest state, which is why the runtime coalesces reconcile passes for
  the same reason.

## What this example changed in the kernel

This adapter was written first, against a runtime with no change notification
at all. `Controller.failures` reported failures only, nothing reported
`Starting → Running`, and so the mirror **polled** — 25 ms while something was
converging, 250 ms once nothing watched was in transition. That was good
enough to build a UI against, which is why the example existed before the
kernel change did: it is what showed that `Controller.changes` was worth
adding.

It is now in the kernel (§9.5) and the poll loop is gone. The mirror re-reads
when a pass says it moved something, and at no other time — `mirror.test.ts`
asserts exactly that by counting `status` reads across a 400 ms idle window
and finding none.

Three things the signal was designed around, all visible in the mirror:

- **It carries no payload**, so it crosses no line the specification draws
  around internal vocabulary: a subscriber still re-reads through `status`,
  which stays the sole authority. There is nothing to trust, and so nothing to
  get wrong by trusting it.
- **A subscription is prompted once.** An observer has to subscribe and take
  its first reading in some order, and a transition landing between the two
  would be lost either way round. The runtime replays the last prompt to a
  late subscriber, so `Stream.runForEach(controller.changes, …)` is all the
  mirror needs — no ordering care, no initial-read window.
- **It replaced the failure subscription too.** A failed startup is a
  transition like any other, so the mirror no longer watches `failures` at
  all; watching both would mean flushing twice for one event.

What it deliberately does not do is promise *when* convergence happens. A
payload-free "re-read now" edge says something moved, never how long anything
took.

## React

```tsx
// Created once, outside React. A component that owned the Controller would
// tear down and restart every lifetime on StrictMode's remount.
const { controller, mirror } = await Effect.runPromise(/* ... scoped ... */)

const Connection = ({ host }: { host: string }) => {
  const tag = useLifetimeTag(connectionRef(definition, host))
  const retry = useRetry()
  return (
    <li>
      {host}: {tag}
      {tag === "Failed" && (
        <button onClick={() => retry(connectionRef(definition, host))}>retry</button>
      )}
    </li>
  )
}

const App = ({ hosts }: { hosts: ReadonlyArray<string> }) => {
  useCommitState({ hosts })          // commit from an effect, never in render
  return <ul>{hosts.map((h) => <Connection key={h} host={h} />)}</ul>
}

root.render(<MirrorProvider mirror={mirror}><App hosts={hosts} /></MirrorProvider>)
```

Three hazards the hooks are built around:

- **Do not own the Controller in a component.** StrictMode's mount → unmount →
  remount would restart every lifetime, and so would every Fast Refresh.
- **Commit from an effect.** `useCommitState` runs after the commit phase.
- **StrictMode's double invocation is free.** Committing semantically equal
  state is *exactly* zero churn — nothing started, stopped or touched.
  `react.test.tsx` asserts it: the app renders twice under `StrictMode`, and
  the connection is opened once and closed never.

## Solid

Materially simpler, and for reasons worth naming: no StrictMode
double-invocation, no concurrent rendering and so no tearing, and a fine-grained
graph where a status change re-runs the one computation that read it rather
than a component body.

```ts
commitState(mirror, () => ({ hosts: hosts() }))
const tag = createLifetimeTag(mirror, () => connectionRef(definition, host()))
// `tag` is a signal; a compiled component interpolates it like any other.
```

The reference argument is an accessor, so a component can follow a *changing*
lifetime without rebuilding the primitive — `solid.test.ts` switches hosts and
watches the old lifetime close and the new one open. Watching is tied to the
owning computation, so disposing a root stops the mirror re-reading what
nothing renders.

### Written against Solid 2.0

The API a component sees is unchanged from the 1.x version of these bindings,
but three 2.0 changes reshaped what is behind it, and all three made the
adapter smaller rather than larger:

- **`createEffect` is a compute/apply split**, `(compute, apply)`. The compute
  phase tracks and names the dependency; the apply phase is untracked and does
  the work. That is what `on(dep, fn)` meant in 1.x, so the `on` helper is gone
  and its job is now the first argument.
- **The apply phase returns its own cleanup**, run before the next apply and on
  disposal. Unwatching is that return value, so `onCleanup` — which 2.0 narrows
  to cleanup tied to a reactive run — is not needed here.
- **A write from inside an owned scope is refused** unless the signal opts in.
  The status signal is created *and* written by the primitive that owns it,
  which is exactly what `{ ownedWrite: true }` is the narrow opt-in for; the
  default refuses the write the effect makes on its very first run.

One behaviour a caller has to know: **a write is visible to a read only after
the queue flushes** — the next microtask, or `flush()`. A component never
notices, because its own reads happen after the flush that scheduled them; a
test does, which is why `solid.test.ts` calls `flush()` on both sides of the
controller's work. The first flush runs the effects that register the watches
and commit the state, the second makes the statuses the mirror's listeners
wrote readable.

## Lit

Lit gives an adapter two places to stand, and both are in [`lit.ts`](lit.ts)
because they answer different questions.

A **reactive controller** attaches to an element and asks it to re-render when
a status changes. That is what an element that *branches* on status wants:

```ts
class ConnectionPanel extends LitElement {
  connectedCallback() {
    this.status = new LifetimeStatusController(this, mirror, () =>
      connectionRef(definition, this.hostName))
    new CommitStateController(this, mirror, () => ({ hosts: this.hosts }))
    super.connectedCallback()
  }

  render() {
    const tag = this.status.tag
    return html`
      <span>${this.hostName}: ${tag}</span>
      ${tag === "Failed" ? html`<button @click=${() => this.status.retry()}>retry</button>` : null}
    `
  }
}
```

An **async directive** subscribes from inside one binding and writes to it
alone. That is what a status that is merely a value on screen wants — the
element's `render` is not called at all:

```ts
html`<span>${lifetimeTag(mirror, connectionRef(definition, host))}</span>`
```

Like Solid's accessor, the controller's reference is a *function*, re-read
before every render, so an element follows a changing property without the
controller being rebuilt. Neither needs a context: a controller is constructed
by the element and simply handed the mirror. `MirrorProvider` exists on the
React side only because a hook cannot take a constructor argument.

Two rules the file is built around:

- **Disconnection is not disposal.** Moving an element in the DOM disconnects
  and reconnects it, and Lit does not re-render on reconnect — so a
  subscription dropped in `hostDisconnected` has to be restored in
  `hostConnected`, and a directive's in `reconnected`. Nothing in the rendered
  DOM can tell you whether it was: the element still says "Running" either way.
  `lit.test.ts` asserts against the *mirror* for exactly that reason, and each
  half is tested by an element that uses only that half — put both in one
  element and they mask each other's failures.
- **A render must not have side effects.** Watching happens in `hostConnected`
  and `hostUpdate`, committing in `hostUpdated` — before and after `render`,
  never inside it. Same rule as React's "commit from an effect", same reason:
  a render that changes the world is a render that cannot be repeated.

## Running the tests

```
npm test               # includes examples/ui
```

One environment note. Solid publishes a `node` export condition that resolves to
its **SSR build, where the reactive primitives are inert stubs** — in 2.0 that
build calls `createEffect` with its apply phase discarded, so under Node's
default resolution the effects here never run and these tests would pass while
testing nothing. The root `vitest.config.ts` corrects the resolution and inlines
`solid-js` so the correction applies. A browser application resolves the real
build on its own; the test runner is the anomaly.

Lit needs nothing beyond the `jsdom` environment — custom elements, shadow DOM
and `updateComplete` all work there. `lit.ts` uses `static properties` rather
than decorators, so there is no build step and no `experimentalDecorators` to
turn on for a file that only wants to be read.

## What is still unsolved

A component usually wants to *use* what a lifetime published — the connection,
not just its status — and there is still no way to reach a lifetime's services
from outside one. The migration in `examples/foldkit-migration` hit the same
wall and worked around it with a holder `Ref`, and an adapter could ship that
as a helper without touching the Controller API.

Be honest about the cost before doing so: a component can hold a service whose
generation has been retired, which is exactly why the kernel does not expose
one. Until that has an answer, the rule these adapters follow is: **render off
`status`, act through `commit` and `retry`.**
