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
//                         mcpEndpointEnvVar is set in THIS process. If not, the driver does not
//                         dispatch; it records `driver_env_missing:<VAR>` on the run once and leaves
//                         the run for a driver that can see the endpoint.
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
import { resolveProjectConnection } from "../projects/projectMcpAdapter.js";

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
