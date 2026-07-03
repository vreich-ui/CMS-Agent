# CMS-Agent Visual Workspace UI

This directory contains a lightweight local React/Vite interface for viewing and editing CMS-Agent workspace state through the existing workspace MCP endpoint. The UI is intentionally small and replaceable; it is not the source of truth.

## Purpose

The UI helps developers:

- View workspace nodes from `workspace.get_nodes` as a React Flow graph.
- Inspect node prompts and schemas.
- Save prompt edits through `workspace.update_node_prompt`.
- Preview schemas with react-jsonschema-form.
- View and validate `article_body.v1` data through MCP tools.
- Export the current workspace document through `workspace.export_workspace`.

It does not publish content, integrate project-specific MCP servers, or add persistence.

## Local setup

From the repository root, install dependencies:

```bash
npm install --no-fund --no-audit
npm --prefix ui install --no-fund --no-audit
```

Run Netlify dev in one terminal so `/api/mcp` is available:

```bash
npm run dev
```

Run the Vite UI in another terminal:

```bash
npm run ui:dev
```

Build the UI:

```bash
npm run ui:build
```

## MCP endpoint configuration

The UI defaults to `/api/mcp`. During local development, `ui/vite.config.ts` proxies `/api` requests to `http://localhost:8888`, which is the default Netlify dev port. If your Netlify dev server uses another host or port, update the endpoint field in the UI to the full MCP URL, for example `http://localhost:8888/api/mcp`.

## Token handling

Enter the MCP bearer token in the UI token field. It must match `MCP_API_TOKEN` for the Netlify MCP endpoint.

For now, the token is stored only in browser `localStorage` so local development sessions can be refreshed without retyping it. This localStorage behavior is for local/dev use only and should be replaced before using the UI in a shared or production environment. Do not hardcode tokens and do not commit secrets.

## Source of truth

The workspace MCP server is the source of truth. The UI only reads and mutates workspace state by calling MCP methods/tools exposed by `/api/mcp`.
