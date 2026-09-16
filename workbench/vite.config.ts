import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// W7 — THE PERSISTED-CACHE BUSTER, which had no value behind it.
//
// App.tsx persists the query cache to localStorage for 24 hours and passes
// `buster: import.meta.env.VITE_BUILD_ID ?? 'dev'`, on the stated guarantee that "a deploy that
// changes an adapter's output shape cannot restore data shaped for the previous one". Nothing
// anywhere defined VITE_BUILD_ID — not this file, not an .env, not CI — so the buster was the
// literal string 'dev' in every build and that guarantee was false: a returning operator would
// paint from up-to-24-hour-old storage in the PREVIOUS shape. Defined here so every build has one
// without anyone having to remember to export it.
//
// The commit sha when there is one (the deploy identity that actually tracks a shape change), and a
// build timestamp when there is not — never a constant, because a constant is what the bug was.
const buildId = (() => {
  if (process.env.VITE_BUILD_ID) return process.env.VITE_BUILD_ID
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return `build_${Date.now()}`
  }
})()

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
  define: {
    // Read by App.tsx as the persisted-cache buster; see the note above.
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(buildId),
  },
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
