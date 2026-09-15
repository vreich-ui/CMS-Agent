import { describe, expect, it } from "vitest";
import { SAFE_READ_FAILURES, safeReadFailure, safeWarningCode } from "../../../../src/agent/conversations/briefing/safeReason.js";

// THE REGRESSION THIS FILE EXISTS TO WALL OFF: the first cut of the object dossier interpolated the
// tenant adapter's own error string into `## Bound object`, and that string names the deployment's
// environment variables and the tenant's endpoint. Every case below feeds in a string carrying exactly
// that kind of secret-adjacent material and asserts none of it ever reaches the returned sentence.
const SECRET_ENV_VAR = "PLATFORM_MCP_ENDPOINT";
const SECRET_ENDPOINT = "https://tenant.example/mcp";
const SECRET_TOKEN = "Bearer sk-ABCDEF1234567890";
const POISONED_MESSAGE = `Project MCP endpoint is not configured: neither the ${SECRET_ENV_VAR} env var on this deployment nor an mcpEndpoint (${SECRET_ENDPOINT}) resolves one. Auth header was ${SECRET_TOKEN}.`;

const expectNoLeak = (value: string | undefined): void => {
  expect(value).toBeDefined();
  expect(value).not.toContain(SECRET_ENV_VAR);
  expect(value).not.toContain(SECRET_ENDPOINT);
  expect(value).not.toContain(SECRET_TOKEN);
  expect(value).not.toContain("sk-ABCDEF1234567890");
};

describe("safeReason — never quote the input, ever", () => {
  it("safeReadFailure never returns any part of a poisoned Error message", () => {
    expectNoLeak(safeReadFailure(new Error(POISONED_MESSAGE)));
  });

  it("safeReadFailure never returns any part of a poisoned plain string error", () => {
    expectNoLeak(safeReadFailure(POISONED_MESSAGE));
  });

  it("safeReadFailure never returns any part of the input even with every hint combination set", () => {
    expectNoLeak(safeReadFailure(new Error(POISONED_MESSAGE), { authFailed: true }));
    expectNoLeak(safeReadFailure(new Error(POISONED_MESSAGE), { aborted: true }));
    expectNoLeak(safeReadFailure(new Error(POISONED_MESSAGE), { httpStatus: 403 }));
    expectNoLeak(safeReadFailure(new Error(POISONED_MESSAGE), { httpStatus: 500 }));
    expectNoLeak(safeReadFailure(new Error(`abort: ${POISONED_MESSAGE}`)));
  });

  it("safeReadFailure classifies into one of the five fixed sentences only", () => {
    const values = Object.values(SAFE_READ_FAILURES);
    expect(values).toContain(safeReadFailure(new Error(POISONED_MESSAGE), { authFailed: true }));
    expect(values).toContain(safeReadFailure(new Error(POISONED_MESSAGE)));
  });

  it("safeWarningCode never returns any part of a poisoned code string, for every code family", () => {
    const poisonedCode = (family: string): string => `${family}: ${POISONED_MESSAGE}`;
    expectNoLeak(safeWarningCode(poisonedCode("voice_object_unconfigured")));
    expectNoLeak(safeWarningCode(poisonedCode("strategy_object_not_found")));
    expectNoLeak(safeWarningCode(poisonedCode("strategy_object_invalid")));
    expectNoLeak(safeWarningCode(poisonedCode("prefetch_blocked")));
    expectNoLeak(safeWarningCode(poisonedCode("prefetch_unreachable_threw")));
    // A code matching none of the recognised families still degrades to a safe generic sentence.
    expectNoLeak(safeWarningCode(poisonedCode("some_unrecognised_family")));
  });

  it("safeWarningCode returns undefined for an absent code, never a leaked empty-ish placeholder", () => {
    expect(safeWarningCode(undefined)).toBeUndefined();
  });
});
