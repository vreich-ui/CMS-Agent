import { defineConfig } from "vitest/config";

// Root suite: node-environment tests under tests/ only. The ui workspace has its own vitest
// (jsdom + Testing Library, ui/vitest.config.ts) run via `npm run test:ui` — its .tsx tests must
// not be collected here, where no DOM environment exists.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["ui/**", "node_modules/**"]
  }
});
