import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionToken, verifySessionToken, buildSessionCookie, parseCookies } from "./session.js";

const SECRET = "a".repeat(32);

test("session: sign/verify round-trip succeeds", () => {
  const { token } = createSessionToken("wolf", SECRET);
  const payload = verifySessionToken(token, SECRET);
  assert.ok(payload);
  assert.equal(payload?.operator, "wolf");
});

test("session: tampered signature is rejected", () => {
  const { token } = createSessionToken("wolf", SECRET);
  const [payloadB64, sig] = token.split(".");
  // Flip the signature.
  const tamperedSig = sig!.split("").reverse().join("");
  const tampered = `${payloadB64}.${tamperedSig}`;
  assert.equal(verifySessionToken(tampered, SECRET), null);
});

test("session: tampered payload is rejected", () => {
  const { token } = createSessionToken("wolf", SECRET);
  const [, sig] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ operator: "attacker", issuedAt: Date.now(), expiresAt: Date.now() + 999999 }), "utf8").toString("base64url");
  const tampered = `${forgedPayload}.${sig}`;
  assert.equal(verifySessionToken(tampered, SECRET), null);
});

test("session: wrong secret is rejected", () => {
  const { token } = createSessionToken("wolf", SECRET);
  assert.equal(verifySessionToken(token, "b".repeat(32)), null);
});

test("session: expired token is rejected", () => {
  const now = Date.now();
  const { token } = createSessionToken("wolf", SECRET, 1000, now - 5000);
  // Token expired 4 seconds ago relative to `now`.
  const payload = verifySessionToken(token, SECRET, now);
  assert.equal(payload, null);
});

test("session: token valid just before expiry, invalid at/after expiry", () => {
  const now = 1_000_000;
  const { token } = createSessionToken("wolf", SECRET, 1000, now);
  assert.ok(verifySessionToken(token, SECRET, now + 999));
  assert.equal(verifySessionToken(token, SECRET, now + 1000), null);
});

test("session: missing/empty token returns null", () => {
  assert.equal(verifySessionToken(undefined, SECRET), null);
  assert.equal(verifySessionToken(null, SECRET), null);
  assert.equal(verifySessionToken("", SECRET), null);
  assert.equal(verifySessionToken("not-a-valid-token", SECRET), null);
});

test("session: cookie string has HttpOnly, Secure, SameSite=Strict", () => {
  const cookie = buildSessionCookie("abc.def", 1000);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
});

test("parseCookies: parses a simple cookie header", () => {
  const cookies = parseCookies("cw_session=abc123; other=val");
  assert.equal(cookies.cw_session, "abc123");
  assert.equal(cookies.other, "val");
});

test("parseCookies: handles undefined header", () => {
  assert.deepEqual(parseCookies(undefined), {});
});
