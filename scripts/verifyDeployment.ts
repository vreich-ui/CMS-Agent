// Post-deploy verification for the Cloud Run MCP service.
//
// WHY THIS EXISTS
//
// Two facts got confused repeatedly, at real cost:
//
//   "merged"   — a commit is on main.
//   "deployed" — the revision serving traffic contains that commit.
//
// Since 2026-07-31 the `cms-agent-mcp-deploy` trigger closes that gap on every push to main
// (cloudbuild.deploy.yaml verifies the serving image itself); this script remains the manual,
// endpoint-level check — build-log-independent proof. Historically: on 2026-07-27 a revision serving
// PRE-R-3 code was mistaken for the merged one for hours, while `repository.get_health` stayed green
// the whole time — because workspace state lives in GCS and is INDEPENDENT of the revision. Health
// checks cannot detect a stale deploy, and nothing else was looking.
//
// The same deploy also silently dropped six environment variables (see the `--set-env-vars` warning in
// docs/platform/PHASE4_RUNBOOK.md), taking every client connection down while health stayed green.
//
// This script checks both in one command, against the live endpoint:
//
//   1. SURFACE  — tools/list from the deployed service, fingerprinted and hashed exactly as the
//                 two-plane drift detector does, compared to the committed docs/mcp-tool-manifest.json.
//                 A mismatch means the running revision is not this commit.
//   2. CLIENTS  — project.list through that same endpoint, reporting endpointConfigured /
//                 tokenConfigured per project. This is what catches a wiped environment.
//
// Usage:
//   MCP_URL=https://<service>/mcp MCP_API_TOKEN=<bearer> npm run verify:deploy
//   MCP_URL=... MCP_API_TOKEN=<legacy-bearer> MCP_SCOPED_MCP_TOKEN=<site-bearer> \
//     MCP_SCOPED_PROJECT_ID=platform npm run verify:deploy
//
// Read-only except for idempotent canonical-agent seeding on legacy workspaces. Never publishes.

import { fingerprintTools, readManifest, surfaceHash, type ListedTool } from "./twoPlaneDrift.js";

type JsonRpcResponse<T> = { result?: T; error?: { code: number; message: string } };

const rpc = async <T,>(url: string, token: string, method: string, params: Record<string, unknown> = {}): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Both are advertised because a spec-compliant Streamable HTTP server may answer either way.
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} from ${method}. A 401 here means the bearer is wrong; a 403 usually means Cloud Run IAM is in front of the service.`);

  const raw = await response.text();
  // SSE framing: each event's `data:` line carries a complete JSON-RPC message.
  const body = raw.includes("data:")
    ? raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.replace(/^data:\s?/, "")).join("")
    : raw;

  let payload: JsonRpcResponse<T>;
  try {
    payload = JSON.parse(body) as JsonRpcResponse<T>;
  } catch {
    throw new Error(`${method} did not return JSON. First 200 chars: ${raw.slice(0, 200)}`);
  }
  if (payload.error) throw new Error(`${method} failed: ${payload.error.code} ${payload.error.message}`);
  if (payload.result === undefined) throw new Error(`${method} returned no result.`);
  return payload.result;
};

type ProjectListResult = {
  structuredContent?: {
    ok?: boolean;
    data?: {
      projects?: Array<{
        projectId: string;
        status?: string;
        connection?: { endpointConfigured?: boolean; tokenConfigured?: boolean; mcpEndpointEnvVar?: string; tokenEnvVar?: string };
      }>;
    };
  };
};

type AgentResolveResult = {
  structuredContent?: {
    ok?: boolean;
    data?: { agent_ref?: string; rev?: number; model?: string; status?: string };
  };
};

const main = async (): Promise<number> => {
  const url = (process.env.MCP_URL ?? "").trim();
  const token = (process.env.MCP_API_TOKEN ?? "").trim();
  const scopedToken = (process.env.MCP_SCOPED_MCP_TOKEN ?? "").trim();
  const scopedProjectId = (process.env.MCP_SCOPED_PROJECT_ID ?? "").trim();

  if (!url || !token) {
    console.error("verify            USAGE    MCP_URL=https://<service>/mcp MCP_API_TOKEN=<bearer> npm run verify:deploy");
    return 2;
  }
  if (!!scopedToken !== !!scopedProjectId) {
    console.error("verify            USAGE    set both MCP_SCOPED_MCP_TOKEN and MCP_SCOPED_PROJECT_ID to assert a scoped bearer, or neither to skip that optional live check.");
    return 2;
  }

  const manifest = await readManifest();
  if (!manifest) {
    console.error("verify            MISSING  docs/mcp-tool-manifest.json does not exist — run `npm run drift:update` first.");
    return 2;
  }

  let failures = 0;

  // 1. Surface.
  const listed = await rpc<{ tools: ListedTool[] }>(url, token, "tools/list");
  const live = surfaceHash(fingerprintTools(listed.tools ?? []));
  if (live === manifest.surfaceHash) {
    console.log(`surface           ok       ${listed.tools.length} tools, surfaceHash ${live.slice(0, 12)}… matches the committed manifest`);
  } else {
    failures += 1;
    console.error(`surface           STALE    the deployed revision does not match this commit`);
    console.error(`                           manifest: ${manifest.surfaceHash.slice(0, 12)}… (${manifest.toolCount} tools)`);
    console.error(`                           live:     ${live.slice(0, 12)}… (${listed.tools?.length ?? 0} tools)`);
    console.error(`                           Rebuild and redeploy the image, then re-run. Merging a PR does not deploy this service.`);
  }

  // 2. Clients. A configured connection is not proof it answers, but an UNconfigured one is proof the
  //    deploy dropped its environment — which is the failure this exists to catch.
  const projects = await rpc<ProjectListResult>(url, token, "tools/call", { name: "project_list", arguments: {} });
  const rows = projects.structuredContent?.data?.projects ?? [];
  if (rows.length === 0) {
    failures += 1;
    console.error("clients           UNKNOWN  project_list returned no projects — cannot verify connection configuration.");
  } else {
    const broken = rows.filter((project) => project.status === "active" && !(project.connection?.endpointConfigured && project.connection?.tokenConfigured));
    for (const project of rows) {
      const connection = project.connection ?? {};
      const state = connection.endpointConfigured && connection.tokenConfigured ? "configured" : "NOT CONFIGURED";
      const suffix = state === "configured" ? "" : `  <- missing ${[connection.endpointConfigured ? null : connection.mcpEndpointEnvVar, connection.tokenConfigured ? null : connection.tokenEnvVar].filter(Boolean).join(" + ")}`;
      console.log(`  ${project.projectId.padEnd(12)} ${(project.status ?? "?").padEnd(9)} ${state}${suffix}`);
    }
    if (broken.length > 0) {
      failures += 1;
      console.error(`clients           BROKEN   ${broken.length} active client(s) have no endpoint/token on this revision.`);
      console.error(`                           Almost certainly a deploy that used --set-env-vars / --set-secrets, which REPLACE`);
      console.error(`                           the whole list. Redeploy with --update-env-vars / --update-secrets.`);
    } else {
      console.log(`clients           ok       ${rows.length} project(s), every active one configured`);
    }
  }

  // 3. Canonical conversational agent. This is a discovery assertion, not a conversation call:
  // the deployment must be able to seed/resolve the project-neutral definition before Platform
  // begins using it. It deliberately does not inspect or expose the prompt.
  for (const projectId of ["dr-lurie", "fernwell"] as const) {
    const agent = await rpc<AgentResolveResult>(url, token, "tools/call", { name: "agent_resolve", arguments: { role: "client_manager", project_id: projectId } });
    const resolved = agent.structuredContent?.data;
    if (!agent.structuredContent?.ok || !resolved?.agent_ref || !resolved.rev || !resolved.model || resolved.status !== "active") {
      failures += 1;
      console.error(`agent             BROKEN   ${projectId} did not resolve an active canonical client_manager definition.`);
    } else {
      console.log(`agent             ok       ${projectId} ${resolved.agent_ref} (${resolved.model})`);
    }
  }

  // 4. Scoped bearer policy. The scoped secret itself stays in Secret Manager; this optional
  // shell-only bearer is deliberately never printed. It proves the site token may resolve only
  // its pinned project and that the deployed parser has accepted the scoped secret.
  if (scopedToken && scopedProjectId) {
    const scopedAgent = await rpc<AgentResolveResult>(url, scopedToken, "tools/call", { name: "agent_resolve", arguments: { role: "client_manager", project_id: scopedProjectId } });
    const scopedResolved = scopedAgent.structuredContent?.data;
    if (!scopedAgent.structuredContent?.ok || !scopedResolved?.agent_ref || !scopedResolved.rev || !scopedResolved.model || scopedResolved.status !== "active") {
      failures += 1;
      console.error("scoped-auth       BROKEN   scoped bearer did not resolve an active canonical client_manager for its pinned project.");
    } else {
      console.log("scoped-auth       ok       scoped bearer resolved its pinned project's canonical agent");
    }
  } else {
    console.log("scoped-auth       SKIPPED  set MCP_SCOPED_MCP_TOKEN and MCP_SCOPED_PROJECT_ID in the operator shell to exercise a deployed site token");
  }

  return failures === 0 ? 0 : 1;
};

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`verify            ERROR    ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
