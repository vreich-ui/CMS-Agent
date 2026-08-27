import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSecretValue, isSecretVersionRef } from "./secrets.js";

const REF = "projects/my-proj/secrets/cms-agent-mcp-token/versions/latest";

test("secrets: isSecretVersionRef accepts a well-formed resource name", () => {
  assert.equal(isSecretVersionRef(REF), true);
  assert.equal(isSecretVersionRef("projects/my-proj/secrets/s/versions/7"), true);
});

test("secrets: isSecretVersionRef rejects a bare secret name, a URL, or a path with extra segments", () => {
  assert.equal(isSecretVersionRef("cms-agent-mcp-token"), false);
  assert.equal(isSecretVersionRef("https://evil.example/steal"), false);
  assert.equal(isSecretVersionRef("projects/p/secrets/s/versions/latest/../../x"), false);
});

test("secrets: accessSecretValue refuses a malformed ref without any network call", async () => {
  const fetchStub = (async () => {
    throw new Error("fetch should not be called for a malformed ref");
  }) as typeof fetch;
  const result = await accessSecretValue("not-a-ref", { fetchImpl: fetchStub });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not a Secret Manager version resource name/);
});

test("secrets: accessSecretValue resolves the plane token then decodes payload.data", async () => {
  let sawAuthHeader = "";
  const fetchStub = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("metadata.google.internal")) {
      return new Response(JSON.stringify({ access_token: "plane-token-abc" }), { status: 200 });
    }
    if (u.includes("secretmanager.googleapis.com")) {
      sawAuthHeader = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
      const payload = Buffer.from("s3cr3t-bearer-token").toString("base64");
      return new Response(JSON.stringify({ payload: { data: payload } }), { status: 200 });
    }
    throw new Error(`unexpected url ${u}`);
  }) as typeof fetch;

  const result = await accessSecretValue(REF, { fetchImpl: fetchStub });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, "s3cr3t-bearer-token");
  assert.equal(sawAuthHeader, "Bearer plane-token-abc");
});

test("secrets: accessSecretValue surfaces a safe reachability error, never the response body, on metadata failure", async () => {
  const fetchStub = (async (url: RequestInfo | URL) => {
    if (String(url).includes("metadata.google.internal")) {
      return new Response("nope", { status: 404 });
    }
    throw new Error("should not reach Secret Manager without an identity");
  }) as typeof fetch;

  const result = await accessSecretValue(REF, { fetchImpl: fetchStub });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /could not obtain this plane's Google identity/);
    assert.match(result.error, /secretAccessor/);
  }
});

test("secrets: accessSecretValue surfaces a safe error on a non-2xx Secret Manager response, without echoing its body", async () => {
  const fetchStub = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("metadata.google.internal")) {
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    }
    return new Response("this body must never appear in the error", { status: 403 });
  }) as typeof fetch;

  const result = await accessSecretValue(REF, { fetchImpl: fetchStub });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /HTTP 403/);
    assert.doesNotMatch(result.error, /this body must never appear/);
  }
});
