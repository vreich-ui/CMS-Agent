import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadCache } from "./cache.js";

test("cache: hit returns the stored value with a matching key", () => {
  const cache = new ReadCache({ ttlMs: 10_000 });
  cache.set("workflow_list_runs", { limit: 5 }, { runs: [1, 2, 3] });
  assert.deepEqual(cache.get("workflow_list_runs", { limit: 5 }), { runs: [1, 2, 3] });
});

test("cache: miss for a different verb or different args", () => {
  const cache = new ReadCache({ ttlMs: 10_000 });
  cache.set("workflow_list_runs", { limit: 5 }, { runs: [] });
  assert.equal(cache.get("workflow_list_runs", { limit: 6 }), undefined);
  assert.equal(cache.get("workflow_get_run", { limit: 5 }), undefined);
});

test("cache: entry expires after its TTL", () => {
  let now = 1_000_000;
  const cache = new ReadCache({ ttlMs: 1_000, now: () => now });
  cache.set("tool_list", {}, { tools: [] });
  assert.deepEqual(cache.get("tool_list", {}), { tools: [] });
  now += 1_001;
  assert.equal(cache.get("tool_list", {}), undefined);
});

test("cache: invalidate bumps the generation so prior entries are unreachable", () => {
  const cache = new ReadCache({ ttlMs: 10_000 });
  cache.set("workflow_list_runs", {}, { runs: ["a"] });
  assert.deepEqual(cache.get("workflow_list_runs", {}), { runs: ["a"] });

  cache.invalidate();
  assert.equal(cache.get("workflow_list_runs", {}), undefined);
  assert.equal(cache.size, 0, "invalidate should also clear the underlying store");

  // A fresh write after invalidation works normally under the new generation.
  cache.set("workflow_list_runs", {}, { runs: ["b"] });
  assert.deepEqual(cache.get("workflow_list_runs", {}), { runs: ["b"] });
});

test("cache: version increments by exactly one per invalidate call", () => {
  const cache = new ReadCache({ ttlMs: 10_000 });
  const v0 = cache.version;
  cache.invalidate();
  cache.invalidate();
  assert.equal(cache.version, v0 + 2);
});

test("cache: sweep evicts only expired entries", () => {
  let now = 0;
  const cache = new ReadCache({ ttlMs: 1_000, now: () => now });
  cache.set("a", {}, 1);
  now = 500;
  cache.set("b", {}, 2);
  now = 1_100; // "a" expired (set at t=0, ttl 1000), "b" not (set at t=500, expires 1500)
  cache.sweep();
  assert.equal(cache.get("a", {}), undefined);
  assert.equal(cache.get("b", {}), 2);
});
