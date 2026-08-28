import { defineConfig } from "vitest/config"

// The scale benchmark is a separate run: it builds up to 10,000 lifetimes and
// takes far longer than the conformance suite, which `npm test` must stay
// fast enough to run continuously.
export default defineConfig({
  test: {
    include: ["bench/**/*.bench.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: "forks"
  }
})
