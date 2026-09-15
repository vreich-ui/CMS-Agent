// CMP-W1.4 — the tool list, condensed to one line each and grouped by what it is FOR.
//
// WHY. Platform sends this agent up to 99 tools per turn, each with a description up to 16,000
// characters (conversationContract.ts's own bounds). The model therefore already has every fact in
// this block — spread across a quarter-megabyte of JSON it has to read past before it can form a
// plan. This is the same material, sorted into the five questions an editor's request actually
// raises: what can I READ, what can I CHANGE, what can I PUBLISH, what makes ARTIFACTS, and what
// tells me whether something WORKED.
//
// PURE, AND DERIVED FROM THE WIRE ONLY. No tool list is maintained here — a registry copy would go
// stale the first time Platform added a tool, which is exactly how W19/W21's truncation defects
// happened. Everything below is computed from the `tools` array of the turn being assembled, so a
// tool that is not on the wire cannot appear in the briefing, and one that is cannot be missed.
import type { ConversationTool } from "../conversationContract.js";

export const toolPurposes = ["read", "write", "publish", "artifact", "diagnostics", "other"] as const;
export type ToolPurpose = typeof toolPurposes[number];

// Longest single line a tool contributes. A 16,000-character description is legal on the wire; the
// briefing's whole value is that it is small, so the summary is hard-truncated rather than trusted.
const MAX_SUMMARY_CHARS = 110;

/**
 * Ordered classification rules — FIRST MATCH WINS, and the order is the point.
 *
 * `deploy_status` is diagnostics, not publishing, even though its name contains a publishing word;
 * `publish_pdf_template` is publishing, not artifact work, even though it is about a template. Both
 * are only true because diagnostics is tested before publish and publish before artifact. Read the
 * array top to bottom as the precedence it is, and add a new rule at the position its exceptions
 * need rather than at the end.
 *
 * Nothing here gates anything. A tool's real permission is `effectiveToolPermission` on the project
 * record plus the node/run grant; this is vocabulary for a reader, not policy.
 */
const classificationRules: Array<{ purpose: ToolPurpose; test: RegExp }> = [
  { purpose: "diagnostics", test: /^(health|ping|whoami|deploy_status|repository_get_health|project_test_connection)$|_status$|^analytics_|^usage_|^constellation_|_audit$|^verify_|^evaluation_/ },
  { purpose: "publish", test: /^(object_publish|object_submit_review|object_review_decide|release_to_production|publish_pdf_template|order_reissue|ownership_transfer)$|^workflow_publish|^publish_/ },
  { purpose: "artifact", test: /image|pdf|artifact|render|capture|preview|template|annotate|theme|visual_identity/ },
  { purpose: "write", test: /^(object_create|object_patch|object_checkout|object_checkin|object_discard|object_retire|object_refresh_lock|object_create_variant|object_instantiate_template|object_instantiate_section_template|product_set_price|site_apply_brand_imagery|site_apply_theme)$|^member_|^marginalia_(create|reply|resolve)$|^invitation_|_set$|^set_|_update$|^update_|^import_/ },
  { purpose: "read", test: /^(object_get|object_list|object_inventory|object_contract|object_validate|content_search|registry_get|membership_contract|marginalia_list)$|^get_|^list_|^search_|_get$|_list$|^operation_|_contract$/ }
];

export const classifyTool = (name: string): ToolPurpose =>
  classificationRules.find((rule) => rule.test.test(name))?.purpose ?? "other";

// First sentence of the description, truncated. A description that opens with a heading or a bare
// label (no sentence break inside the budget) still yields its first `MAX_SUMMARY_CHARS`, which is
// more useful to a reader than an empty cell.
export const condenseToolDescription = (description: string): string => {
  const flattened = description.replace(/\s+/g, " ").trim();
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(flattened)?.[0] ?? flattened;
  return sentence.length <= MAX_SUMMARY_CHARS ? sentence : `${sentence.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
};

const purposeHeadings: Record<ToolPurpose, string> = {
  read: "Read (free — never ask permission to look)",
  write: "Change a governed object",
  publish: "Publish and release",
  artifact: "Make images, PDFs and templates",
  diagnostics: "Check whether something worked",
  other: "Everything else on this turn's wire"
};

/**
 * `## …` heading is supplied by the briefing assembler; this renders the body.
 *
 * Empty groups are omitted rather than printed empty — an "Everything else: (none)" line teaches a
 * reader nothing and costs tokens on every turn of every conversation.
 */
export const renderToolSemantics = (tools: ConversationTool[]): string => {
  if (!tools.length) return "No tools reached this turn. Say so plainly rather than describing work you cannot do.";
  const grouped = new Map<ToolPurpose, string[]>();
  for (const tool of [...tools].sort((left, right) => left.name.localeCompare(right.name))) {
    const purpose = classifyTool(tool.name);
    const lines = grouped.get(purpose) ?? [];
    lines.push(`- \`${tool.name}\` — ${condenseToolDescription(tool.description)}`);
    grouped.set(purpose, lines);
  }
  return toolPurposes
    .filter((purpose) => grouped.has(purpose))
    .map((purpose) => [`**${purposeHeadings[purpose]}**`, ...(grouped.get(purpose) ?? [])].join("\n"))
    .join("\n\n");
};
