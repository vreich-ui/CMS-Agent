#!/usr/bin/env bash
# Generate fresh LibreChat encryption/search secrets in .env format.
# These are unique per deployment — never reuse the values from the docs.
#
# Usage:
#   ./scripts/gen-secrets.sh            # print to stdout
#   ./scripts/gen-secrets.sh >> .env    # append into your .env (review afterwards)
set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required but not found on PATH." >&2
  exit 1
fi

cat <<EOF
# --- generated $(date -u +%Y-%m-%dT%H:%M:%SZ) — keep secret, never commit ---
CREDS_KEY=$(openssl rand -hex 32)
CREDS_IV=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
MEILI_MASTER_KEY=$(openssl rand -base64 32)
EOF

echo
echo "# Paste the five lines above into .env (replacing any existing values)." >&2
echo "# CREDS_KEY=64 hex chars, CREDS_IV=32 hex chars, JWT secrets=64 hex chars." >&2
