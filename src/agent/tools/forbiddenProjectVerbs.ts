/**
 * K-A10 — the verbs a node may never speak through `project.call_tool`, and the only two nodes
 * exempt from that rule.
 *
 * The publish-risk dispatch gate covers nodes whose riskLevel is `publish`/`admin`, and
 * `composeWorkflowNodes`' structural refusal looks for `object_publish`/`release_to_production` in
 * a node's `allowedTools` — where only CONTROLLED tool ids ever appear. Neither sees a `write`-risk
 * node that holds `project.call_tool` and simply names the verb in its arguments. Canonical
 * `publishing_conductor` grants that tool to `contract_intelligence`, `artifact_materializer`,
 * `article_body` and `publish_payload`, and `article_body` is always a model turn: a prompt that
 * says "fetch the contract" and a model that decides to publish instead were, until this list
 * existed, stopped only by the tenant's own server-side rules.
 *
 * cloneEngine.ts imports FORBIDDEN_PROJECT_VERBS from here rather than keeping its own copy;
 * scripts/emit.mjs and scripts/clone.mjs still hold hand-kept duplicates (they are standalone
 * scripts and cannot import from src/) — keep all three in lockstep.
 */
export const FORBIDDEN_PROJECT_VERBS: ReadonlySet<string> = new Set(["object_publish", "release_to_production", "trigger_netlify_build", "deploy"]);

/**
 * The nodes whose entire purpose IS the verb. `publish_executor` speaks `object_publish`;
 * `release_executor` speaks `release_to_production`. Both are `publish`-risk and already pass the
 * dispatch gate, the controller decision and the operator decision before they run.
 */
export const PROJECT_VERB_AUTHORIZED_NODE_IDS: ReadonlySet<string> = new Set(["publish_executor", "release_executor"]);

/** The refusal a node gets when it names a forbidden verb. Server-side, before any transport. */
export const forbiddenProjectVerbRefusal = (nodeId: string | undefined, tool: string): string =>
  `publish_verb_not_permitted: node "${nodeId || "(none)"}" may not call "${tool}" through project.call_tool. Only publish_executor and release_executor speak publish/release verbs, and only after the controller and operator decisions. Use project.call_read_tool for reads.`;
