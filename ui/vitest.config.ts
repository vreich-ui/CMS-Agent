import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Component tests live in ui/tests (outside tsconfig include:["src"]) so `tsc --noEmit &&
// vite build` never typechecks them; vitest discovers them via this include glob.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    globals: false,
    css: false
  }
});
