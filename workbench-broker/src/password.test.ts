import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "./password.js";

test("password: hash then verify succeeds with correct password", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  const ok = await verifyPassword("correct-horse-battery-staple", hash);
  assert.equal(ok, true);
});

test("password: verify rejects wrong password", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  const ok = await verifyPassword("wrong-password", hash);
  assert.equal(ok, false);
});

test("password: verify rejects malformed stored hash instead of throwing", async () => {
  const ok = await verifyPassword("anything", "not-a-valid-hash");
  assert.equal(ok, false);
});

test("password: two hashes of the same password differ (random salt)", async () => {
  const h1 = await hashPassword("same-password");
  const h2 = await hashPassword("same-password");
  assert.notEqual(h1, h2);
  assert.equal(await verifyPassword("same-password", h1), true);
  assert.equal(await verifyPassword("same-password", h2), true);
});
