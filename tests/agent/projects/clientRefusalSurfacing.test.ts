import { describe, expect, it, vi } from "vitest";
import {
  ClientToolRefusalError,
  checkedClientCall,
  describeClientIssues,
  describeMcpErrorResult,
  isMcpErrorResult,
  readClientIssues,
  readClientStatusCode,
  requireClientToolOk
} from "../../../src/agent/projects/clientToolResult.js";
import { drLurieProjectHooks } from "../../../src/agent/projects/drLurie/hooks.js";
import { platformProjectHooks } from "../../../src/agent/projects/platform/hooks.js";
import { DR_LURIE_OBJECT_DIALECT } from "../../../src/agent/projects/drLurie/definition.js";
import { PLATFORM_OBJECT_DIALECT } from "../../../src/agent/projects/platform/definition.js";
import type { ProjectObjectDialect } from "../../../src/agent/projects/projectTypes.js";
import type { PublishExecutionContext, PublishObjectOrigin } from "../../../src/agent/projects/projectHooks.js";

// -------------------------------------------------------------------------------------------------
// The failure this file exists to prevent. Publish run run_1787656120374_18bobg (dr-lurie) reported
//   error: "create_missing_object_id: could not resolve the object id (object_id/id) from the
//           object_create result."
//   steps: [{ tool: "object_create", ok: true }]
// and object_inventory for content_item then proved NO object had been created (13 objects, all
// genuine articles, newest 2026-08-13, no locks held). The client had REFUSED object_create and said
// exactly why; the hook never checked isError, so the refusal fell through to findObjectId and was
// re-reported as an unfamiliar response SHAPE. This is the client's actual answer.
const CLIENT_REFUSAL_MESSAGE = "Invalid request fields.";
const CLIENT_REFUSAL_ISSUE_TEXT = "Invalid option: expected one of \"article\"|\"page\"|\"product\"";
const refusal = (overrides: Record<string, unknown> = {}) => ({
  isError: true,
  content: [{ type: "text", text: CLIENT_REFUSAL_MESSAGE }],
  structuredContent: {
    error: CLIENT_REFUSAL_MESSAGE,
    statusCode: 400,
    issues: [{ path: ["object_type"], message: CLIENT_REFUSAL_ISSUE_TEXT }],
    ...overrides
  }
});

// -------------------------------------------------------------------------------------------------
// The SECOND live failure, 2026-08-27. Run run_1787862284296_x53xz0 (dr-lurie) got through
// object_create — which SUCCEEDED, minting the object — and died at object_checkout
// (publish_partial_client_writes: 2, "Nothing was published"). The run held no record of the object,
// because the hook only ever returns the id on the SUCCESS path, so every
// `workflow_retry_node publish_executor` after that called object_create again and got this:
const ALREADY_EXISTS_MESSAGE = "Object already exists";
const alreadyExists = (statusCode = 409, message = ALREADY_EXISTS_MESSAGE) => ({
  isError: true,
  content: [{ type: "text", text: message }],
  structuredContent: { error: message, statusCode }
});

const REQUEST_ID = "req_publish_test_20260825_01";
const BODY = {
  schema_version: "client_object.v1",
  slug: "live-title",
  title: "Live Title",
  nodes: [{ id: "n_1", kind: "content", visibility: "public", public: { title: "Live Title", body: "Reader-facing body." } }]
};

// A publish context whose `call` answers each tool from a table. The default table is a healthy
// client; `refuseAt` swaps in the live refusal for exactly one tool.
const makeCtx = (opts: { refuseAt?: string; overrides?: Record<string, unknown>; objectDialect?: boolean; dialect?: ProjectObjectDialect; refusalResult?: unknown } = {}) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  // Everything the hook handed back through ctx.noteObjectId, in order. This is the seam that keeps a
  // created object id from dying with the throw.
  const notes: Array<{ objectId: string; origin: PublishObjectOrigin }> = [];
  const ok: Record<string, unknown> = {
    object_create: { structuredContent: { object_id: REQUEST_ID } },
    object_checkout: { structuredContent: { lock_token: "lock_123", record_version: 2 } },
    object_validate: { structuredContent: { valid: true, issues: [] } },
    object_patch: { structuredContent: { ok: true } },
    object_publish: { structuredContent: { ok: true, commit: "abc123def" } },
    object_checkin: { structuredContent: { ok: true } }
  };
  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ tool, args });
    if (opts.refuseAt === tool) return opts.refusalResult ?? refusal(opts.overrides);
    return ok[tool] ?? { structuredContent: { ok: true } };
  };
  const ctx: PublishExecutionContext = {
    requestId: REQUEST_ID,
    envelope: { clientObjectType: "content_item", body: BODY },
    body: BODY,
    clientObjectType: "content_item",
    publishedTime: null,
    owner: { owner_id: "cms-agent", owner_label: "CMS-Agent Publishing Conductor" },
    ...(opts.objectDialect === false ? {} : { objectDialect: opts.dialect ?? DR_LURIE_OBJECT_DIALECT }),
    noteObjectId: (note) => { notes.push(note); },
    call
  };
  return { ctx, calls, notes };
};

const PUBLISH_STEPS = ["object_create", "object_checkout", "object_validate", "object_patch", "object_publish"];

describe("clientToolResult — a refusal keeps the client's own sentence", () => {
  it("recognises an MCP error result and passes anything else straight through", () => {
    expect(isMcpErrorResult(refusal())).toBe(true);
    expect(isMcpErrorResult({ structuredContent: { object_id: "x" } })).toBe(false);
    expect(isMcpErrorResult(undefined)).toBe(false);
    const healthy = { structuredContent: { object_id: "x" } };
    expect(requireClientToolOk("object_create", healthy)).toBe(healthy);
  });

  it("carries the message VERBATIM, plus the statusCode and issues the client supplied", () => {
    const error = (() => {
      try {
        requireClientToolOk("object_create", refusal());
        return undefined;
      } catch (thrown) {
        return thrown as ClientToolRefusalError;
      }
    })();
    expect(error).toBeInstanceOf(ClientToolRefusalError);
    expect(error!.tool).toBe("object_create");
    expect(error!.code).toBe("client_refused");
    expect(error!.statusCode).toBe(400);
    expect(error!.issues).toEqual([{ path: ["object_type"], message: CLIENT_REFUSAL_ISSUE_TEXT }]);
    // Verbatim: the client's sentence appears unedited, and so does its issue text.
    expect(error!.clientError).toContain(CLIENT_REFUSAL_MESSAGE);
    expect(error!.clientError).toContain(`object_type: ${CLIENT_REFUSAL_ISSUE_TEXT}`);
    expect(error!.clientError).toBe(`status 400: ${CLIENT_REFUSAL_MESSAGE} (issues: object_type: ${CLIENT_REFUSAL_ISSUE_TEXT})`);
    expect(error!.message).toBe(`object_create_refused: ${error!.clientError}`);
  });

  it("reads statusCode/issues out of a nested error object too", () => {
    const nested = { isError: true, structuredContent: { statusCode: 409, error: { message: "object is checked out by another owner", issues: ["lock held by editor@dr-lurie"] } } };
    expect(readClientStatusCode(nested)).toBe(409);
    expect(readClientIssues(nested)).toEqual(["lock held by editor@dr-lurie"]);
    expect(describeMcpErrorResult(nested)).toBe("status 409: object is checked out by another owner");
  });

  it("redacts credential-shaped runs and bounds issue text — quoted, never trusted", () => {
    const detail = describeClientIssues([{ path: ["auth"], message: "rejected Authorization: Bearer nfp_radioactive_do_not_persist\nretry" }]);
    expect(detail).not.toContain("nfp_radioactive_do_not_persist");
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain("\n");
    expect(describeClientIssues([{ path: ["x"], message: "y".repeat(5000) }]).length).toBeLessThanOrEqual(301);
    expect(describeClientIssues([])).toBe("");
  });

  it("checks every call routed through it", async () => {
    const seen: string[] = [];
    const call = checkedClientCall(async (tool) => {
      seen.push(tool);
      return tool === "object_patch" ? refusal() : { structuredContent: { ok: true } };
    });
    await expect(call("object_checkout", {})).resolves.toEqual({ structuredContent: { ok: true } });
    await expect(call("object_patch", {})).rejects.toThrow(/^object_patch_refused: status 400: Invalid request fields\./);
    expect(seen).toEqual(["object_checkout", "object_patch"]);
  });
});

// Both object-native tenants speak the same six-verb dialect, so the same table drives both. Platform
// ignores ctx.objectDialect (its ids are server-minted); dr-lurie refuses without one.
describe.each([
  { name: "dr-lurie", hooks: drLurieProjectHooks },
  { name: "platform", hooks: platformProjectHooks }
])("$name executePublish surfaces a client refusal at every step", ({ hooks }) => {
  const ctxFor = (opts: { refuseAt?: string; overrides?: Record<string, unknown> } = {}) => makeCtx(opts);

  // -----------------------------------------------------------------------------------------------
  // Regression: run_1787862284296_x53xz0 (dr-lurie, 2026-08-27) stopped at object_checkout with
  //   status 400: Invalid request fields.
  //   (issues: object_type: Invalid option: expected one of "page"|"section"|...|"content_item")
  // object_create had already SUCCEEDED, so the run left a created-but-unpublished object behind
  // (publish_partial_client_writes:2). The cause was not the payload: `object_type` is REQUIRED by
  // every object verb on the client (checkout, validate, patch, publish_by_time, checkin — see
  // objectVerbRequestSchema), and both hooks passed it on object_create ONLY. `...ctx.owner` spreads
  // { owner_id, owner_label } and carries no type, so checkout arrived without one and Zod rejected
  // it against the enum. Publishing could never complete past step 2 through this dialect.
  it("passes object_type on EVERY verb, not just object_create", async () => {
    const { ctx, calls } = ctxFor();
    await hooks.executePublish!(ctx);
    expect(calls.length).toBeGreaterThan(0);
    for (const entry of calls) {
      expect(entry.args.object_type, `${entry.tool} must carry object_type`).toBe("content_item");
    }
    // The whole sequence ran — a hook that stopped early would pass the loop above vacuously.
    expect(calls.map((entry) => entry.tool)).toEqual([...PUBLISH_STEPS, "object_checkin"]);
  });

  it.each(PUBLISH_STEPS)("names %s and quotes the client verbatim", async (tool) => {
    const { ctx, calls } = ctxFor({ refuseAt: tool });
    const error = await hooks.executePublish!(ctx).then(() => undefined, (thrown) => thrown as ClientToolRefusalError);
    expect(error).toBeInstanceOf(ClientToolRefusalError);
    expect(error!.tool).toBe(tool);
    expect(error!.clientError).toContain(CLIENT_REFUSAL_MESSAGE);
    expect(error!.clientError).toContain(CLIENT_REFUSAL_ISSUE_TEXT);
    expect(error!.statusCode).toBe(400);
    expect(error!.message.startsWith(`${tool}_refused:`)).toBe(true);
    // The refusal stops the sequence where it happened: nothing after the refused tool was called.
    expect(calls.at(-1)!.tool).toBe(tool);
    // ...and it is never re-reported as one of the "the response had no <field>" errors.
    expect(error!.message).not.toContain("create_missing_object_id");
    expect(error!.message).not.toContain("checkout_missing");
    expect(error!.message).not.toContain("object_validate_rejected");
  });

  it("keeps a refused object_checkin non-fatal but no longer silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { ctx, calls } = ctxFor({ refuseAt: "object_checkin" });
    const outcome = await hooks.executePublish!(ctx);
    // The export is already committed; a lock that fails to release expires on its own.
    expect(outcome.objectId).toBe(REQUEST_ID);
    expect(calls.map((entry) => entry.tool)).toEqual([...PUBLISH_STEPS, "object_checkin"]);
    const [label, payload] = warn.mock.calls.at(-1)!;
    expect(String(label)).toContain("object_checkin_refused");
    expect(String(payload)).toContain(CLIENT_REFUSAL_MESSAGE);
    // The lock token is a capability and is never logged.
    expect(String(payload)).not.toContain("lock_123");
    warn.mockRestore();
  });

  it("still raises create_missing_object_id for its REAL meaning: a success carrying no id", async () => {
    const { ctx } = ctxFor();
    // A genuine success (no isError) whose payload simply has no id.
    ctx.call = async (tool: string) => (tool === "object_create" ? { structuredContent: { created: true } } : { structuredContent: { lock_token: "lock_123", record_version: 2, valid: true, issues: [] } });
    await expect(hooks.executePublish!(ctx)).rejects.toThrow(/^create_missing_object_id: object_create returned a SUCCESS result/);
  });

  it("leaves a healthy publish completely unaffected", async () => {
    const { ctx, calls } = ctxFor();
    const outcome = await hooks.executePublish!(ctx);
    expect(calls.map((entry) => entry.tool)).toEqual([...PUBLISH_STEPS, "object_checkin"]);
    expect(outcome.objectId).toBe(REQUEST_ID);
    expect(outcome.clientValidation).toMatchObject({ tool: "object_validate", valid: true, issues: [] });
    expect(outcome.result).toMatchObject({ structuredContent: { ok: true, commit: "abc123def" } });
  });

  it("skips object_create for a conductor-created shell and still checks the rest", async () => {
    const { ctx, calls } = ctxFor({ refuseAt: "object_checkout" });
    const withShell: PublishExecutionContext = { ...ctx, existingObjectId: "obj_existing_1" };
    const error = await hooks.executePublish!(withShell).then(() => undefined, (thrown) => thrown as ClientToolRefusalError);
    expect(error).toBeInstanceOf(ClientToolRefusalError);
    expect(error!.tool).toBe("object_checkout");
    expect(calls.map((entry) => entry.tool)).toEqual(["object_checkout"]);
  });
});

// -------------------------------------------------------------------------------------------------
// Dr. Lurie's object_validate has a second reader (parseValidateResult) that a refusal used to reach.
// "The client would not judge this candidate" and "the client judged it invalid" are different facts,
// and only the second is a verdict about the body.
describe("a refused object_validate is not a validation verdict", () => {
  it("does not become object_validate_rejected", async () => {
    const { ctx } = makeCtx({ refuseAt: "object_validate" });
    const error = await drLurieProjectHooks.executePublish!(ctx).then(() => undefined, (thrown) => thrown as Error);
    expect(error!.message).toContain("object_validate_refused");
    expect(error!.message).not.toContain("object_validate_rejected");
  });

  it("still reports a genuine invalid verdict as object_validate_rejected", async () => {
    const { ctx } = makeCtx();
    ctx.call = async (tool: string) => {
      if (tool === "object_create") return { structuredContent: { object_id: REQUEST_ID } };
      if (tool === "object_checkout") return { structuredContent: { lock_token: "lock_123", record_version: 2 } };
      if (tool === "object_validate") return { structuredContent: { valid: false, issues: ["taxonomy term \"longevity\" does not resolve"] } };
      return { structuredContent: { ok: true } };
    };
    await expect(drLurieProjectHooks.executePublish!(ctx)).rejects.toThrow(/^object_validate_rejected: .*longevity/);
  });
});

// -------------------------------------------------------------------------------------------------
// RE-ENTRY AFTER A PARTIAL CLIENT WRITE (2026-08-27, run_1787862284296_x53xz0).
//
// object_create SUCCEEDED — the object was minted — and object_checkout then refused. The hook threw
// before it could return the id, so the run recorded none, and the retry re-created:
//   status 409: Object already exists
// …which 409'd forever. The article had to be published by hand through the tenant's verbs, out of
// band, leaving the run reading `publish_executor: blocked` for a live article.
//
// The two halves of the fix, tested here: the 409 is ADOPTED when (and only when) the dialect mints
// the object id from the request id, and the id is handed to the run through ctx.noteObjectId the
// moment it is known — never only on the success path.
describe("a re-entered publish adopts the object its own request id already names", () => {
  const warnSpy = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

  it("does NOT throw on a 409 already-exists: it skips creating and re-enters at object_checkout", async () => {
    const warn = warnSpy();
    const { ctx, calls, notes } = makeCtx({ refuseAt: "object_create", refusalResult: alreadyExists() });
    const outcome = await drLurieProjectHooks.executePublish!(ctx);

    // The sequence continued from checkout and published, exactly as a first attempt would have.
    expect(calls.map((entry) => entry.tool)).toEqual([...PUBLISH_STEPS, "object_checkin"]);
    expect(outcome.objectId).toBe(REQUEST_ID);
    expect(outcome.objectOrigin).toBe("adopted_existing");
    expect(outcome.clientValidation).toMatchObject({ tool: "object_validate", valid: true });

    // The adopted id is the id the create REQUESTED — never one read back out of an error.
    expect(calls[0]!.args.requested_id).toBe(REQUEST_ID);
    for (const entry of calls.slice(1)) expect(entry.args.object_id, `${entry.tool} must address the adopted object`).toBe(REQUEST_ID);

    // Adoption is recorded, not silent: the run log names it and the outcome carries its origin.
    expect(notes).toEqual([{ objectId: REQUEST_ID, origin: "adopted_existing" }]);
    const [label, payload] = warn.mock.calls.at(-1)!;
    expect(String(label)).toContain("object_create_adopted_existing");
    expect(String(payload)).toContain(ALREADY_EXISTS_MESSAGE);
    expect(String(payload)).toContain(REQUEST_ID);
    warn.mockRestore();
  });

  // The guard, from both sides. A 409 on a server-minted dialect identifies NO object — we never told
  // the server which id to use — so there is nothing this run could safely adopt.
  it("never adopts on a dialect whose ids are server-minted", async () => {
    const platformCtx = makeCtx({ refuseAt: "object_create", refusalResult: alreadyExists(), dialect: PLATFORM_OBJECT_DIALECT });
    const platformError = await platformProjectHooks.executePublish!(platformCtx.ctx).then(() => undefined, (thrown) => thrown as ClientToolRefusalError);
    expect(platformError).toBeInstanceOf(ClientToolRefusalError);
    expect(platformError!.tool).toBe("object_create");
    expect(platformError!.statusCode).toBe(409);
    expect(platformCtx.calls.map((entry) => entry.tool)).toEqual(["object_create"]);
    expect(platformCtx.notes).toEqual([]);

    // …and it is the DIALECT that decides, not which hook is running: dr-lurie's own hook refuses just
    // as hard when handed a server-minted dialect.
    const serverMinted: ProjectObjectDialect = { ...DR_LURIE_OBJECT_DIALECT, objectIdSource: "server_minted" };
    const drLurieCtx = makeCtx({ refuseAt: "object_create", refusalResult: alreadyExists(), dialect: serverMinted });
    await expect(drLurieProjectHooks.executePublish!(drLurieCtx.ctx)).rejects.toThrow(/^object_create_refused: status 409: Object already exists/);
    expect(drLurieCtx.calls.map((entry) => entry.tool)).toEqual(["object_create"]);
  });

  // Only a GENUINE already-exists refusal is adopted: status 409 AND the client's own sentence. This
  // substrate answers 409 for other facts too (duplicate_target, blind_revert_refused, a
  // record-version conflict), and "already exists" appears in prose that is not a 409.
  it.each([
    { name: "a 400 that merely says already exists", result: alreadyExists(400) },
    { name: "a 409 that is a different conflict", result: alreadyExists(409, "blind_revert_refused: guard.expected is stale") },
    { name: "the live 400 invalid-fields refusal", result: undefined }
  ])("still throws for $name", async ({ result }) => {
    const { ctx, calls, notes } = makeCtx({ refuseAt: "object_create", ...(result ? { refusalResult: result } : {}) });
    const error = await drLurieProjectHooks.executePublish!(ctx).then(() => undefined, (thrown) => thrown as ClientToolRefusalError);
    expect(error).toBeInstanceOf(ClientToolRefusalError);
    expect(error!.tool).toBe("object_create");
    // Nothing after the refused create was attempted, and no object was adopted.
    expect(calls.map((entry) => entry.tool)).toEqual(["object_create"]);
    expect(notes).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// PART 2 — the id must survive the throw. The hook hands it over the MOMENT it resolves one, so the
// blocked record the executor writes can name the object a failed publish left behind. (The record
// end of this seam is asserted in ../workspace/publishRefusalBlocker.test.ts.)
describe.each([
  { name: "dr-lurie", hooks: drLurieProjectHooks, dialect: DR_LURIE_OBJECT_DIALECT },
  { name: "platform", hooks: platformProjectHooks, dialect: PLATFORM_OBJECT_DIALECT }
])("$name hands the created object id back before any step that can throw", ({ hooks, dialect }) => {
  it.each(["object_checkout", "object_validate", "object_patch", "object_publish"])("still names the object when %s refuses", async (tool) => {
    const { ctx, calls, notes } = makeCtx({ refuseAt: tool, dialect });
    await expect(hooks.executePublish!(ctx)).rejects.toThrow(new RegExp(`^${tool}_refused:`));
    // object_create landed — this run mutated the client — and the id is in hand despite the throw.
    expect(calls[0]!.tool).toBe("object_create");
    expect(notes).toEqual([{ objectId: REQUEST_ID, origin: "created" }]);
  });

  it("names the conductor's shell as the origin when it did not create one", async () => {
    const { ctx, calls, notes } = makeCtx({ refuseAt: "object_checkout", dialect });
    await expect(hooks.executePublish!({ ...ctx, existingObjectId: "obj_existing_1" })).rejects.toThrow(/^object_checkout_refused:/);
    expect(calls.map((entry) => entry.tool)).toEqual(["object_checkout"]);
    expect(notes).toEqual([{ objectId: "obj_existing_1", origin: "conductor_shell" }]);
  });
});

// -------------------------------------------------------------------------------------------------
// The happy path is the control: adoption must be invisible to a clean run. Every argument of every
// call is pinned here, so a future re-entry change that alters a first attempt's wire traffic fails.
describe("a clean publish is byte-for-byte what it always was", () => {
  it("calls the same six tools with the same arguments", async () => {
    const { ctx, calls, notes } = makeCtx();
    const outcome = await drLurieProjectHooks.executePublish!(ctx);
    const patch = [
      { op: "set_article_meta", fields: { slug: "live-title", title: "Live Title" } },
      { op: "upsert_node", node: BODY.nodes[0] }
    ];
    expect(calls).toEqual([
      { tool: "object_create", args: { object_type: "content_item", site: "site_drlurie", body: { slug: "live-title", title: "Live Title", nodes: BODY.nodes }, requested_id: REQUEST_ID } },
      { tool: "object_checkout", args: { object_type: "content_item", object_id: REQUEST_ID, owner_id: "cms-agent", owner_label: "CMS-Agent Publishing Conductor" } },
      { tool: "object_validate", args: { object_type: "content_item", object_id: REQUEST_ID, candidate_patch: patch } },
      { tool: "object_patch", args: { object_type: "content_item", object_id: REQUEST_ID, lock_token: "lock_123", expected_record_version: 2, patch } },
      { tool: "object_publish", args: { object_type: "content_item", object_id: REQUEST_ID, lock_token: "lock_123" } },
      { tool: "object_checkin", args: { object_type: "content_item", object_id: REQUEST_ID, lock_token: "lock_123" } }
    ]);
    // `schema_version` never crosses the wire, and the create is a create — not an adoption.
    expect(JSON.stringify(calls)).not.toContain("client_object.v1");
    expect(outcome.objectOrigin).toBe("created");
    expect(notes).toEqual([{ objectId: REQUEST_ID, origin: "created" }]);
  });
});
