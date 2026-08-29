# DevTools

There is a version of "DevTools" that is a browser extension. This is not it,
and the difference is the interesting part.

What a panel actually needs from a runtime is three things, and all three are
on the Controller:

| question | what answers it |
| :--- | :--- |
| what exists, right now, coherently | `controller.snapshot` |
| why did that happen | `controller.events` |
| how much has happened | `controller.diagnostics` |

[`panel.ts`](panel.ts) is the assembly: a view model kept up to date from
those three, and a `render` that turns it into text. That is about 150 lines,
and none of it is privileged — an application could have written all of it,
which is the claim this example exists to make.

```
lifetimes  4 total · 3 running · 0 starting · 1 failed · 0 stopping
totals     1 commits · 3 passes · 4 admitted · 3 started · 1 failed · 0 stopped · 0 retries
selectors  8 evaluated
state      settled

Settings:1  Running
Doc:a.ts  Running
  └─ Analyzer:null  Running
Doc:bad.ts  Failed — StartupFailed: unreadable

recent
  commit · 4 desired
  admit  · Settings:1
  start  · Settings:1
  admit  · Doc:a.ts
  FAIL   · Doc:bad.ts
  retire · Doc:a.ts (provider)
```

## The one rule

**The tree comes from `snapshot`. The reasons come from `events`.**

Events are lossy — bounded buffer, nothing retained without a subscriber,
nothing delivered before the subscription exists. A panel that built its tree
from them would slowly diverge from the runtime and would have no way of
finding out. So the tree is re-read whole, and events only ever fill in the
*why* column beside it.

That column is the reason to have a panel at all. `status` will tell you a
lifetime is Running; it cannot tell you that it restarted a moment ago because
a provider three levels up was replaced. In the render above, the application
changed one number — a settings revision — and three lifetimes moved for three
different reasons, none of which is written anywhere in the application:

```
retire · Settings:1 (desire)      the application changed this
retire · Doc:a.ts   (provider)    it captured Settings at admission
retire · Analyzer:null (owner)    its owner went, so it went
```

## It costs nothing while nothing is happening

The panel subscribes to `changes` and re-reads on notice. A panel open on a
screen for an hour with a quiet runtime does no work at all — `panel.test.ts`
asserts exactly that by counting `snapshot` reads across an idle window and
finding none.

Events are only *constructed* once something is subscribed to `events`, so a
Controller in production with no panel attached does not pay to build the
`LifetimeRef` of every transition either.

## Making it a real panel

`render` returning a string is what makes the example testable — the tests
assert on the text a person would read — and what makes it printable in a
terminal. A panel in React, Lit or a browser extension is the same view model
with a different renderer: `Panel.make(controller)` unchanged, `panel.model()`
read in a component, and `same()` to skip a repaint. See
[`examples/ui`](../ui/README.md) for the synchronous-read machinery a
framework needs, which applies here without modification.

## Running the tests

```
npm test        # includes examples/devtools
```
