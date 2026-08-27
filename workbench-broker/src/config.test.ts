import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "./config.js";

const BASE_ENV = {
  SESSION_SECRET: "s".repeat(32),
  OPERATOR_PASSWORD_HASH: "scrypt$16384$8$1$c2FsdA$aGFzaA",
  MOCK_UPSTREAM: "1",
};

test("config: AUTH_MODE defaults to iap", () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.authMode, "iap");
});

test("config: AUTH_MODE=password is accepted", () => {
  const config = loadConfig({ ...BASE_ENV, AUTH_MODE: "password" });
  assert.equal(config.authMode, "password");
});

test("config: an unrecognized AUTH_MODE fails fast, naming the value", () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, AUTH_MODE: "carrier-pigeon" }), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /AUTH_MODE/);
    assert.match(err.message, /carrier-pigeon/);
    return true;
  });
});

test("config: READ_ONLY defaults on when unset", () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.readOnly, true);
});

test("config: READ_ONLY=0 turns mutations on", () => {
  const config = loadConfig({ ...BASE_ENV, READ_ONLY: "0" });
  assert.equal(config.readOnly, false);
});

test("config: CMS_AGENT_MCP_TOKEN_SECRET must be a well-formed Secret Manager version resource name", () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, MOCK_UPSTREAM: "0", CMS_AGENT_MCP_URL: "https://example/mcp", CMS_AGENT_MCP_TOKEN_SECRET: "not-a-ref" }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /CMS_AGENT_MCP_TOKEN_SECRET/);
      return true;
    }
  );
});

test("config: a well-formed CMS_AGENT_MCP_TOKEN_SECRET is accepted without also requiring CMS_AGENT_MCP_TOKEN", () => {
  const config = loadConfig({
    ...BASE_ENV,
    MOCK_UPSTREAM: "0",
    CMS_AGENT_MCP_URL: "https://example/mcp",
    CMS_AGENT_MCP_TOKEN_SECRET: "projects/my-proj/secrets/tok/versions/latest",
  });
  assert.equal(config.mcpTokenSecretRef, "projects/my-proj/secrets/tok/versions/latest");
  assert.equal(config.mcpToken, "");
});

test("config: without a secret ref, a real (non-mock) deploy still requires CMS_AGENT_MCP_TOKEN", () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, MOCK_UPSTREAM: "0", CMS_AGENT_MCP_URL: "https://example/mcp" }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /CMS_AGENT_MCP_TOKEN/);
      return true;
    }
  );
});

test("config: CACHE_TTL_MS defaults sensibly and rejects a negative value", () => {
  const config = loadConfig(BASE_ENV);
  assert.ok(config.cacheTtlMs > 0);
  assert.throws(() => loadConfig({ ...BASE_ENV, CACHE_TTL_MS: "-5" }), ConfigError);
});

test("config: STATIC_ROOT is undefined when unset", () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.staticRoot, undefined);
});

test("config: IAP_AUDIENCE is undefined when unset, set when provided", () => {
  assert.equal(loadConfig(BASE_ENV).iapAudience, undefined);
  assert.equal(loadConfig({ ...BASE_ENV, IAP_AUDIENCE: "/projects/1/x" }).iapAudience, "/projects/1/x");
});
