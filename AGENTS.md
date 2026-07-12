# AGENTS.md

## Read this first

Reread `PRODUCT_VISION.md` (repo root) before every working session. It is
the anchor for all product and design decisions: attention over information
density, the graph as one view of an organization (not the product), the
four-layer attention hierarchy, progressive disclosure, evidence-based
explainability, and attribution-first history. Where any other document or
earlier plan disagrees with it, the vision wins. Detailed UI specs live in
`docs/constellation/`.

## Project goal

Build a Netlify-hosted TypeScript agent runtime for content creation and publishing workflows using the OpenAI Agents SDK.

The runtime must support:
- One reusable base agent.
- Multiple project profiles selected by projectId.
- Project-specific instructions, workflows, skills, MCP servers, memory namespaces, and publishing targets.
- MCP communication through Streamable HTTP first.
- Local SDK tools for deterministic project operations.
- Future observability, learning loops, and JSON memory exchange.
- Ignore folders: Other and DrLurieBlog.

## Architecture rules

- Keep Netlify function handlers thin.
- Put orchestration logic in `src/agent/runtime`.
- Put project configuration in `src/agent/projects`.
- Put reusable local capabilities in `src/agent/skills`.
- Put workflow definitions in `src/agent/workflows`.
- Put MCP setup in `src/agent/mcp`.
- Put memory exchange types and adapters in `src/agent/memory`.
- Put logging/tracing adapters in `src/agent/observability`.

## Runtime rules

- Use TypeScript.
- Use `.mts` for Netlify function files.
- Do not hardcode secrets.
- Read secrets from `process.env`.
- Default all publishing actions to dry-run unless explicitly told otherwise.
- Add Zod validation for request bodies and tool parameters.
- Return structured JSON from API endpoints.
- Keep publishing adapters replaceable.

## Testing rules

- Add unit tests for:
  - project registry
  - request validation
  - memory envelope validation
  - skill registry filtering
  - dry-run publishing behavior

## Safety rules

- Never publish content unless `dryRun` is false.
- Never expose raw API keys or authorization headers in logs.
- Tool calls that mutate external systems must be explicit and auditable.
