// S1 (chat-path, 2026-08-17) — DRIVER ENVIRONMENT PREFLIGHT.
//
// Four drivers advance runs (the HTTP run_all/run_node loops, the HTTP retry, the scheduled
// continuation tick, the Cloud Run conductor job) and each runs in its own process with its own
// environment. Live evidence: a run started over HTTP (where DR_LURIE_MCP_ENDPOINT was set) was picked
// up by the continuation tick in a function whose environment lacked it, and the node that needed the
// client's MCP endpoint failed with a connection error that read as a client outage. It was not — the
// driver simply could not see the endpoint. This module makes that a named, pre-dispatch fact:
//
//   preflightDriverEnv  — before a background driver advances a run for project P, ask whether P's
//                         endpoint RESOLVES in THIS process. If not, the driver does not dispatch;
//                         it records `driver_env_missing:<VAR>` on the run once and leaves the run
//                         for a driver that can see the endpoint. Since 2026-08-18 a project may
//                         carry its endpoint on its own registry record (ProjectConnectionConfig.
//                         mcpEndpoint), which every driver reads from the same store — such a
//                         project passes this preflight in EVERY process, which is precisely the
//                         divergence class this module exists to catch. The env var remains the
//                         override, and a project that relies on it is gated exactly as before.
//   logProjectEnvNamesOnce — once per cold start, log the NAMES of the project env vars this process
//                         can see (never their values), so a deploy's log answers "which projects
//                         could this driver have served" without anyone opening the console.
//
// The HTTP tools are not gated here on purpose: they are the path the operator is watching, the
// executor already stamps projectEndpointConfigured on the dispatch claim, and refusing there would
// hide a misconfiguration behind a silent no-op instead of a failed node the operator can read.
import type { WorkflowExecutionRecord } from "./executionTypes.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { ProjectMcpAdapter, resolveProjectConnection, resolveProjectConnectionWithSecrets, type ProjectAdapterDeps } from "../projects/projectMcpAdapter.js";
import { conductorCache, type RunScopedCache } from "./conductor.js";

export const DRIVER_ENV_MISSING_PREFIX = "driver_env_missing:";
export const driverEnvMissingWarning = (envVar: string): string => `${DRIVER_ENV_MISSING_PREFIX}${envVar}`;

export type DriverEnvPreflight =
  | { ok: true; projectId: string; envVar?: string }
  | { ok: false; projectId: string; envVar: string; warning: string };

// Best-effort by design: an unknown project (no config to name an env var) or a repository error
// yields ok:true, so the executor's own client_project_unresolved path — a failed node the operator
// can read — is what surfaces it, not a silent skip that looks like a stalled run.
//
// A MOCK run is exempt: it makes no project MCP call by construction (the mock runner and every
// deterministic path degrade to seeded fallbacks with a run-visible warning), so refusing it would
// stall CI's graph traversal for an env var it would never read.
export async function preflightDriverEnv(run: Pick<WorkflowExecutionRecord, "projectId" | "executionMode">, projectRepository: ProjectRepository, env: NodeJS.ProcessEnv = process.env): Promise<DriverEnvPreflight> {
  const projectId = run.projectId;
  if (run.executionMode === "mock") return { ok: true, projectId };
  let config;
  try {
    config = await projectRepository.get(projectId);
  } catch {
    return { ok: true, projectId };
  }
  if (!config) return { ok: true, projectId };
  const resolved = resolveProjectConnection(config, env);
  if (resolved.endpointConfigured) return { ok: true, projectId, envVar: config.mcpEndpointEnvVar };
  return { ok: false, projectId, envVar: config.mcpEndpointEnvVar, warning: driverEnvMissingWarning(config.mcpEndpointEnvVar) };
}

// Records the warning on the run ONCE (idempotent across ticks) and persists it. Returns the saved
// record, or the input unchanged when the warning was already present. A save conflict is swallowed:
// the warning is advisory, and the next tick will simply try again.
export async function recordDriverEnvWarning(run: WorkflowExecutionRecord, warning: string, store: ExecutionRepository): Promise<WorkflowExecutionRecord> {
  if ((run.warnings ?? []).includes(warning)) return run;
  try {
    return await store.saveRun({ ...run, warnings: [...(run.warnings ?? []), warning], updatedAt: new Date().toISOString() });
  } catch {
    return run;
  }
}

let loggedEnvNames = false;
export const __resetDriverEnvLogForTests = (): void => { loggedEnvNames = false; };

// Logs, once per process, which project MCP env vars are present and which are absent — by NAME only.
export async function logProjectEnvNamesOnce(projectRepository: ProjectRepository, env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (line) => console.info(line)): Promise<void> {
  if (loggedEnvNames) return;
  loggedEnvNames = true;
  try {
    const projects = await projectRepository.list();
    const names = new Set<string>();
    for (const project of projects) {
      names.add(project.mcpEndpointEnvVar);
      if (project.tokenEnvVar) names.add(project.tokenEnvVar);
    }
    const sorted = [...names].sort();
    const present = sorted.filter((name) => Boolean(env[name]?.trim()));
    const absent = sorted.filter((name) => !env[name]?.trim());
    log(`[driver-env] project env vars present: [${present.join(", ")}] absent: [${absent.join(", ")}]`);
  } catch (error) {
    log(`[driver-env] could not enumerate project env vars: ${error instanceof Error ? error.message : String(error)}`);
  }
}


// ---------------------------------------------------------------------- T1: authenticated preflight
//
// preflightDriverEnv above answers "can this process RESOLVE the client's endpoint?" — a check that
// reads environment variables and never leaves the process. That is a strictly weaker question than
// the one the run actually depends on, and the gap is where the expensive failures lived: an endpoint
// that resolves plus a token that is absent, stale, or unreadable by THIS plane presents as a fully
// configured driver right up until the first client call, several paid nodes later.
//
// The same gap swallows the cheap checks an operator reaches for. `initialize` and
// project.test_connection succeed WITHOUT a valid credential on these servers, so "the connection
// tested fine" has never been evidence that a run can read anything. Only an AUTHENTICATED read is.
//
// preflightDriverAuth performs exactly one — registry_get, the smallest read on the shared allowlist
// — once per (run, project) before the first model node is dispatched, and refuses the run on 401/403
// with the env var an operator must fix by NAME. Everything else is deliberately non-blocking: a
// client that is merely unreachable, slow, or that blocks registry_get by policy says nothing about
// the credential, and turning those into a pre-spend refusal would trade a costly failure for an
// unavailable pipeline.
export const DRIVER_AUTH_FAILED_PREFIX = "driver_auth_failed:";
export const driverAuthFailedError = (envVar: string): string => `${DRIVER_AUTH_FAILED_PREFIX}${envVar}`;

// The smallest authenticated read on ProjectMcpAdapter's fixed read-only allowlist. It is a
// tool CALL, not `initialize`: initialize is answered unauthenticated by these servers, which is why
// project.test_connection has repeatedly reported a healthy connection for a plane holding a dead
// token.
export const AUTH_PREFLIGHT_TOOL = "registry_get";

// Matches contractPrefetch's bound: one short read against a client, not a write that may need to
// reach a slower operation on the remote.
const AUTH_PREFLIGHT_TIMEOUT_MS = 15_000;

export type DriverAuthPreflight =
  | { ok: true; projectId: string; checked: boolean; skipReason?: string }
  | { ok: false; projectId: string; credentialName: string; error: string; detail: string };

export type DriverAuthPreflightOptions = {
  env?: NodeJS.ProcessEnv;
  cache?: RunScopedCache;
  adapterDeps?: ProjectAdapterDeps;
};

// The name an operator has to act on. A token that comes from Secret Manager is named by its secret
// ref, because telling someone to set an env var that this plane does not read would send them to
// the wrong console.
const credentialNameFor = (config: { tokenEnvVar?: string; tokenSecretRef?: string }, source: "env" | "secret" | "unset"): string =>
  source === "secret" ? (config.tokenSecretRef ?? config.tokenEnvVar ?? "unknown_credential") : (config.tokenEnvVar ?? config.tokenSecretRef ?? "unknown_credential");

export async function preflightDriverAuth(
  run: Pick<WorkflowExecutionRecord, "runId" | "projectId" | "executionMode">,
  projectRepository: ProjectRepository,
  options: DriverAuthPreflightOptions = {}
): Promise<DriverAuthPreflight> {
  const projectId = run.projectId;
  const env = options.env ?? process.env;
  const cache = options.cache ?? conductorCache;
  // A MOCK run makes no project MCP call by construction — same exemption, and for the same reason,
  // as preflightDriverEnv's.
  if (run.executionMode === "mock") return { ok: true, projectId, checked: false, skipReason: "mock_run" };

  // Memoized per (run, project) so a run pays this round-trip once, not once per node. Only a PASS is
  // cached (T3): a refusal ends the run anyway, and caching it would outlive the operator's fix.
  return cache.getOrLoad(run.runId, `driver_auth:${projectId}`, async (): Promise<DriverAuthPreflight> => {
    let config;
    try {
      config = await projectRepository.get(projectId);
    } catch {
      return { ok: true, projectId, checked: false, skipReason: "project_repository_unavailable" };
    }
    // Best-effort, exactly as above: an unknown project has no credential to name, and the executor's
    // own client_project_unresolved path is what should surface it.
    if (!config) return { ok: true, projectId, checked: false, skipReason: "project_unknown" };
    if (config.status === "disabled") return { ok: true, projectId, checked: false, skipReason: "project_disabled" };
    if (!resolveProjectConnection(config, env).endpointConfigured) {
      // preflightDriverEnv owns this verdict and expresses it as `driver_env_missing:<VAR>` — a
      // warning that leaves the run for a driver that CAN see the endpoint. Refusing here too would
      // convert that recoverable hand-off into a dead run.
      return { ok: true, projectId, checked: false, skipReason: "endpoint_unresolved" };
    }

    // A record that NAMES a secret this plane cannot read is an auth failure that never reaches the
    // wire — and the one case where the 401 would otherwise arrive with the wrong explanation
    // attached ("the client rejected our token" rather than "this plane may not read the token").
    const resolved = await resolveProjectConnectionWithSecrets(config, env, options.adapterDeps?.secrets ?? {});
    if (resolved.tokenError) {
      const credentialName = credentialNameFor(config, "secret");
      return {
        ok: false,
        projectId,
        credentialName,
        error: driverAuthFailedError(credentialName),
        detail: `This driver could not resolve project "${projectId}"'s MCP token from ${config.tokenSecretRef}: ${resolved.tokenError}. No node was dispatched. Grant this plane's runtime identity access to that secret, or set ${config.tokenEnvVar ?? "the project's token env var"} on this deployment.`
      };
    }

    const adapter = new ProjectMcpAdapter(config, { env, ...options.adapterDeps });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_PREFLIGHT_TIMEOUT_MS);
    let call;
    try {
      call = await adapter.callReadTool(AUTH_PREFLIGHT_TOOL, {}, controller.signal);
    } catch {
      // Never throws into the dispatch path: a preflight that cannot complete is not evidence of a
      // bad credential.
      return { ok: true, projectId, checked: false, skipReason: "preflight_unavailable" };
    } finally {
      clearTimeout(timer);
    }

    if (call.authFailed) {
      const credentialName = credentialNameFor(config, resolved.tokenSource);
      return {
        ok: false,
        projectId,
        credentialName,
        error: driverAuthFailedError(credentialName),
        detail: `Project "${projectId}" rejected this driver's credential with HTTP ${call.httpStatus ?? "401/403"} on an authenticated ${AUTH_PREFLIGHT_TOOL} read, so no node was dispatched and nothing was spent. The credential this driver presented came from ${resolved.tokenSource === "secret" ? `Secret Manager (${config.tokenSecretRef})` : resolved.tokenSource === "env" ? `the ${config.tokenEnvVar} environment variable on this deployment` : "nowhere — neither an env var nor a secret ref resolved a token"}. Sync ${credentialName} for this plane and retry the run.`
      };
    }
    // Anything else — unreachable, timed out, 5xx, or registry_get blocked by the project's own tool
    // policy — is not a credential verdict and must not block a run.
    return { ok: true, projectId, checked: call.ok, ...(call.ok ? {} : { skipReason: "preflight_inconclusive" }) };
  }, { shouldCache: (result) => result.ok });
}


// ------------------------------------------------------------ T2: in-node client auth failure
//
// The preflight above catches a credential that was ALREADY bad when the run reached its first paid
// node. It cannot catch one that goes bad mid-run (a rotation, a revoked grant, a client that starts
// refusing partway through), and it deliberately does not gate the deterministic reads that happen
// before any dispatch. When a 401/403 surfaces from inside a node instead, the verdict must be the
// same one: this run cannot reach its client, so it stops.
//
// A separate code from `driver_auth_failed:` on purpose. Both mean "this plane's credential for the
// client is not accepted", but they are found at different moments and by different machinery, and
// collapsing them would cost the one piece of triage information that distinguishes "we never had a
// working credential" from "we lost it while spending".
export const CLIENT_AUTH_FAILED_PREFIX = "client_auth_failed:";
export const clientAuthFailedError = (credentialName: string): string => `${CLIENT_AUTH_FAILED_PREFIX}${credentialName}`;

// The credential an operator has to act on for a project, resolved from the record rather than
// guessed. Best-effort by design: a name is for the human reading the failure, and not having one
// must never be the reason a failure goes unreported — hence the fallback to the project id.
export async function resolveProjectCredentialName(projectId: string, projectRepository: ProjectRepository, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const config = await projectRepository.get(projectId);
    if (!config) return projectId;
    const resolved = resolveProjectConnection(config, env);
    return credentialNameFor(config, resolved.tokenSource);
  } catch {
    return projectId;
  }
}
