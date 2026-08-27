# Track A Runbook — Conductor Workbench, one Cloud Run service behind IAP

**Status:** written for a human operator to execute. The agent that wrote this (Track A, Pass 2
consolidation) has no `gcloud` in its environment and never ran any command below — every command
is copy-pasteable but unverified against a live project. Read a step fully before running it.

**Owner of this document:** `docs/plan/**` (Track A). Does not modify `workbench/**` or
`src/agent/**`.

**What this gets you:** Wolf opens one HTTPS URL. Google IAP gates access to his account only. The
page it serves is the Conductor Workbench SPA, served by `workbench-broker`, which holds the MCP
bearer token server-side (Secret Manager) and talks to the existing MCP Cloud Run service on
Wolf's behalf. He never sees or pastes a bearer token again.

---

## 0. Before you start

- `gcloud` installed and authenticated as a user with the roles in §1.
- The project id and region the existing MCP service runs in. From the live endpoint named in the
  Track A brief, `https://cms-agent-mcp-937996366809.us-central1.run.app/mcp`, the region is
  `us-central1` and `937996366809` is the **project number** (not the project id — look the id up
  with `gcloud projects list --filter="projectNumber:937996366809"` if you don't already have it
  memorized).
- The bearer token Wolf currently pastes into the UI by hand. You'll copy this value (not
  regenerate it) into a new Secret Manager secret in §2 — the workbench-broker starts using the
  *same* credential the browser used, just no longer typed in by hand.

Set these once, in the shell you'll run every command below in:

```bash
export PROJECT="<your-project-id>"          # e.g. cms-agent-503015 — NOT the project number
export REGION="us-central1"
export REPO="cms-agent"                     # existing Artifact Registry repo (cloudbuild.mcp.yaml uses the same one)
export SERVICE="conductor-workbench"        # new Cloud Run service name for this image
export RUNTIME_SA="conductor-workbench-runtime@${PROJECT}.iam.gserviceaccount.com"
export MCP_URL="https://cms-agent-mcp-937996366809.us-central1.run.app/mcp"  # confirm this hasn't moved
```

---

## 1. IAM — grant these roles once, up front

To the **person running this runbook** (your own `gcloud auth list` account), on the project:

| Role | Why |
|---|---|
| `roles/run.admin` | create/update the Cloud Run service |
| `roles/iam.serviceAccountUser` | deploy a service that runs as `$RUNTIME_SA` |
| `roles/iam.serviceAccountAdmin` | create `$RUNTIME_SA` itself (§1a) |
| `roles/artifactregistry.writer` | push the built image |
| `roles/cloudbuild.builds.editor` | run `gcloud builds submit` |
| `roles/secretmanager.admin` | create the three secrets in §2 |
| `roles/iap.admin` | enable IAP and manage its access list (§6-§7) |

```bash
export ME="$(gcloud config get-value account)"
for ROLE in roles/run.admin roles/iam.serviceAccountUser roles/iam.serviceAccountAdmin \
            roles/artifactregistry.writer roles/cloudbuild.builds.editor \
            roles/secretmanager.admin roles/iap.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="user:${ME}" --role="$ROLE"
done
```

### 1a. Create a dedicated runtime service account

A dedicated SA (rather than the default compute SA) keeps Secret Manager grants scoped to exactly
the three secrets this service needs — nothing else on the project.

```bash
gcloud iam service-accounts create conductor-workbench-runtime \
  --project="$PROJECT" \
  --display-name="Conductor Workbench broker (Track A) runtime identity"
```

---

## 2. Secret Manager — create the three secrets

**a. `SESSION_SECRET`** (HMAC key for the broker's own session cookie — needed even under
`AUTH_MODE=iap`, since the password-login code path still exists):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > /tmp/session-secret.txt
gcloud secrets create workbench-broker-session-secret --project="$PROJECT" --data-file=/tmp/session-secret.txt
shred -u /tmp/session-secret.txt 2>/dev/null || rm -f /tmp/session-secret.txt
```

**b. `OPERATOR_PASSWORD_HASH`** (scrypt hash of a password — this is the `AUTH_MODE=password`
fallback login, not the IAP path Wolf will actually use day to day; still required by config.ts's
fail-fast validation):

```bash
cd workbench-broker
npm install --no-audit --no-fund   # only if you haven't already
npm run hash -- '<pick a real password here>' | tail -1 > /tmp/pw-hash.txt
cd ..
gcloud secrets create workbench-broker-password-hash --project="$PROJECT" --data-file=/tmp/pw-hash.txt
shred -u /tmp/pw-hash.txt 2>/dev/null || rm -f /tmp/pw-hash.txt
```

**c. The MCP bearer token itself** — paste the exact value Wolf has been pasting into the UI.
Typing it interactively (not as a `gcloud` argument, which would land in shell history) is safer:

```bash
gcloud secrets create workbench-broker-mcp-token --project="$PROJECT" --data-file=- <<< "$(read -rsp 'Paste the MCP bearer token, then Enter: ' TOKEN; echo "$TOKEN")"
```

If your shell doesn't like that one-liner, do it in two steps instead — just make sure the token
never ends up in a file you forget to delete or a `history` entry:

```bash
read -rsp 'Paste the MCP bearer token, then Enter: ' TOKEN; echo
printf '%s' "$TOKEN" | gcloud secrets create workbench-broker-mcp-token --project="$PROJECT" --data-file=-
unset TOKEN
```

Record the secret's resource name — this exact string is what `CMS_AGENT_MCP_TOKEN_SECRET` gets
set to in §5 (it's a **pointer**, safe to put in a plain env var; the broker resolves the actual
value itself at startup via Secret Manager — see `workbench-broker/src/secrets.ts`):

```bash
export MCP_TOKEN_SECRET_REF="projects/${PROJECT}/secrets/workbench-broker-mcp-token/versions/latest"
```

### Grant the runtime service account access to all three

```bash
for SECRET in workbench-broker-session-secret workbench-broker-password-hash workbench-broker-mcp-token; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --project="$PROJECT" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

---

## 3. Build

```bash
cd /path/to/cms-agent   # repo root — the one with Dockerfile.workbench in it
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/conductor-workbench:$(git rev-parse --short HEAD)"
gcloud builds submit --project "$PROJECT" --config cloudbuild.workbench.yaml --substitutions _IMAGE="$IMAGE" .
```

Watch the build log for the line `startup guard ok: workbench broker graph loads` (Dockerfile.workbench's
build-time guard, same pattern as `Dockerfile.mcp`) — if the build fails there instead of at `npm run
build`, the compiled output can't even load and the error will name why, right there in the log.

---

## 4. Deploy

```bash
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$RUNTIME_SA" \
  --port 8080 \
  --min-instances=1 \
  --max-instances=4 \
  --cpu 1 --memory 512Mi \
  --no-allow-unauthenticated \
  --set-env-vars "AUTH_MODE=iap,READ_ONLY=0,STATIC_ROOT=public,CACHE_TTL_MS=20000,CMS_AGENT_MCP_URL=${MCP_URL},CMS_AGENT_MCP_TOKEN_SECRET=${MCP_TOKEN_SECRET_REF}" \
  --set-secrets "SESSION_SECRET=workbench-broker-session-secret:latest,OPERATOR_PASSWORD_HASH=workbench-broker-password-hash:latest"
```

Notes on the flags actually chosen here, since they diverge from the broker's own safe defaults —
each is a deliberate operator decision, not an oversight:

- **`READ_ONLY=0`** — Wolf has explicitly decided to exit read-only (see the Track A brief). The
  broker's own code still defaults `READ_ONLY` **on** if this were ever omitted or misconfigured;
  this flag is the recorded decision to turn it off for this deployment.
- **`AUTH_MODE=iap`** — this is already the broker's own default; listed explicitly here so this
  command is a complete, self-describing record of the deployed config, not because it's required.
- **`--no-allow-unauthenticated`** — Cloud Run's own IAM-based auth stays OFF at this layer (IAP is
  the gate, configured in §6); this flag just means "don't also let the raw Cloud Run URL be
  reachable with no auth at all" while IAP is being wired up. Once IAP is enabled (§6), it sits in
  front of this and is the thing Wolf's browser actually talks to.
- **`--min-instances=1`** — keeps one instance warm so the persistent MCP session
  (`McpClient.ensureSession()`) doesn't cold-start on Wolf's first request of the day; this is the
  whole reason the broker exists instead of the browser talking to Cloud Run directly.
- **No `IAP_AUDIENCE` yet** — you don't know its value until IAP is enabled in §6, which names a
  resource you don't have until this deploy exists. §6 ends with the `--update-env-vars` call that
  fills this in.

---

## 5. Sanity-check the deploy before touching IAP

```bash
export RAW_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format 'value(status.latestReadyRevisionName)'

# This call needs your own identity token, since --no-allow-unauthenticated is set and IAP isn't
# wired up yet — Cloud Run's own IAM auth is the only gate at this point.
curl -fsS -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$RAW_URL/api/health"
```

Expect `{"ok":true,"mcp":{"reachable":true,"workspaceVersion":"2025-06-18"}}`. If `reachable` is
`false`, the token in `workbench-broker-mcp-token` is wrong or expired, or `CMS_AGENT_MCP_URL` is
stale — fix the secret/env var and `gcloud run services update "$SERVICE" ...` before continuing.

---

## 6. Enable IAP

**6a. Turn on the API and finish the OAuth consent screen** (one-time per project, skip if already done):

```bash
gcloud services enable iap.googleapis.com --project="$PROJECT"
```

If this project has never configured an OAuth consent screen, Google Cloud Console will prompt for
it the first time you try to enable IAP below — do that in Console
(`APIs & Services → OAuth consent screen`) before continuing; there's no clean `gcloud` one-liner
for first-time consent-screen setup.

**6b. Turn on IAP for this Cloud Run service.** Google added native IAP support directly on Cloud
Run (no separate load balancer needed) — **verify the exact command against your `gcloud` version
before running it**, since this is a comparatively recent feature and the flag name has moved
before:

```bash
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --iap
```

If that flag isn't recognized (`gcloud components update` first, then retry), use Console instead:
**Cloud Run → `$SERVICE` → Security tab → enable "Identity-Aware Proxy"**. Either path lands in the
same place — confirm it by checking the service's Security tab shows IAP as **On** before moving
on.

---

## 7. Allowlist Wolf's Google account

```bash
export WOLF_ACCOUNT="wolf@<his-actual-domain>"   # fill in the real address
gcloud iap web add-iam-policy-binding \
  --project="$PROJECT" --resource-type=cloud-run --service="$SERVICE" --region="$REGION" \
  --member="user:${WOLF_ACCOUNT}" --role="roles/iap.httpsResourceAccessor"
```

If `gcloud iap web add-iam-policy-binding` doesn't recognize `--resource-type=cloud-run` on your
version, do it from Console instead: **Security → Identity-Aware Proxy → find `$SERVICE` in the
list → Add Principal → `$WOLF_ACCOUNT` → role "IAP-secured Web App User"**.

Do **not** grant this role to `allUsers` or `allAuthenticatedUsers` — this is a single-operator
tool; the allowlist should have exactly one member (plus yourself, temporarily, for verification —
remove yourself once Wolf confirms access if you're not meant to be a permanent operator).

---

## 8. Fill in `IAP_AUDIENCE`

`src/iap.ts` verifies the JWT's `aud` claim against this value when it's set — leaving it unset
still verifies the signature, issuer, and expiry (real security), it just skips pinning to this
specific IAP resource. Set it for real once IAP is live:

```bash
# The audience is documented as being of the form
# /projects/<PROJECT_NUMBER>/global/backendServices/<ID> (classic LB-fronted IAP) or an
# equivalent Cloud-Run-native resource identifier for the native integration in §6b — the exact
# string for your service is shown in Console under Security → Identity-Aware Proxy → (the row for
# $SERVICE) → the JWT audience is usually visible via "..." → IAM policy details, or by decoding a
# live request's X-Goog-IAP-JWT-Assertion header once during verification (§9) and reading its
# `aud` claim directly — that is the ground truth if the Console value is ambiguous.
export IAP_AUDIENCE="<paste the value you found>"
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --update-env-vars "IAP_AUDIENCE=${IAP_AUDIENCE}"
```

---

## 9. Verify end-to-end

1. **As Wolf** (or from a browser signed into `$WOLF_ACCOUNT`): open the Cloud Run URL (or the
   mapped domain from §10). Expect Google's IAP sign-in interstitial once, then the Conductor
   Workbench SPA loads with no login screen of its own.
2. Confirm no credential prompt appears anywhere in the app — `GET /api/session` (open devtools →
   Network) should show `{"authenticated":true,"operator":"wolf@...","readOnly":false,...}`.
3. Confirm a mutating action actually works (`READ_ONLY=0` took effect) — e.g. start a dry run from
   the UI, or:
   ```bash
   curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
     -H "Cookie: <copy the cw_session cookie from a real browser session if testing AUTH_MODE=password locally>" \
     "$RAW_URL/api/bootstrap" | head -c 400
   ```
4. **As someone NOT on the allowlist** (a second Google account, or an incognito window signed into
   a different account): confirm IAP itself blocks the request before it ever reaches the broker —
   you should see Google's "You don't have access" page, not this app's own 401.
5. **Off-IAP reachability check** — confirm the raw Cloud Run URL is not separately reachable
   without IAP: `curl -fsS "$RAW_URL/api/health"` with **no** `Authorization` header should fail
   (IAP-protected Cloud Run services still require the IAP-issued header/cookie even for direct
   hits, once §6 is on).

---

## 10. Map the domain (optional, once verified)

```bash
gcloud run domain-mappings create --project "$PROJECT" --region "$REGION" \
  --service "$SERVICE" --domain "<your-chosen-domain>"
```

Add the DNS records `gcloud` prints back at your domain's DNS provider. IAP continues to gate the
service once traffic reaches it via the mapped domain — no separate IAP configuration needed for
the domain itself, but re-run the IAP_AUDIENCE check in §8 once the domain resolves, since some IAP
resource identifiers change when a Load-Balancer-fronted setup is introduced instead of the native
Cloud Run integration; skip this note entirely if §6b's native `--iap` flag worked.

---

## Rollback

**Fast, partial rollback — kill mutations without redeploying:**

```bash
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --update-env-vars "READ_ONLY=1"
```

**Full rollback — return traffic to the previous revision:**

```bash
gcloud run revisions list --project "$PROJECT" --region "$REGION" --service "$SERVICE"
gcloud run services update-traffic "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --to-revisions="<PREVIOUS_REVISION_NAME>=100"
```

**Full retreat — take Wolf back to the old flow (direct Cloud Run + pasted token) while you fix
Track A:** point him back at `$MCP_URL` directly (the same endpoint the old UI used) and re-paste
the token — this is exactly what he's used before, so it's always the safety net as long as the MCP
Cloud Run service itself is untouched (Track A never modifies it). Do **not** delete anything named
in `docs/plan/RETIREMENT.md` until this rollback path is confirmed unnecessary.

**If IAP itself is the problem** (e.g. Wolf is locked out): disable IAP from Console (Security tab
→ toggle off) or `gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION"
--no-iap` (verify flag name per §6b's own caveat), then re-add `--allow-unauthenticated` temporarily
if you need Wolf back in immediately while you debug — remember to remove that once IAP is fixed;
an `--allow-unauthenticated` Cloud Run service with a live MCP token behind it is exactly the
exposure Track A exists to close.

---

## Parity checklist — run before Netlify is deleted

Do not delete anything in `docs/plan/RETIREMENT.md` until every row here is checked against the
**live Track A deployment**, not a local build:

- [ ] Wolf can open the URL, sign in via Google once, and see the Library screen with no MCP
      credential prompt anywhere.
- [ ] `GET /api/session` reports `authenticated:true` with `operator` equal to Wolf's real email —
      confirm this is the **IAP-verified** value (check it changes correctly if you test with a
      second allowlisted account) not a hardcoded string.
- [ ] `GET /api/bootstrap` returns 200 with `workflows`, `graphs`, `nodeSummaries`, `recentRuns`
      all populated; `attention` may legitimately be `null` with `errors.attention` set (known
      upstream `constellation_get_attention` failure — see `workbench/contracts/README.md`
      Finding #4) — confirm that's the *only* null key, not a symptom of something else broken.
- [ ] At least one read verb and one mutating verb both succeed end-to-end from the real UI (not
      just curl) with `READ_ONLY=0`.
- [ ] A batched call (whatever UI action triggers one, or a manual `POST /api/mcp` with `calls:
      [...]`) returns per-item results with one HTTP round trip visible in Network tab.
- [ ] Reloading the browser tab does **not** re-prompt for any credential — this is the entire
      point of Track A; if it does, something is still reading a token from browser-side storage.
- [ ] The raw Cloud Run URL is unreachable without IAP (step 9.5 above) — re-run this check once
      more, right before deleting Netlify, in case a config drifted since first verification.
- [ ] The old Netlify workbench site (`docs/plan/RETIREMENT.md` row 1) has had zero real traffic
      for at least 48h after Wolf confirms he's using the new URL exclusively — check Netlify's own
      analytics/logs, not just "I stopped using it."
- [ ] Wolf has explicitly said, in words, that he's ready for the old site to go — per
      `docs/plan/RETIREMENT.md`, sign-off is required, not inferred from silence.
