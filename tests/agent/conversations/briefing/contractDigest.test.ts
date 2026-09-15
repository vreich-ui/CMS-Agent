import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_DIGEST_LINES_PER_TYPE,
  __resetContractDigestCacheForTests,
  dialectObjectTypes,
  renderContractDigest
} from "../../../../src/agent/conversations/briefing/contractDigest.js";
import type { ReducedContract } from "../../../../src/agent/workspace/contractReduction.js";

const baseContract = (overrides: Partial<ReducedContract> = {}): ReducedContract => ({
  clientObjectType: "content_item",
  bodySchema: { type: "object" },
  idConventions: [],
  mediaConvention: { policy: {}, notes: [] },
  taxonomy: { notes: [], blockingConstraints: [] },
  constraints: [],
  publishPolicy: undefined,
  workflowSequence: [],
  validationSurface: [],
  contractSource: { tool: "object_contract", fetchedAtISO: "2026-09-15T00:00:00.000Z", fingerprint: "fp1" },
  ...overrides
});

describe("contractDigest — the per-object-type digest a writer verifies against", () => {
  beforeEach(() => {
    __resetContractDigestCacheForTests();
  });

  // The ops list is what tells a writer which verbs exist and which fields each requires — the exact
  // fact rev 8 used to send it back to object_contract to relearn every turn.
  it("names the ops with their required fields", () => {
    const digest = renderContractDigest(baseContract({
      validationSurface: [
        { op: "create", requiredFields: ["title", "body"] },
        { op: "patch", requiredFields: [] }
      ]
    }));
    expect(digest).toContain("Ops: create(title, body) · patch");
  });

  // The workflow order tells a writer which op has to run before which — a fact the digest exists to
  // carry so the model never has to discover it by trial and error.
  it("names the workflow order", () => {
    const digest = renderContractDigest(baseContract({ workflowSequence: ["draft", "review", "publish"] }));
    expect(digest).toContain("Workflow order: draft → review → publish. Follow it in this order.");
  });

  // Server-minted ids are the classic refusal this digest exists to prevent: sending one back on a
  // create is rejected by the tenant, and the digest must say, by name, which ids those are.
  it("names the server-minted ids to omit from a create", () => {
    const digest = renderContractDigest(baseContract({ idConventions: [{ id: "site" }, { id: "content_id" }] }));
    expect(digest).toContain("Server-minted ids — omit them from a create: site, content_id");
  });

  // Write-blocking constraints and the publish-policy line are two DIFFERENT refusals (a write is not
  // a publish); the digest keeps them as separate bullets rather than folding one into the other.
  it("separates write-blocking constraints from the publish-policy line", () => {
    const digest = renderContractDigest(baseContract({
      constraints: [
        { id: "id_object", severity: "error", note: "must match the request-id shape" },
        { id: "editorial_advisory", severity: "warning" }
      ],
      publishPolicy: { requiresApproval: true }
    }));
    expect(digest).toContain("Blocks a write: id_object — must match the request-id shape");
    expect(digest).not.toContain("Blocks a write: editorial_advisory");
    expect(digest).toContain('Blocks a publish: {"requiresApproval":true}');
  });

  // Severity is carried verbatim, never re-graded: enforcedLive:true blocks a write even without
  // severity:"error", and a plain "warning" with neither flag never blocks one.
  it("blocks a write on enforcedLive:true even when severity is not 'error'", () => {
    const digest = renderContractDigest(baseContract({
      constraints: [{ id: "live_enforced", severity: "advisory", enforcedLive: true }]
    }));
    expect(digest).toContain("Blocks a write: live_enforced");
  });

  // More than 4 blocking constraints get summarised rather than listed in full — the digest's own
  // internal bound on how much of a tenant's constraint list to spell out per turn.
  it("summarises beyond the first 4 blocking constraints rather than listing every one", () => {
    const constraints = Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, severity: "error" }));
    const digest = renderContractDigest(baseContract({ constraints }));
    for (let index = 0; index < 4; index += 1) expect(digest).toContain(`Blocks a write: c${index}`);
    expect(digest).not.toContain("Blocks a write: c4");
    expect(digest).not.toContain("Blocks a write: c5");
    expect(digest).toContain("…and 2 further blocking constraints; dry-run rather than guessing which one applies.");
  });

  // The plan's ceiling: no matter how large a tenant's contract grows, the digest stays a bounded
  // number of body lines a reader can hold in their head.
  it("never emits more than MAX_DIGEST_LINES_PER_TYPE body lines", () => {
    const constraints = Array.from({ length: 40 }, (_, index) => ({ id: `c${index}`, severity: "error" }));
    const digest = renderContractDigest(baseContract({
      validationSurface: [{ op: "create", requiredFields: ["title"] }],
      workflowSequence: ["draft", "publish"],
      idConventions: [{ id: "site" }],
      constraints,
      taxonomy: { notes: [], blockingConstraints: [{ id: "tax1" }] },
      publishPolicy: { requiresApproval: true }
    }));
    const bodyLines = digest.split("\n").slice(1); // drop the `**type**` heading line
    expect(bodyLines.length).toBeLessThanOrEqual(MAX_DIGEST_LINES_PER_TYPE);
  });

  // A contract that declares nothing still renders a labelled line, never an empty digest that reads
  // to the model as "this type has no constraints" (which would be an invention).
  it("renders a named line rather than an empty digest when the contract declares nothing", () => {
    const digest = renderContractDigest(baseContract());
    expect(digest).toContain("This tenant's contract declares no ops, workflow or blocking constraints for this type");
  });

  // contractPrefetch.ts's own hard-won lesson: it once guessed "content_item" for a tenant with no
  // configured dialect and was accidentally right for one tenant. dialectObjectTypes must never repeat
  // that guess.
  it("returns no object types for a record with no objectDialect, never a guessed literal", () => {
    expect(dialectObjectTypes({})).toEqual([]);
    expect(dialectObjectTypes({ objectDialect: undefined })).toEqual([]);
  });

  it("returns no object types for an objectDialect that names none, even with other fields set", () => {
    expect(dialectObjectTypes({
      objectDialect: { siteObjectId: "site_x", taxonomyRegistryObjectId: "tax_x", objectIdSource: "server_minted" }
    })).toEqual([]);
  });

  // Every dialect-named type surfaces, and only the ones actually named on the record.
  it("returns every object type the dialect actually names", () => {
    expect(dialectObjectTypes({
      objectDialect: {
        siteObjectId: "site_x",
        taxonomyRegistryObjectId: "tax_x",
        objectIdSource: "request_id",
        defaultObjectType: "content_item",
        voiceObjectId: "voice_x",
        strategyObjectId: "strat_x"
      }
    })).toEqual(["content_item", "editorial_voice", "editorial_strategy"]);
  });
});
