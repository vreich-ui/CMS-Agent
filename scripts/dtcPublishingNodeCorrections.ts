import type { WorkspaceNode } from "../src/agent/workspace/nodeTypes.js";

// Pure, additive authoring patches for the live DTC workspace. Deliberately not a canonical re-seed:
// live brand, offer, model and tool policy must survive. Apply each returned patch atomically through
// workspace_update_node with a freshly read workspace version and revision, then validate read-back.
const marker = "DTC handoff contract (2026-09-09):";
const text = { type: "string", minLength: 1 };
const strings = { type: "array", items: text };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: true });
const list = (items: unknown) => ({ type: "array", items });
const common = { blockers: strings, advisories: strings };
const commonInstructions = "Always emit blockers and advisories as arrays, including [] when empty. Put every unresolved blocker in the top-level blockers array as a non-empty string; a refusal written only in summary, notes, or an unrecognized status field does not reach the publication controller. Keep editorial preferences in advisories. Missing evidence is not permission to invent it. Emit one JSON object in this node's schema; keep existing useful fields and keep all strategy/evidence annotations out of reader-visible copy.";
const requiresBlocker = (field: string, values: string[]) => ({
  if: { required: [field], properties: { [field]: { enum: values } } },
  then: { properties: { blockers: { minItems: 1 } } },
  else: { properties: { blockers: { maxItems: 0 } } }
});

type Contract = { properties: Record<string, unknown>; rules?: unknown[]; instructions: string };
const contracts: Record<string, Contract> = {
  research: {
    properties: {
      ...common,
      evidenceStatus: { enum: ["supported", "partial", "unavailable", "not_needed"] },
      sources: list(obj({ sourceId: text, reference: text, sourceType: { enum: ["primary", "secondary", "supplied"] }, relevance: text })),
      findings: list(obj({ claimId: text, claim: text, status: { enum: ["supported", "unverified"] }, sourceIds: strings, limitations: { type: "string" } }))
    },
    rules: [
      { if: { required: ["evidenceStatus"], properties: { evidenceStatus: { enum: ["supported", "partial"] } } }, then: { properties: { findings: { minItems: 1 }, sources: { minItems: 1 } } } },
      { if: { required: ["evidenceStatus"], properties: { evidenceStatus: { const: "unavailable" } } }, then: { properties: { blockers: { minItems: 1 } } } }
    ],
    instructions: "Return evidenceStatus, sources, and findings. Sources carry sourceId, reference (the actual URL or a specific supplied document/input reference), sourceType, and relevance. Findings carry stable claimId, claim, status supported/unverified, sourceIds referencing those sources, and limitations. Never invent a citation or claim that an unread page was checked. Use supported only when the material claims have evidence; partial when useful evidence exists with named gaps; unavailable when required evidence cannot be obtained, with a blocker; not_needed only when no material external claim needs checking, explained in notes. A supplied statement is attributed to its supplier, not promoted to independently verified evidence. Consumers must be able to distinguish sourced findings from assumptions without parsing prose notes."
  },
  draft_writer: {
    properties: {
      ...common,
      draftStatus: { enum: ["ready", "blocked"] },
      proposedTitle: text,
      draftSections: list(obj({ sectionId: text, heading: text, readerVisibleCopy: { type: "string" } })),
      sourceClaimNotes: list(obj({ claimId: text, claim: text, evidenceReferences: strings, handling: text })),
      nextStep: obj({ action: text, destination: { type: ["string", "null"] }, rationale: text })
    },
    rules: [requiresBlocker("draftStatus", ["blocked"]), {
      if: { required: ["draftStatus"], properties: { draftStatus: { const: "ready" } } },
      then: { properties: { draftSections: { minItems: 1, items: { properties: { readerVisibleCopy: text } } } } }
    }],
    instructions: "Return draftStatus, proposedTitle, draftSections, sourceClaimNotes, and nextStep. Each draftSections entry contains sectionId, heading, and the COMPLETE readerVisibleCopy, not an outline or directions for another writer. Preserve supplied claim IDs and evidence references in sourceClaimNotes; if the brief omits evidence, flag that gap rather than inventing references. nextStep names the one primary action, its supplied/verified destination (null when unknown), and its rationale. A deliberate no-action request must be named and explained rather than replaced with an invented offer. Do not invent a URL or add competing asks. draftStatus ready requires actual section copy and no unresolved blockers; use blocked with named blockers for a source-awaiting shell. Never put placeholders, production notes, or source gaps into readerVisibleCopy as if ready for publication. Client voice and the assigned magnetic_marketing/editorial_craft skills continue to govern the writing."
  },
  trust_factual: {
    properties: {
      ...common,
      verdict: { enum: ["pass", "revise", "blocked"] },
      coverageNote: text,
      claimReviews: list(obj({ claimId: text, claim: text, decision: { enum: ["keep", "soften", "remove", "unverified"] }, evidenceReferences: strings, reason: text, revision: { type: ["string", "null"] } }))
    },
    rules: [requiresBlocker("verdict", ["revise", "blocked"]), {
      if: { required: ["verdict"], properties: { verdict: { const: "pass" } } },
      then: { properties: { claimReviews: { items: { properties: { decision: { const: "keep" } } } } } }
    }],
    instructions: "Return verdict, coverageNote, and claimReviews. Preserve the research/draft claim IDs; identify an additional material claim explicitly when the draft introduced one. For every material claim state the claim, keep/soften/remove/unverified decision, actual evidenceReferences, reason, and exact proposed revision (or null). coverageNote identifies the draft reviewed and any limits; an empty claimReviews array is valid only when that draft contains no material factual claims, with the reason stated. Do not describe an unavailable draft or missing evidence as a passed review. verdict pass requires no unresolved factual/reader-safety blockers; revise means material claim changes are required; blocked means essential review evidence is unavailable. Both revise and blocked require top-level blockers. Prefix these blocker strings with 'trust_factual: ' so their origin is explicit in downstream handoffs. Cosmetic or optional wording improvements belong in advisories. Never treat a proposed correction as already applied or reverified."
  },
  review_aggregator: {
    properties: {
      ...common,
      reviewStatus: { enum: ["ready", "blocked"] },
      revisions: list(obj({ sourceNodeId: text, target: text, instruction: text, priority: { enum: ["factual", "editorial"] } })),
      unresolvedConflicts: strings,
      buildInstructions: strings
    },
    rules: [requiresBlocker("reviewStatus", ["blocked"])],
    instructions: "Return reviewStatus, revisions, unresolvedConflicts, and buildInstructions. Revisions identify the actual sourceNodeId, exact passage/section target, concrete instruction, and factual/editorial priority. Consolidate duplicate suggestions and explain incompatible suggestions in unresolvedConflicts instead of ordering mutually exclusive edits. Preserve factual-review blocker strings verbatim, including their source prefix, in blockers; never demote them or claim they were fixed merely because you proposed a revision. If a legacy factual-review output states an unresolved material refusal only in summary/notes, carry that refusal into blockers with the trust_factual prefix. reviewStatus blocked requires these unresolved blockers; ready has none. Keep other reviewers' taste judgments advisory. Consume the conductor's skippedDependencies ledger: an explicitly skipped reviewer is not missing or completed, and must never be invented. buildInstructions direct faithful conversion of the actual draft after the specified edits, not a fresh rewrite from summaries."
  }
};

export function buildDtcPublishingNodeCorrection(node: WorkspaceNode): Partial<WorkspaceNode> | undefined {
  if (node.id === "article_body") {
    const prompt = node.prompt.replace(/\bartifact_plan\b/g, "artifact_materializer");
    return prompt === node.prompt ? undefined : { prompt };
  }
  if (node.id === "topic_opportunity") {
    const policy = "Routing responsibility (2026-09-09): route and no-build recommendations from this node are advisory inputs to the brief. This node does not change the conductor graph or stop a run. State the recommended route and rationale without claiming it was executed, and honor an explicit operator-requested build. Missing client identity or unsafe unsupported claims must still be reported explicitly for the responsible downstream checks.";
    return node.prompt.includes(policy) ? undefined : { prompt: `${node.prompt}\n\n${policy}` };
  }
  const contract = contracts[node.id];
  if (!contract) return undefined;
  const schema = structuredClone(node.outputSchema) as Record<string, any>;
  if (!schema || schema.type !== "object") throw new Error(`CMS-Agent ${node.id}: expected an object output schema; inspect the live node before editing.`);
  for (const [key, value] of Object.entries(contract.properties)) {
    if (schema.properties?.[key] && JSON.stringify(schema.properties[key]) !== JSON.stringify(value)) {
      throw new Error(`CMS-Agent ${node.id}: live field ${key} already has a different contract; preserve it and reconcile explicitly.`);
    }
  }
  schema.properties = { ...(schema.properties ?? {}), ...contract.properties };
  schema.required = [...new Set([...(schema.required ?? []), ...Object.keys(contract.properties)])];
  const rules = schema.allOf ?? [];
  schema.allOf = [...rules, ...(contract.rules ?? []).filter((rule) => !rules.some((old: unknown) => JSON.stringify(old) === JSON.stringify(rule)))];
  const prompt = node.prompt.includes(marker) ? node.prompt : `${node.prompt}\n\n${marker}\n${commonInstructions}\n${contract.instructions}`;
  if (prompt === node.prompt && JSON.stringify(schema) === JSON.stringify(node.outputSchema)) return undefined;
  return { prompt, outputSchema: schema, schema };
}
