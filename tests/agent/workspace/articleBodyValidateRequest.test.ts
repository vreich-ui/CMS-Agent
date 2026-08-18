import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetValidateRequestShapeLog, validateClientObjectOnce } from "../../../src/agent/workspace/publishPayload.js";
import { promoteValidationUnavailableToBlocker } from "../../../src/agent/workspace/articleBodyValidation.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";

// S3 item 9 — the article_body validate request. Two engine-side defects made the client 400 the
// REQUEST before judging the body: the workspace-only `schema_version` marker inside a strict
// content_item body, and (historically) a missing object_type. The request must go out clean, a 400
// must be logged once with the payload preview, and an unavailable verdict must become a blocker.

const ENDPOINT = "https://dr-lurie.example/mcp";

describe("validateClientObjectOnce request shape", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;
  const requests: Array<{ name?: string; arguments?: Record<string, unknown> }> = [];
  let respondWith: () => unknown;

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    requests.length = 0;
    respondWith = () => ({ structuredContent: { valid: true, issues: [] } });
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (request.method === "tools/call") requests.push(request.params ?? {});
      const result = request.method === "tools/call" ? respondWith() : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
    __resetValidateRequestShapeLog();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("validates a candidate (no object_id) as {object_type, body} with schema_version stripped from the request", async () => {
    const body = { schema_version: "client_object.v1", slug: "hello", title: "Hello", nodes: [{ id: "n_a", kind: "content", public: { title: "A", body: "text" } }] };
    const result = await validateClientObjectOnce({ projectId: "dr-lurie", body, objectType: "content_item" }, { projectRepository: new MemoryProjectRepository() });
    expect(result.attempted).toBe(true);
    expect(result.valid).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.name).toBe("object_validate");
    const args = requests[0]!.arguments as { object_type: string; body: Record<string, unknown>; object_id?: unknown; candidate_patch?: unknown };
    expect(args.object_type).toBe("content_item");
    expect(args.object_id).toBeUndefined();
    expect(args.candidate_patch).toBeUndefined();
    expect(args.body).not.toHaveProperty("schema_version");
    expect(args.body.slug).toBe("hello");
    // The caller's body is untouched — only the wire request is stripped.
    expect(body.schema_version).toBe("client_object.v1");
  });

  it("logs a request-shape 400 once, with the argument keys and a bounded request preview, and reports attempted:false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    respondWith = () => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ statusCode: 400, error: "invalid_value at [\"object_type\"]" }) }], structuredContent: { statusCode: 400, error: "invalid_value at [\"object_type\"]" } });
    const body = { slug: "hello", nodes: [] };
    const first = await validateClientObjectOnce({ projectId: "dr-lurie", body, objectType: "content_item" }, { projectRepository: new MemoryProjectRepository() });
    const second = await validateClientObjectOnce({ projectId: "dr-lurie", body, objectType: "content_item" }, { projectRepository: new MemoryProjectRepository() });
    expect(first.attempted).toBe(false);
    expect(first.error).toMatch(/HTTP 400/);
    expect(second.attempted).toBe(false);
    const lines = warn.mock.calls.filter((call) => call[0] === "article_body.object_validate_request_rejected");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(String(lines[0]![1])) as { argumentKeys: string[]; request: string; rejection: string };
    expect(payload.argumentKeys).toEqual(["object_type", "body"]);
    expect(payload.request).toContain("\"slug\":\"hello\"");
    expect(payload.rejection).toContain("object_type");
  });
});

describe("promoteValidationUnavailableToBlocker", () => {
  it("turns article_body_validation_unavailable warnings into blockers on the output, deduplicated, copy-on-write", () => {
    const output = { artifact: "client_object.v1", body: {}, blockers: ["something else"] };
    const promoted = promoteValidationUnavailableToBlocker(output, ["article_body_validation_unavailable:connect ECONNREFUSED", "other_warning"]) as { blockers: string[] };
    expect(promoted.blockers).toEqual(["something else", "article_body_validation_unavailable:connect ECONNREFUSED"]);
    expect(output.blockers).toEqual(["something else"]);
    // Idempotent: promoting the same warning twice adds nothing.
    expect(promoteValidationUnavailableToBlocker(promoted, ["article_body_validation_unavailable:connect ECONNREFUSED"])).toBe(promoted);
  });
  it("leaves the output untouched when no such warning exists", () => {
    const output = { artifact: "client_object.v1", body: {} };
    expect(promoteValidationUnavailableToBlocker(output, ["article_body_validation_invalid"])).toBe(output);
  });
});
