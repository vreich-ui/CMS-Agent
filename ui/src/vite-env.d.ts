/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Absolute URL of the Google Cloud Run MCP service (DIRECTION.md Phase 4b). When set at build
  // time, the Settings connection panel shows a "Control plane: Netlify | Cloud Run" switch; when
  // absent, the UI is Netlify-only exactly as before.
  readonly VITE_CLOUD_RUN_MCP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
