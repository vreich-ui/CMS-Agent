// Tolerant deep-search helpers over MCP tool results, shared by the per-project publish execution
// hooks and the generic publisher. Result envelope shapes vary across MCP servers (raw result vs.
// { structuredContent } vs. nested data), so these searches are intentionally forgiving: they walk
// the whole result object (bounded depth) for the first value under a matching key rather than
// pinning one envelope shape per client.

// Depth-first search for the first child value whose (key, value) pair satisfies `match`. Returns
// undefined when nothing matches — matched values that are themselves falsy (e.g. `valid: false`)
// still propagate correctly.
export const findDeep = (value: unknown, match: (key: string, child: unknown) => boolean, depth = 0): unknown => {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (match(key, child)) return child;
    const found = findDeep(child, match, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
};

// Deep-search a tool result for a lock_token string (checkout results across dialects).
export const findLockToken = (value: unknown): string | undefined =>
  findDeep(value, (key, child) => key === "lock_token" && typeof child === "string" && child !== "") as string | undefined;
