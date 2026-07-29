import { describe, expect, it } from "vitest";
import { reduceContract } from "../../../src/agent/workspace/contractReduction.js";

// F1 (T-2, run_1785352838155_l544ye): contract_intelligence cost $2.57 / 502,397 input tokens with
// maxTurns capped at 8 — the fetched contract re-sent on every turn. This fixture mirrors a REAL
// platform object_contract(content_item) response (fetched live and inspected while building this
// fix): a JSON Schema body_schema, a constraints array, publish/media/creation policy objects, a
// workflow block with BOTH a useful sequence and a verbose error catalogue, patch_ops with recursive
// arg_schema $defs, and auxiliary_inputs notes. The reducer must keep what downstream nodes act on
// and drop what's purely prose/examples/error catalogues.
const REAL_SHAPED_CONTRACT = {
  object_type: "content_item",
  creatable: true,
  governed: true,
  summary: "Articles as governed objects: an annotated node list with rich_text.v1 or plain-text bodies.",
  body_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["slug", "title", "nodes"],
    additionalProperties: false,
    properties: { slug: { type: "string" }, title: { type: "string" }, nodes: { type: "array" } },
    $defs: { rich_text_v1: { type: "object" } }
  },
  constraints: [
    { id: "schema_zod", severity: "blocks_write", enforced_live: true, description: "The body must parse against this type's zod schema. Unknown keys are rejected (strict)." },
    { id: "article_slug", severity: "blocks_write", enforced_live: true, description: "slug must be lowercase-hyphen and unique across article objects AND the committed legacy posts — it becomes the article URL through the blog permalink route, so a slug collision or malformed slug breaks routing for both this and the older post silently.".slice(0, 400) },
    { id: "article_taxonomy", severity: "blocks_write", enforced_live: true, description: "taxonomy.category and taxonomy.tags resolve against the tax_platform registry; unknown terms are blockers." }
  ],
  publish_policy: {
    gated: true,
    requires_approval: false,
    note: "Autonomous: an agent may object_publish directly (no approval). A HUMAN executing a publish still needs the admin/publisher role.",
    denial_codes: {
      content_item_not_gated: "Defensive only since every type is governed.",
      approval_required: "The type requires approval and none is current/approved."
    },
    pin_rules: "M-6: pin \"immediate\" <=> omit published_time."
  },
  media_policy: { max_image_bytes: 153600, preferred_image_format: "webp", over_budget: "warn" },
  creation_policy: { humans: "always_allowed", agents: "open" },
  workflow: {
    sequence: ["object_contract (this call)", "object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"],
    lock_discipline: "423 = no/expired/other-held lock (checkout again); 409 = your expected_record_version is stale.",
    patch_error_codes: {
      invalid_op: { http: 400, meaning: "The op is malformed." },
      op_not_applicable: { http: 422, meaning: "The op is valid but not allowed for this object_type." }
    }
  },
  patch_ops: [
    {
      op: "set_article_meta",
      arg_schema: {
        type: "object",
        required: ["op", "fields"],
        description: "Merge article meta fields (title/slug/author/taxonomy/seo/scores/…); nodes are edited only via node ops.",
        $defs: { __schema0: { anyOf: [{ type: "string" }, { type: "number" }] } }
      }
    },
    { op: "upsert_node", arg_schema: { type: "object", required: ["op", "node"] } }
  ],
  auxiliary_inputs: [
    { input: "taxonomy terms", when: "taxonomy.category / taxonomy.tags", how: "Slugs from the tax_platform registry; unknown terms block." },
    { input: "image artifacts", when: "node public.media {type:\"image\"}", how: "Generate through pdf-tool, then set src to the PUBLIC path of the returned blobKey." },
    { input: "lock_token", when: "every patch/publish", how: "From object_checkout." }
  ]
};

describe("reduceContract (F1 deterministic contract reduction)", () => {
  const source = { tool: "object_contract", fetchedAtISO: "2026-07-29T00:00:00.000Z" };

  it("keeps the body schema whole (structural, not prose) and carries clientObjectType/contractSource through", () => {
    const reduced = reduceContract(REAL_SHAPED_CONTRACT, source, "content_item");
    expect(reduced.clientObjectType).toBe("content_item");
    expect(reduced.contractSource).toEqual(source);
    expect(reduced.bodySchema).toEqual(REAL_SHAPED_CONTRACT.body_schema);
  });

  it("extracts id/slug conventions from the constraints array, not a separate (nonexistent) key", () => {
    const reduced = reduceContract(REAL_SHAPED_CONTRACT, source, "content_item");
    expect(reduced.idConventions).toEqual([expect.objectContaining({ id: "article_slug", severity: "blocks_write" })]);
    expect(reduced.idConventions.map((entry) => entry.id)).not.toContain("schema_zod");
  });

  it("keeps every constraint with its severity/enforcedLive, description bounded", () => {
    const reduced = reduceContract(REAL_SHAPED_CONTRACT, source, "content_item");
    expect(reduced.constraints).toHaveLength(3);
    expect(reduced.constraints[0]).toMatchObject({ id: "schema_zod", severity: "blocks_write", enforcedLive: true });
    expect(reduced.constraints[0].note!.length).toBeLessThan(200);
  });

  it("folds media_policy and the media-relevant auxiliary_inputs together, ignoring unrelated ones", () => {
    const reduced = reduceContract(REAL_SHAPED_CONTRACT, source, "content_item");
    expect(reduced.mediaConvention.policy).toEqual(REAL_SHAPED_CONTRACT.media_policy);
    expect(reduced.mediaConvention.notes).toEqual([expect.objectContaining({ input: "image artifacts" })]);
    expect(reduced.mediaConvention.notes.map((note) => note.input)).not.toContain("lock_token");
  });

  it("surfaces the taxonomy source and its blocking constraint", () => {
    const reduced = reduceContract(REAL_SHAPED_CONTRACT, source, "content_item");
    expect(reduced.taxonomy.notes).toEqual([expect.objectContaining({ input: "taxonomy terms" })]);
    expect(reduced.taxonomy.blockingConstraints).toEqual([expect.objectContaining({ id: "article_taxonomy" })]);
  });

  it("drops publish_policy's denial_codes catalogue but keeps the actionable gated/requires_approval/pin_rules facts", () => {
    const reduced = reduceContract(REAL_SHAPED_CONTRACT, source, "content_item") as any;
    expect(reduced.publishPolicy).toMatchObject({ gated: true, requires_approval: false });
    expect(reduced.publishPolicy.denial_codes).toBeUndefined();
    expect(reduced.publishPolicy.pin_rules).toBeDefined();
  });

  it("keeps the workflow sequence but drops the patch_error_codes catalogue", () => {
    const reduced = reduceContract(REAL_SHAPED_CONTRACT, source, "content_item");
    expect(reduced.workflowSequence).toEqual(REAL_SHAPED_CONTRACT.workflow.sequence);
    expect(JSON.stringify(reduced)).not.toContain("op_not_applicable");
  });

  it("reduces patch_ops to op name + top-level required fields, dropping the recursive $defs", () => {
    const reduced = reduceContract(REAL_SHAPED_CONTRACT, source, "content_item");
    expect(reduced.validationSurface).toEqual([
      expect.objectContaining({ op: "set_article_meta", requiredFields: ["op", "fields"] }),
      expect.objectContaining({ op: "upsert_node", requiredFields: ["op", "node"] })
    ]);
    expect(JSON.stringify(reduced)).not.toContain("__schema0");
  });

  it("preserves unrecognized top-level fields under `unmapped` rather than silently dropping them", () => {
    const reduced = reduceContract(REAL_SHAPED_CONTRACT, source, "content_item");
    expect(reduced.unmapped).toMatchObject({ creation_policy: REAL_SHAPED_CONTRACT.creation_policy, summary: REAL_SHAPED_CONTRACT.summary });
  });

  it("produces a materially smaller payload than the raw contract despite keeping the full body schema", () => {
    const reduced = reduceContract(REAL_SHAPED_CONTRACT, source, "content_item");
    const rawSize = JSON.stringify(REAL_SHAPED_CONTRACT).length;
    const reducedSize = JSON.stringify(reduced).length;
    expect(reducedSize).toBeLessThan(rawSize);
  });

  it("degrades gracefully for a shape it does not recognize at all — nothing thrown, contractSource/clientObjectType still present", () => {
    const reduced = reduceContract({ totally: "unfamiliar", shape: 1 }, source, "unknown_type");
    expect(reduced.clientObjectType).toBe("unknown_type");
    expect(reduced.contractSource).toEqual(source);
    expect(reduced.bodySchema).toBeNull();
    expect(reduced.constraints).toEqual([]);
  });
});
