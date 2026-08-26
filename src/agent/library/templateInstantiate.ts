// T15.31 (#207; ADR-2026-08-25-structure-studio §4.1, §4.2) — instantiating a cross-tenant library
// template into a target tenant.
//
// NO NEW INSTANTIATION MECHANISM (ADR §4.1: "that would be the publish fork wearing a template's
// clothes"). This module's only write is the ONE call at the bottom to the platform's OWN
// object_instantiate_template / object_instantiate_section_template, through the SAME
// ProjectMcpAdapter.callTool every other verb in this codebase goes through — nothing here creates,
// patches, or otherwise authors a governed object of its own. Everything above that call is either a
// read (registry_get, allow-listed and approval-free) or a pure decision (which section types are
// missing, which verb name to use).
//
// AUTHORITY (ADR §4.2 — "resolved, not repealed"; §2.4 rule 1). The floor on these two verbs is
// PLATFORM policy, already reconciled server-side by platform#615 per the ADR — this module does not
// re-implement that reconciliation or special-case itself around it (§4.2: "do not special-case the
// studio to bypass the floor"). What this module DOES own, and must, is the one rule that is never a
// policy question: an explicit operator withheld halts everything, unconditionally, before any call is
// attempted — the same absolute rule 1 ADR-2026-08-25-publish-autonomy §2.4 states for publish. Once
// past that, the call goes through exactly as any other project tool call would: ProjectMcpAdapter's
// own toolPolicies/needs_approval gate and the platform server's own autonomy-aware floor decide the
// rest, honestly reported back via CallToolResult.requiresApproval when they hold it.
//
// VALIDATION (ADR §4.1 point 2 / issue #207 point 2): "a template requiring a section type the
// tenant's platform build lacks is rejected with a capability-backlog entry, never coerced." The
// target's LIVE registry is read at call time, never assumed from the library record's own
// (possibly-stale, possibly-another-tenant's) view of what exists.
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { TemplateLibraryRecord } from "./templateLibraryTypes.js";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export type CapabilityBacklogEntry = { sectionType: string; templateId: string; templateName: string };
export type InstantiateRefusal = { code: string; reason: string; capabilityBacklog?: CapabilityBacklogEntry[] };
export type InstantiateOutcome =
  | { ok: true; verb: "object_instantiate_template" | "object_instantiate_section_template"; targetProjectId: string; result: unknown }
  | { ok: false; refusal: InstantiateRefusal };

export type InstantiateDeps = { projectRepository?: ProjectRepository; adapter?: ProjectMcpAdapter };
const projectsOf = (deps: InstantiateDeps = {}): ProjectRepository => deps.projectRepository ?? repositoryManager.getProjectRepository();

const verbFor = (objectType: TemplateLibraryRecord["objectType"]): "object_instantiate_template" | "object_instantiate_section_template" | undefined => {
  if (objectType === "template") return "object_instantiate_template";
  if (objectType === "section_template") return "object_instantiate_section_template";
  return undefined; // pdf_template: not this path at all — ADR §7's own transport.
};

/** The live component registry's registered type names, read fresh at call time (never cached, never
 *  read from the library record's own — possibly stale, possibly another tenant's — view). */
async function readRegisteredSectionTypes(adapter: ProjectMcpAdapter): Promise<Set<string>> {
  const read = await adapter.callReadTool("registry_get", { registry: "component" });
  if (!read.ok) return new Set();
  const payload = read.result;
  const definitions = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.definitions)
      ? payload.definitions
      : [];
  const types = new Set<string>();
  for (const definition of definitions) {
    if (isRecord(definition) && typeof definition.type === "string" && definition.type) types.add(definition.type);
  }
  return types;
}

export async function instantiateLibraryTemplate(
  input: {
    targetProjectId: string;
    record: TemplateLibraryRecord;
    /** ADR §2.4 rule 1: an explicit operator withheld halts unconditionally, at every layer, in every
     *  mode. Pass the calling run's own `operatorPublishDecision` (or null/undefined outside a run —
     *  an operator-initiated instantiation, say). */
    operatorPublishDecision?: "approved" | "withheld" | null;
    /** Caller-supplied arguments for the platform verb beyond the template identity itself (e.g. the
     *  target page/site the platform's own contract requires) — this module never fabricates fields
     *  the platform's contract might need that it cannot know from the library record alone. */
    extraArgs?: Record<string, unknown>;
  },
  deps: InstantiateDeps = {}
): Promise<InstantiateOutcome> {
  if (input.operatorPublishDecision === "withheld") {
    return { ok: false, refusal: { code: "operator_withheld", reason: "The run's operatorPublishDecision is \"withheld\"; ADR-2026-08-25-publish-autonomy §2.4 rule 1 halts every instantiation unconditionally, regardless of policy or mode." } };
  }

  const verb = verbFor(input.record.objectType);
  if (!verb) {
    return { ok: false, refusal: { code: "template_object_type_not_instantiable", reason: `templateId "${input.record.templateId}" has objectType "${input.record.objectType}", which has no platform instantiate verb; only "section_template" and "template" do.` } };
  }

  const targetProjectId = input.targetProjectId.trim();
  const config: ProjectConnectionConfig | undefined = await projectsOf(deps).get(targetProjectId);
  if (!config) return { ok: false, refusal: { code: "unknown_project", reason: `Unknown projectId: ${targetProjectId}.` } };
  if (config.status === "disabled") return { ok: false, refusal: { code: "project_disabled", reason: `Project ${targetProjectId} is disabled; no instantiation may run against it.` } };

  const adapter = deps.adapter ?? new ProjectMcpAdapter(config);
  const registeredTypes = await readRegisteredSectionTypes(adapter);
  const missing = input.record.sectionTypesUsed.filter((sectionType) => !registeredTypes.has(sectionType));
  if (missing.length > 0) {
    return {
      ok: false,
      refusal: {
        code: "template_section_type_unsupported",
        reason: `templateId "${input.record.templateId}"@${input.record.version} requires section type(s) ${missing.join(", ")}, which project "${targetProjectId}"'s live component registry does not carry. Never coerced onto a near-neighbour type; recorded as a capability backlog entry instead.`,
        capabilityBacklog: missing.map((sectionType) => ({ sectionType, templateId: input.record.templateId, templateName: input.record.name }))
      }
    };
  }

  const call = await adapter.callTool(verb, {
    templateId: input.record.templateId,
    version: input.record.version,
    objectType: input.record.objectType,
    name: input.record.name,
    template: input.record.recipe,
    ...(input.extraArgs ?? {})
  });

  if (!call.ok) {
    return {
      ok: false,
      refusal: {
        code: call.requiresApproval ? "operator_approval_absent" : "template_instantiate_failed",
        reason: call.error ?? `${verb} failed for project "${targetProjectId}".`
      }
    };
  }

  return { ok: true, verb, targetProjectId, result: call.result };
}
