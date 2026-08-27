import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { verifyIapJwt, __resetIapJwksCacheForTesting } from "./iap.js";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicJwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
const KID = "test-key-1";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(payload: Record<string, unknown>, opts: { alg?: string; kid?: string } = {}): string {
  const header = { alg: opts.alg ?? "ES256", kid: opts.kid ?? KID, typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function jwksFetchStub(keys: unknown[] = [{ ...publicJwk, kid: KID }]) {
  return (async () => new Response(JSON.stringify({ keys }), { status: 200 })) as typeof fetch;
}

function basePayload(overrides: Record<string, unknown> = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    iss: "https://cloud.google.com/iap",
    aud: "/projects/123/global/backendServices/456",
    iat: nowS - 5,
    exp: nowS + 3600,
    email: "wolf@example.com",
    sub: "accounts.google.com:1234567890",
    ...overrides,
  };
}

test("iap: accepts a validly signed, unexpired assertion and returns the email from its payload", async () => {
  __resetIapJwksCacheForTesting();
  const jwt = signJwt(basePayload());
  const result = await verifyIapJwt(jwt, "/projects/123/global/backendServices/456", {
    fetchImpl: jwksFetchStub(),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.email, "wolf@example.com");
});

test("iap: rejects when the audience does not match", async () => {
  __resetIapJwksCacheForTesting();
  const jwt = signJwt(basePayload());
  const result = await verifyIapJwt(jwt, "/projects/999/global/backendServices/999", {
    fetchImpl: jwksFetchStub(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /audience/);
});

test("iap: skips audience pinning when no expected audience is configured", async () => {
  __resetIapJwksCacheForTesting();
  const jwt = signJwt(basePayload());
  const result = await verifyIapJwt(jwt, undefined, { fetchImpl: jwksFetchStub() });
  assert.equal(result.ok, true);
});

test("iap: rejects an expired assertion", async () => {
  __resetIapJwksCacheForTesting();
  const nowS = Math.floor(Date.now() / 1000);
  const jwt = signJwt(basePayload({ exp: nowS - 3600, iat: nowS - 7200 }));
  const result = await verifyIapJwt(jwt, undefined, { fetchImpl: jwksFetchStub() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /expired/);
});

test("iap: rejects a tampered payload (signature no longer matches)", async () => {
  __resetIapJwksCacheForTesting();
  const jwt = signJwt(basePayload());
  const [h, p, s] = jwt.split(".");
  const tamperedPayload = JSON.parse(Buffer.from(p!, "base64url").toString("utf8"));
  tamperedPayload.email = "attacker@evil.example";
  const tampered = `${h}.${b64url(JSON.stringify(tamperedPayload))}.${s}`;
  const result = await verifyIapJwt(tampered, undefined, { fetchImpl: jwksFetchStub() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /signature/);
});

test("iap: rejects an unknown kid", async () => {
  __resetIapJwksCacheForTesting();
  const jwt = signJwt(basePayload(), { kid: "some-other-key" });
  const result = await verifyIapJwt(jwt, undefined, { fetchImpl: jwksFetchStub() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /no matching IAP public key/);
});

test("iap: rejects a non-ES256 algorithm", async () => {
  __resetIapJwksCacheForTesting();
  const jwt = signJwt(basePayload(), { alg: "none" });
  const result = await verifyIapJwt(jwt, undefined, { fetchImpl: jwksFetchStub() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unsupported assertion algorithm/);
});

test("iap: rejects a wrong issuer", async () => {
  __resetIapJwksCacheForTesting();
  const jwt = signJwt(basePayload({ iss: "https://not-google.example" }));
  const result = await verifyIapJwt(jwt, undefined, { fetchImpl: jwksFetchStub() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /issuer/);
});

test("iap: rejects a malformed (non-three-part) token without any network call", async () => {
  const result = await verifyIapJwt("not-a-jwt", undefined, {
    fetchImpl: (async () => {
      throw new Error("should not fetch for a malformed token");
    }) as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /malformed assertion/);
});
