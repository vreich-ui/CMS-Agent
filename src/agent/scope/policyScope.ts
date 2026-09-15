// C2 (part 2) — THE SCOPE VOCABULARY: the one way this workspace says what a piece of policy applies
// to. One module, three dimensions, no second spelling.
//
// WHY IT EXISTS. #358 pinned WHICH skills a run dispatched with, and said in its own header that it
// deliberately did not decide which skills SHOULD apply: `assignedSkills` was taken as given. That
// gap is not theoretical. Two places had already worked around it, in two different ways:
//
//   1. `houseLessons.ts` needed per-tenant chat lessons and had no vocabulary to say so, so it
//      invented a string convention — `chat_client_manager:${projectId}` used as a playbook "nodeId"
//      — with a comment naming the hazard it was dodging: "a single shared playbook across every
//      tenant would let one house's editorial correction reach another house's chat, which is the
//      fleet's worst cross-tenant failure mode."
//   2. `strategyLearning.ts` did NOT dodge it. It runs per project (`StrategyLearningParams.projectId`),
//      derives signals from that project's tracking rollups, and then writes them into
//      `getPlaybook(nodeId)` — the one global playbook for that node, shared by every tenant. So
//      dr-lurie's measured outcomes are injected into fernwell's dispatch of `draft_writer` today.
//
// One convention in a string, one leak, and nothing that could be reviewed. This module is the thing
// both of them were missing.
//
// THE THREE DIMENSIONS, and why exactly these. A piece of policy in this system is narrowed by the
// house it serves, the work it governs, or the campaign it belongs to — nothing else has ever been
// asked for:
//   * `site`      — a tenant, by projectId. The isolation boundary the fleet actually has.
//   * `task`      — a unit of work, by nodeId (or an agent id, for the chat path, which is not a node).
//   * `objective` — a named goal a run was started under, when the operator named one.
//
// AN UNNAMED DIMENSION IS A WILDCARD, A NAMED ONE IS A REQUIREMENT. `{}` is the fleet: it applies
// everywhere. `{ site: "dr-lurie" }` applies to every task on dr-lurie and to nothing on fernwell.
//
// AND AN UNKNOWN DIMENSION IS NOT A MATCH. A scope that names a dimension the CONTEXT cannot supply
// does not apply. A dispatch that cannot say which site it is on must not receive site-scoped policy,
// because "we don't know" is the one answer that must never resolve to "yes" for an isolation
// boundary. This is the rule the whole module turns on, and it is asserted in its own test.

export const POLICY_SCOPE_CONTRACT = "policy_scope.v1";

/** Most general first. The order is the storage order, the key order and the display order. */
export const SCOPE_DIMENSIONS = ["site", "task", "objective"] as const;
export type ScopeDimension = typeof SCOPE_DIMENSIONS[number];

/** What a piece of policy declares it applies to. Every dimension optional; `{}` is the fleet. */
export type PolicyScope = Partial<Record<ScopeDimension, string>>;

/**
 * What the caller actually is, at the moment policy is being selected. Same shape as a PolicyScope
 * and deliberately a different type: one is a claim about applicability, the other is a fact about
 * the situation, and conflating them is how a filter ends up comparing a claim to a claim.
 */
export type ScopeContext = Partial<Record<ScopeDimension, string>>;

export const FLEET_SCOPE_KEY = "fleet";

// Conservative on purpose: a scope value becomes a blob key segment (`scopeStorageSegments`), so the
// characters that can traverse a path or collide with the key grammar are simply not allowed. Both
// existing id spaces this has to hold — projectIds (`dr-lurie`, `genesis-lab-3`) and nodeIds
// (`draft_writer`) — sit well inside it.
const SCOPE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SCOPE_VALUE_LENGTH = 128;

const isPresent = (value: string | undefined): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Canonical form: absent and blank dimensions dropped, keys in `SCOPE_DIMENSIONS` order.
 *
 * Every other function here takes normalized input, so `{ site: "" }` and `{}` and
 * `{ site: undefined }` are one value rather than three that compare unequal.
 */
export const normalizeScope = (scope: PolicyScope | undefined): PolicyScope => {
  const normalized: PolicyScope = {};
  for (const dimension of SCOPE_DIMENSIONS) {
    const value = scope?.[dimension];
    if (isPresent(value)) normalized[dimension] = value.trim();
  }
  return normalized;
};

export const isFleetScope = (scope: PolicyScope | undefined): boolean => Object.keys(normalizeScope(scope)).length === 0;

/** How many dimensions this scope names. 0 = fleet, 3 = as narrow as this vocabulary goes. */
export const scopeSpecificity = (scope: PolicyScope | undefined): number => Object.keys(normalizeScope(scope)).length;

/**
 * Validation issues, as messages. Empty means valid — including `{}`, which is the fleet and is
 * always valid.
 */
export const validateScope = (scope: PolicyScope | undefined): string[] => {
  const issues: string[] = [];
  for (const dimension of SCOPE_DIMENSIONS) {
    const value = scope?.[dimension];
    if (value === undefined) continue;
    if (typeof value !== "string") { issues.push(`Scope ${dimension} must be a string.`); continue; }
    const trimmed = value.trim();
    if (!trimmed) { issues.push(`Scope ${dimension} is empty; omit the dimension instead of naming it with a blank value.`); continue; }
    if (trimmed.length > MAX_SCOPE_VALUE_LENGTH) issues.push(`Scope ${dimension} is longer than ${MAX_SCOPE_VALUE_LENGTH} characters.`);
    if (!SCOPE_VALUE_PATTERN.test(trimmed)) issues.push(`Scope ${dimension} must match ${SCOPE_VALUE_PATTERN.source} (it becomes a storage key segment): received "${trimmed}".`);
  }
  const unknown = Object.keys(scope ?? {}).filter((key) => !SCOPE_DIMENSIONS.includes(key as ScopeDimension));
  for (const key of unknown) issues.push(`Unknown scope dimension "${key}". This vocabulary has exactly: ${SCOPE_DIMENSIONS.join(", ")}.`);
  return issues;
};

/**
 * The stable string form: `fleet`, or `site=dr-lurie;task=draft_writer`.
 *
 * Used as a map key, a log line and a record field. It round-trips through `parseScopeKey`, which is
 * what lets a stored scope be read back without a second decoder written somewhere else.
 */
export const scopeKey = (scope: PolicyScope | undefined): string => {
  const normalized = normalizeScope(scope);
  const parts = SCOPE_DIMENSIONS.filter((dimension) => normalized[dimension]).map((dimension) => `${dimension}=${normalized[dimension]}`);
  return parts.length ? parts.join(";") : FLEET_SCOPE_KEY;
};

/** The inverse of `scopeKey`. `undefined` for anything this vocabulary did not write. */
export const parseScopeKey = (key: string): PolicyScope | undefined => {
  if (key === FLEET_SCOPE_KEY) return {};
  const scope: PolicyScope = {};
  for (const part of key.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return undefined;
    const dimension = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (!SCOPE_DIMENSIONS.includes(dimension as ScopeDimension)) return undefined;
    if (scope[dimension as ScopeDimension] !== undefined) return undefined;
    scope[dimension as ScopeDimension] = value;
  }
  return validateScope(scope).length ? undefined : scope;
};

/** For messages a human reads: "the fleet", "site dr-lurie", "site dr-lurie + task draft_writer". */
export const scopeLabel = (scope: PolicyScope | undefined): string => {
  const normalized = normalizeScope(scope);
  const parts = SCOPE_DIMENSIONS.filter((dimension) => normalized[dimension]).map((dimension) => `${dimension} ${normalized[dimension]}`);
  return parts.length ? parts.join(" + ") : "the fleet";
};

/**
 * DOES THIS POLICY APPLY HERE? Every dimension the scope names must be named in the context too, and
 * with the same value.
 *
 * The second half of that sentence is the one that matters: a context that does not carry `site`
 * does NOT satisfy `{ site: "dr-lurie" }`. See the module header — unknown is not a match, and the
 * fleet scope still applies to everything, so nothing is lost by refusing to guess.
 */
export const scopeApplies = (scope: PolicyScope | undefined, context: ScopeContext | undefined): boolean => {
  const normalized = normalizeScope(scope);
  const situation = normalizeScope(context);
  return SCOPE_DIMENSIONS.every((dimension) => {
    const required = normalized[dimension];
    return required === undefined || situation[dimension] === required;
  });
};

/**
 * Specificity comparison for two scopes that BOTH apply to the same context: positive when `a` is
 * narrower than `b`, negative when wider, 0 when neither is narrower.
 *
 * Deliberately NOT a total order. Two scopes with the same count of named dimensions — `{site}` and
 * `{objective}` — are not ranked, and the caller has to say what it does about that rather than
 * inherit an arbitrary answer from a sort. `selectScopedSkills` treats it as a configuration error
 * and names both, which is the only honest thing to do with a genuine tie.
 */
export const compareScopeSpecificity = (a: PolicyScope | undefined, b: PolicyScope | undefined): number => {
  const left = scopeSpecificity(a);
  const right = scopeSpecificity(b);
  if (left === right) return 0;
  return left > right ? 1 : -1;
};

// ── storage ──────────────────────────────────────────────────────────────────

/**
 * Key segments for a scope-addressed record: `[]` for the fleet, `["by-site", "dr-lurie"]` and so on.
 *
 * THE FLEET SCOPE PRODUCES NO SEGMENTS ON PURPOSE. It keeps every record this vocabulary reaches at
 * exactly the key it already occupies (`improvement/playbooks/{nodeId}.json`), so introducing scope
 * migrates nothing, rewrites nothing, and cannot orphan a record that is being read in production
 * right now. Narrowing is additive: a new scope writes a new key beside the old one.
 */
export const SCOPE_KEY_PREFIXES: Record<ScopeDimension, string> = { site: "by-site", task: "by-task", objective: "by-objective" };
export const RESERVED_KEY_SEGMENTS: readonly string[] = Object.values(SCOPE_KEY_PREFIXES);

export const scopeStorageSegments = (scope: PolicyScope | undefined): string[] => {
  const normalized = normalizeScope(scope);
  const issues = validateScope(normalized);
  if (issues.length) throw new Error(`Refusing to build a storage key from an invalid scope: ${issues.join(" ")}`);
  return SCOPE_DIMENSIONS.flatMap((dimension) => (normalized[dimension] ? [SCOPE_KEY_PREFIXES[dimension], normalized[dimension]!] : []));
};
