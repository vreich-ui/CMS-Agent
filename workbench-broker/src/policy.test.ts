import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPolicy, classifyVerb, READ_VERBS, MUTATING_VERBS } from "./policy.js";

test("policy: known read verb is allowed regardless of READ_ONLY", () => {
  assert.equal(classifyVerb("workflow_list_runs"), "read");
  assert.equal(checkPolicy("workflow_list_runs", true).allowed, true);
  assert.equal(checkPolicy("workflow_list_runs", false).allowed, true);
});

test("policy: unknown verb is default-denied and names the verb", () => {
  const decision = checkPolicy("totally_made_up_verb", false);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "unknown_verb");
  assert.match(decision.message ?? "", /totally_made_up_verb/);
});

test("policy: mutating verb is refused under READ_ONLY and names the flag", () => {
  const decision = checkPolicy("workflow_pause_run", true);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "read_only");
  assert.match(decision.message ?? "", /READ_ONLY/);
  assert.match(decision.message ?? "", /workflow_pause_run/);
});

test("policy: mutating verb is allowed when READ_ONLY is off", () => {
  const decision = checkPolicy("workflow_pause_run", false);
  assert.equal(decision.allowed, true);
});

test("policy: no verb appears in both READ_VERBS and MUTATING_VERBS", () => {
  for (const v of READ_VERBS) {
    assert.equal(MUTATING_VERBS.has(v), false, `"${v}" is in both sets`);
  }
});

test("policy: node_validate_input and workspace_validate_node are read-shaped (no confirm) per spec", () => {
  assert.equal(classifyVerb("node_validate_input"), "read");
  assert.equal(classifyVerb("workspace_validate_node"), "read");
});
