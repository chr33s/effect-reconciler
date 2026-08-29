import { defineConfig } from "vitest/config"

/** Architectural experiments run explicitly, never as package conformance. */
export default defineConfig({
  test: {
    include: ["experiments/**/*.test.ts"]
  }
})
