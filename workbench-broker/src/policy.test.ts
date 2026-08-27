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

test("policy: mutating verb is refused under READ_ONLY with an operator-worded message naming the verb", () => {
  const decision = checkPolicy("workflow_pause_run", true);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "read_only");
  assert.match(decision.message ?? "", /read-only mode/i);
  assert.match(decision.message ?? "", /workflow_pause_run/);
  // Operator-worded means no bare env-var-name shouting at the person reading it.
  assert.doesNotMatch(decision.message ?? "", /\bREAD_ONLY=/);
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

test("policy: site_duplicate_status is a read verb (T15.14)", () => {
  assert.equal(classifyVerb("site_duplicate_status"), "read");
  assert.equal(checkPolicy("site_duplicate_status", true).allowed, true);
  assert.equal(checkPolicy("site_duplicate_status", false).allowed, true);
});

test("policy: site_duplicate is a mutating verb (T15.14)", () => {
  assert.equal(classifyVerb("site_duplicate"), "mutating");
  // Allowed when READ_ONLY is off
  assert.equal(checkPolicy("site_duplicate", false).allowed, true);
  // Refused when READ_ONLY is on
  const readOnlyDecision = checkPolicy("site_duplicate", true);
  assert.equal(readOnlyDecision.allowed, false);
  assert.equal(readOnlyDecision.code, "read_only");
});

test("policy: neighbouring verbs like site_duplicate_foobar are not allowed (T15.14 narrowness)", () => {
  // Verify that only site_duplicate and site_duplicate_status are allowed,
  // not other similar-sounding verbs.
  const unknownVerb = checkPolicy("site_duplicate_foobar", false);
  assert.equal(unknownVerb.allowed, false);
  assert.equal(unknownVerb.code, "unknown_verb");
});
