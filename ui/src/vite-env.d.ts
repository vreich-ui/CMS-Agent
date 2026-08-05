/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Absolute URL of the Google Cloud Run MCP service. Cloud Run is the sole control plane: this is
  // the build-time default endpoint, shown pre-filled (and still editable) in the Settings
  // connection panel for local dev or a staging Cloud Run URL.
  readonly VITE_CLOUD_RUN_MCP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
