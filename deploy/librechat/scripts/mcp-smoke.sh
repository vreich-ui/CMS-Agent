#!/usr/bin/env bash
# CLI verification of the three MCP endpoints, independent of the LibreChat UI.
# For each server it performs the streamable-HTTP handshake (initialize ->
# notifications/initialized -> tools/list) using the SAME url + auth header that
# librechat.yaml uses, and prints the tool count and names.
#
# Use it to answer the deliverable's "per-MCP-server tool counts" and to satisfy
# the STOP CONDITION check ("an MCP server exposes zero tools" => stop & report)
# BEFORE trusting the Agent Builder.
#
# Usage:
#   set -a; source .env; set +a     # load CMS_AGENT_KEY, PROMOTER_*, MONETIZER_KEY
#   ./scripts/mcp-smoke.sh
set -euo pipefail

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "$bin is required" >&2; exit 1; }
done

# Extract the JSON-RPC body whether the server replied as plain JSON or SSE frames.
_body_json() {
  # Reads raw response on stdin; emits the last `data:` payload, or the body as-is.
  if grep -q '^data:' <<<"$1"; then
    grep '^data:' <<<"$1" | sed 's/^data: //' | tail -n1
  else
    echo "$1"
  fi
}

probe() {
  local name="$1" url="$2" hdr_name="$3" hdr_val="$4"
  echo "── ${name} ──────────────────────────────────────────────"
  if [[ -z "$url" || -z "$hdr_val" ]]; then
    echo "  SKIPPED: url or auth value not set in .env"; echo; return 0
  fi

  local acc="application/json, text/event-stream"
  local init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-smoke","version":"1.0"}}}'

  # 1) initialize — capture Mcp-Session-Id from the response headers.
  local hdrs; hdrs="$(mktemp)"
  local init_resp
  init_resp="$(curl -sS -D "$hdrs" -X POST "$url" \
    -H "Content-Type: application/json" -H "Accept: ${acc}" \
    -H "${hdr_name}: ${hdr_val}" --data "$init")" || {
      echo "  FAIL: initialize request errored"; rm -f "$hdrs"; echo; return 1; }

  local sid
  sid="$(grep -i '^mcp-session-id:' "$hdrs" | tr -d '\r' | awk '{print $2}')"
  rm -f "$hdrs"
  if grep -q '"error"' <<<"$(_body_json "$init_resp")"; then
    echo "  FAIL: initialize returned an error:"; _body_json "$init_resp" | jq -c '.error' 2>/dev/null || echo "$init_resp"
    echo; return 1
  fi

  local sid_hdr=(); [[ -n "$sid" ]] && sid_hdr=(-H "Mcp-Session-Id: ${sid}")

  # 2) notifications/initialized (best-effort; some servers require it).
  curl -sS -X POST "$url" -H "Content-Type: application/json" -H "Accept: ${acc}" \
    -H "${hdr_name}: ${hdr_val}" "${sid_hdr[@]}" \
    --data '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null || true

  # 3) tools/list
  local list_resp
  list_resp="$(curl -sS -X POST "$url" -H "Content-Type: application/json" -H "Accept: ${acc}" \
    -H "${hdr_name}: ${hdr_val}" "${sid_hdr[@]}" \
    --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')" || {
      echo "  FAIL: tools/list request errored"; echo; return 1; }

  local json; json="$(_body_json "$list_resp")"
  local count; count="$(jq -r '.result.tools | length' <<<"$json" 2>/dev/null || echo "?")"
  if [[ "$count" == "0" || "$count" == "?" ]]; then
    echo "  ⚠️  tool count = ${count}  (STOP CONDITION if 0 — investigate before proceeding)"
    jq -c '.' <<<"$json" 2>/dev/null | head -c 400; echo
  else
    echo "  ✅ ${count} tools:"
    jq -r '.result.tools[].name' <<<"$json" | sed 's/^/     - /'
  fi
  echo
}

probe "cms-agent-gcloud" "https://cms-agent-mcp-itbzhq23nq-uc.a.run.app/mcp" "Authorization" "Bearer ${CMS_AGENT_KEY:-}"
probe "promoter"         "${PROMOTER_MCP_URL:-}"                              "X-Promoter-Key" "${PROMOTER_KEY:-}"
probe "monetizer"        "https://monetizer-99287560712.europe-west1.run.app/mcp" "Authorization" "Bearer ${MONETIZER_KEY:-}"

echo "Done. Each server should list a non-zero tool set. cms-agent-gcloud must expose"
echo "workspace/node/skill/improvement tools (100+ in the full catalog)."
