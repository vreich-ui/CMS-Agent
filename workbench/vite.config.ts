import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Local dev and the future Cloud Run deploy serve this app at the origin
  // root, so `base` stays '/' there by default. The Netlify build (see
  // netlify.toml) is the one deploy that mounts this app under a path
  // prefix — `/workbench/` — on a site whose root already serves a
  // different app (ui/dist); it sets WORKBENCH_BASE=/workbench/ so every
  // emitted asset URL (and the public/ files Vite rewrites at build time,
  // e.g. favicon.svg) resolves under that prefix instead of the root.
  base: process.env.WORKBENCH_BASE ?? '/',
  // U5 dev note: sibling git worktrees (other tracks building concurrently)
  // each run their own `vite` dev server, and Vite's default port (5173)
  // silently drifts to the next free one on a collision — which then no
  // longer matches playwright.config.ts's hardcoded port/baseURL, so the
  // Playwright suite ends up testing WHATEVER already happens to be
  // listening on 5173 (a different worktree's build) instead of this one.
  // Pinned to a dedicated port + strictPort so a collision fails loudly
  // instead of silently testing the wrong app. Keep this in sync with
  // playwright.config.ts's `port`/`baseURL`.
  server: {
    port: 5183,
    strictPort: true,
  },
})
