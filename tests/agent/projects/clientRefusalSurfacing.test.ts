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
import type { PublishExecutionContext } from "../../../src/agent/projects/projectHooks.js";

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

const REQUEST_ID = "req_publish_test_20260825_01";
const BODY = {
  schema_version: "client_object.v1",
  slug: "live-title",
  title: "Live Title",
  nodes: [{ id: "n_1", kind: "content", visibility: "public", public: { title: "Live Title", body: "Reader-facing body." } }]
};

// A publish context whose `call` answers each tool from a table. The default table is a healthy
// client; `refuseAt` swaps in the live refusal for exactly one tool.
const makeCtx = (opts: { refuseAt?: string; overrides?: Record<string, unknown>; objectDialect?: boolean } = {}) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
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
    if (opts.refuseAt === tool) return refusal(opts.overrides);
    return ok[tool] ?? { structuredContent: { ok: true } };
  };
  const ctx: PublishExecutionContext = {
    requestId: REQUEST_ID,
    envelope: { clientObjectType: "content_item", body: BODY },
    body: BODY,
    clientObjectType: "content_item",
    publishedTime: null,
    owner: { owner_id: "cms-agent", owner_label: "CMS-Agent Publishing Conductor" },
    ...(opts.objectDialect === false ? {} : { objectDialect: DR_LURIE_OBJECT_DIALECT }),
    call
  };
  return { ctx, calls };
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
