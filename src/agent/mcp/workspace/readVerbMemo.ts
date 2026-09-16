// W1 — in-flight de-duplication for repeated READ verbs.
//
// One Workbench paint asks the same instance for the same answer more than once: the rail and the
// dock both want `workspace_get_graph` for the bound workflow, the inspector and the quick-look
// both want the same node, a burst of tabs each want `skill_list`. Before this, every one of those
// was a separate dispatch, a separate repository read and (before the blob cache) a separate
// download. The cache below answers the second and third caller from the first one's work.
//
// Three rules keep this safe, and none of them is negotiable:
//
//   1. READS ONLY. The allowlist is explicit and hand-checked — never derived from a name pattern.
//      Collapsing two `workflow_run_next_node` calls into one would silently drop an operator's
//      second decision, which is a correctness bug of exactly the kind this repository's run CAS
//      exists to prevent.
//   2. SCOPED. The key carries a fingerprint of the caller's authorization. A scoped tenant bearer
//      and a full operator bearer ask the same verb with the same arguments and are entitled to
//      different answers; they must never share a cache entry.
//   3. FAILURES ARE NOT CACHED. A rejected read is replayed to its own caller and then forgotten,
//      so a transient store error cannot be served to everyone who asks for the next two seconds.
import type { WorkspaceToolContext } from "./tools.js";

/**
 * Every verb here is read-only: it returns stored state and writes nothing. Adding a verb to this
 * list is a correctness decision — read its handler first. Wire (underscore) spelling; the dotted
 * internal names normalise onto these.
 */
export const MEMOIZABLE_READ_VERBS: ReadonlySet<string> = new Set([
  "workspace_get_nodes", "workspace_get_graph", "workspace_get_node", "workspace_get_node_effective_config",
  "workspace_validate_graph", "workspace_export_workspace",
  "node_get_effective_prompt", "node_get_effective_tools", "node_get_effective_skills",
  "node_get_input_schema", "node_get_output_schema", "node_get_latest_output",
  "node_list_outputs", "node_list_executions",
  // `workflow_get_run_context` is deliberately ABSENT: it carries its own per-run cache and
  // reports `cacheHit` on the wire, so memoizing it would replay `cacheHit: false` to a caller
  // whose call was, in fact, a hit — a lie about the server's own state.
  "workflow_list_runs", "workflow_get_run", "workflow_get_run_cost",
  "project_list", "skill_list", "skill_resolve_for_node",
  "evaluation_list_rubrics", "evaluation_list_results", "evaluation_list_rubric_versions",
  "learning_list_observations", "playbook_get",
  "changes_list", "changes_get", "changes_compare",
  "stage_list_outputs", "stage_get_output",
  "tool_list", "tool_list_executions", "tool_get",
  "agent_list", "agent_get", "dataset_list",
  "usage_get_summary", "repository_get_health",
  "constellation_get_attention", "constellation_get_summary", "constellation_get_metrics",
  "constellation_get_structure", "constellation_get_relationship"
]);

/** How long a settled answer stays available to a caller that asks the identical question. */
export const READ_MEMO_TTL_MS = 2000;
const MEMO_CAP = 200;

type MemoEntry = { value: Promise<unknown>; settledAt?: number };
const memo = new Map<string, MemoEntry>();

// Off under vitest by default. Not because the memo is unsafe — its own suite covers it directly —
// but because a test suite resets the STORE between cases without dispatching a tool, which no
// production caller can do: in the service every write arrives through tools/call and drops the
// memo on its way past. Leaving it on would make one test's read visible to the next one's
// assertions and turn real regressions into noise. `setReadMemoEnabled` opts a suite back in.
let enabled = !process.env.VITEST;
export const setReadMemoEnabled = (value: boolean): void => { enabled = value; memo.clear(); };

/** Stable across key order, so `{a,b}` and `{b,a}` are one question, not two. */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
};

/**
 * The authorization fingerprint. `allowedToolNames` is what a scoped bearer's policy narrows the
 * surface to, and `actor` is who is asking — two callers that differ in either are two different
 * questions even when the verb and arguments match exactly.
 */
const scopeKey = (context: WorkspaceToolContext): string =>
  stableStringify({
    actorKind: context.actor?.kind ?? null,
    actorId: context.actor?.id ?? null,
    allowed: context.allowedToolNames ? [...context.allowedToolNames].sort() : null
  });

export const normalizeVerbName = (name: string): string => name.replaceAll(".", "_");

export const isMemoizableRead = (name: string): boolean => MEMOIZABLE_READ_VERBS.has(normalizeVerbName(name));

const evictExpired = (now: number): void => {
  for (const [key, entry] of memo) {
    if (entry.settledAt !== undefined && now - entry.settledAt >= READ_MEMO_TTL_MS) memo.delete(key);
  }
  if (memo.size <= MEMO_CAP) return;
  // Oldest-first: Map preserves insertion order, so the head is the least recently admitted.
  for (const key of [...memo.keys()].slice(0, memo.size - MEMO_CAP)) memo.delete(key);
};

/**
 * Runs `execute`, or returns the in-flight/just-settled result of an identical read. Returns
 * `{ result, memoized }` so the caller can log which it was — a memo whose hit rate is zero is a
 * memo that is costing map churn for nothing, and that should be visible.
 */
export async function withReadMemo<T>(
  name: string,
  args: unknown,
  context: WorkspaceToolContext,
  execute: () => Promise<T>
): Promise<{ result: T; memoized: boolean }> {
  if (!enabled || !isMemoizableRead(name)) return { result: await execute(), memoized: false };
  const now = Date.now();
  evictExpired(now);
  const key = `${normalizeVerbName(name)}|${scopeKey(context)}|${stableStringify(args)}`;
  const existing = memo.get(key);
  if (existing && (existing.settledAt === undefined || now - existing.settledAt < READ_MEMO_TTL_MS)) {
    return { result: (await existing.value) as T, memoized: true };
  }
  const entry: MemoEntry = {
    value: (async () => {
      try {
        return await execute();
      } catch (error) {
        // A failure belongs to its own caller only. Drop the entry before rethrowing so the next
        // caller retries the store rather than replaying an error it had no part in.
        memo.delete(key);
        throw error;
      }
    })()
  };
  memo.set(key, entry);
  const result = (await entry.value) as T;
  entry.settledAt = Date.now();
  return { result, memoized: false };
}

/**
 * Dropped by every non-read dispatch. Without this, a read-after-write inside the TTL window
 * answers from before the write — and this service's own client does exactly that: the Workbench's
 * schema/tools/skills savers write and then immediately read back to confirm what landed
 * (`workspaceSaveSchemaWithReadback` and friends). A memo that survived a write would hand them
 * the pre-write value and make every save look like it silently failed.
 *
 * Whole-map, not per-domain: a write to one verb's domain can change what several other verbs
 * answer (a node edit moves `workspace_get_node`, `workspace_get_graph`, `node_get_effective_prompt`
 * and `changes_list` at once), and a 2-second memo is cheap enough to rebuild.
 */
export const clearReadMemo = (): void => { memo.clear(); };

/** Tests and long-lived processes that deliberately want a cold read path. */
export const clearReadMemoForTests = clearReadMemo;
