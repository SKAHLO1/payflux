import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // Chain-backed tests hit live Coston2 and are opt-in via PAYFLUX_E2E=1.
    testTimeout: 30_000,
  },
})
