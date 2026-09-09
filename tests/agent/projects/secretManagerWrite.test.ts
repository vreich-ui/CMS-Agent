import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSecretCachesForTesting, accessSecretValue, createSecretVersion } from "../../../src/agent/projects/secretManager.js";

// G1 ACCEPTANCE (write half). The module's standing rule is that a failure string names REACHABILITY
// or PERMISSION and never content; these tests hold the write path to it, and to the two behaviours
// that make re-running genesis safe: the secret is created at most once, and every run adds a version
// rather than colliding.
//
// Injecting fetchImpl selects the metadata/REST identity path deliberately — see the module header.
// No test here may reach the ambient credentials of the machine it runs on.

const METADATA_TOKEN = { access_token: "plane-access-token", expires_in: 3600 } as const;

const response = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

/** A fetch stub that answers the metadata server, then hands each Secret Manager call to `plan`. */
const stubFetch = (plan: (url: string, init?: RequestInit) => Response) => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("computeMetadata")) return response(200, METADATA_TOKEN);
    calls.push({ url: href, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return plan(href, init);
  });
  return { impl: impl as unknown as typeof fetch, calls };
};

const env = {} as NodeJS.ProcessEnv;

describe("G1 — createSecretVersion", () => {
  beforeEach(() => __resetSecretCachesForTesting());

  it("creates the secret, adds the version, and returns the ...versions/latest reference", async () => {
    const { impl, calls } = stubFetch((url) =>
      url.endsWith(":addVersion")
        ? response(200, { name: "projects/cms-agent-503015/secrets/acme-mcp-token/versions/1" })
        : response(200, { name: "projects/cms-agent-503015/secrets/acme-mcp-token" })
    );

    const result = await createSecretVersion(
      { projectId: "cms-agent-503015", secretId: "acme-mcp-token", value: "s3cret" },
      { fetchImpl: impl, env }
    );

    expect(result).toMatchObject({
      ok: true,
      // `latest`, not the pinned version: a rotation then takes effect with no registry write.
      ref: "projects/cms-agent-503015/secrets/acme-mcp-token/versions/latest",
      versionName: "projects/cms-agent-503015/secrets/acme-mcp-token/versions/1",
      secretCreated: true
    });
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
    // The value travels base64 in the payload and nowhere else.
    expect((calls[1].body as { payload: { data: string } }).payload.data).toBe(Buffer.from("s3cret", "utf8").toString("base64"));
  });

  it("treats an existing secret (409) as the normal re-mint path and still adds a version", async () => {
    const { impl } = stubFetch((url) =>
      url.endsWith(":addVersion")
        ? response(200, { name: "projects/p-acme-x/secrets/acme-mcp-token/versions/7" })
        : response(409, { error: { status: "ALREADY_EXISTS" } })
    );

    const result = await createSecretVersion({ projectId: "p-acme-x", secretId: "acme-mcp-token", value: "next" }, { fetchImpl: impl, env });
    expect(result).toMatchObject({ ok: true, secretCreated: false, versionName: "projects/p-acme-x/secrets/acme-mcp-token/versions/7" });
  });

  it("names the missing PERMISSION, never the value, when Secret Manager refuses", async () => {
    const { impl } = stubFetch(() => response(403, { error: { message: "caller lacks permission" } }));
    const result = await createSecretVersion({ projectId: "cms-agent-503015", secretId: "acme-mcp-token", value: "s3cret" }, { fetchImpl: impl, env });

    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain("HTTP 403");
    expect(error).toContain("secretmanager.secrets.create");
    expect(error).not.toContain("s3cret");
  });

  it("refuses a malformed project id, secret id or empty value before making any call", async () => {
    const { impl, calls } = stubFetch(() => response(200, {}));
    expect(await createSecretVersion({ projectId: "Bad Project", secretId: "ok", value: "v" }, { fetchImpl: impl, env })).toMatchObject({ ok: false });
    expect(await createSecretVersion({ projectId: "cms-agent-503015", secretId: "bad/id", value: "v" }, { fetchImpl: impl, env })).toMatchObject({ ok: false });
    expect(await createSecretVersion({ projectId: "cms-agent-503015", secretId: "ok", value: "   " }, { fetchImpl: impl, env })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("invalidates the read cache for the ref it just wrote", async () => {
    // Without this, a re-mint inside one process (two genesis runs, or the reconciler) would keep
    // handing out the superseded value for the whole cache TTL.
    const reads = stubFetch(() => response(200, { payload: { data: Buffer.from("old-value").toString("base64") } }));
    const ref = "projects/cms-agent-503015/secrets/acme-mcp-token/versions/latest";
    expect(await accessSecretValue(ref, { fetchImpl: reads.impl, env })).toEqual({ ok: true, value: "old-value" });

    const writes = stubFetch((url) =>
      url.endsWith(":addVersion") ? response(200, { name: `${ref.replace("/versions/latest", "")}/versions/2` }) : response(409, {})
    );
    await createSecretVersion({ projectId: "cms-agent-503015", secretId: "acme-mcp-token", value: "new-value" }, { fetchImpl: writes.impl, env });

    const after = stubFetch(() => response(200, { payload: { data: Buffer.from("new-value").toString("base64") } }));
    expect(await accessSecretValue(ref, { fetchImpl: after.impl, env })).toEqual({ ok: true, value: "new-value" });
  });
});
