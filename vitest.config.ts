import { configDefaults, defineConfig } from "vitest/config"

// Solid publishes a `node` export condition that resolves to its SSR build,
// where the reactive primitives are inert stubs — under Node's default
// resolution `createEffect` would silently never run and the Solid example's
// tests would pass while testing nothing. A browser application resolves the
// real build; the test runner is the anomaly, so it is corrected here.
//
// `solid-js` is inlined rather than externalized so that these conditions
// apply to it at all: an externalized dependency is loaded by Node's own
// resolver, which knows nothing about Vite's conditions.
//
// None of this can affect the rest of the suite: `effect` publishes a single
// export with no conditions.
export default defineConfig({
  resolve: {
    conditions: ["browser", "development"]
  },
  ssr: {
    resolve: {
      conditions: ["browser", "development"],
      externalConditions: ["browser", "development"]
    }
  },
  test: {
    // Package conformance and publish verification must not be made flaky by
    // architectural experiments. Experiments have their own explicit script
    // and CI job, while `npm test` / prepack stay on the supported package.
    exclude: [...configDefaults.exclude, "experiments/**"],
    server: { deps: { inline: ["solid-js"] } }
  }
})
