// U3 — drive-mode breakpoints: a per-run, per-node "pause before running
// this node" flag the operator can set from the step debugger. A run must
// not walk into a live publish while the operator is looking away, so a
// node whose declared risk is 'publish' defaults ON; every other node
// defaults OFF. The default is computed at READ time from the node's risk
// — nothing is written to storage until the operator makes a deliberate
// choice, so a node whose risk changes later still picks up the live
// default instead of an entry frozen at first render.
//
// Persisted in localStorage, keyed per run (a breakpoint is a property of
// this run's drive session, not of the node definition — two different
// runs of the same workflow can be driven with different breakpoints).
// Every access wrapped in try/catch, same defensive pattern as store.ts's
// theme persistence: a private window or blocked storage degrades to "no
// explicit breakpoints" (falls back to the risk-based default) rather than
// throwing.

const KEY_PREFIX = 'cw-drive-bp:';

export type BreakpointMap = Record<string, boolean>;

function readMap(runId: string): BreakpointMap {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + runId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as BreakpointMap;
    }
    return {};
  } catch {
    return {};
  }
}

function writeMap(runId: string, map: BreakpointMap): void {
  try {
    localStorage.setItem(KEY_PREFIX + runId, JSON.stringify(map));
  } catch {
    // ignore — storage unavailable (private window, quota, blocked)
  }
}

/** A run must not walk into a live publish while the operator is looking
 * away — every 'publish'-risk node defaults to a breakpoint. */
export function defaultBreakpoint(risk: string | undefined): boolean {
  return risk === 'publish';
}

/** The effective breakpoint state for one node in one run: an explicit
 * operator choice if one was ever made, else the risk-based default. */
export function getBreakpoint(runId: string, nodeId: string, risk: string | undefined): boolean {
  const map = readMap(runId);
  return nodeId in map ? map[nodeId] : defaultBreakpoint(risk);
}

/** Records an explicit operator choice, persisted per run. */
export function setBreakpoint(runId: string, nodeId: string, value: boolean): void {
  const map = readMap(runId);
  map[nodeId] = value;
  writeMap(runId, map);
}

export function toggleBreakpoint(runId: string, nodeId: string, risk: string | undefined): boolean {
  const next = !getBreakpoint(runId, nodeId, risk);
  setBreakpoint(runId, nodeId, next);
  return next;
}

/** Explicit overrides only (defaults not folded in) — test-only introspection. */
export function readExplicitBreakpoints(runId: string): BreakpointMap {
  return readMap(runId);
}
