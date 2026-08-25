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
})
