// PKCE (RFC 7636) support. MCP requires the S256 method for the authorization-code flow, so that
// is all this server offers — a "plain" challenge is rejected upstream. Verification is
// constant-time to avoid leaking how much of the challenge matched.

import { createHash, timingSafeEqual } from "node:crypto";

export const computeS256Challenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

const timingSafeStringEqual = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
};

// A verifier is 43–128 chars of the unreserved set (RFC 7636 §4.1). Enforced so a malformed value
// is rejected before hashing.
const VALID_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export const verifyPkceS256 = (codeVerifier: string, codeChallenge: string): boolean => {
  if (!codeVerifier || !codeChallenge) return false;
  if (!VALID_VERIFIER.test(codeVerifier)) return false;
  return timingSafeStringEqual(computeS256Challenge(codeVerifier), codeChallenge);
};
