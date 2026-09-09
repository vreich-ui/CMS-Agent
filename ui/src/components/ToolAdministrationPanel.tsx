import { useEffect, useState } from "react";
import {
  buildDriftRows,
  buildRegistryRows,
  summarizeDrift,
  summarizeRegistryRows,
  type CapabilityAudit,
  type CapabilityAuditSummary,
  type RegistryTool
} from "../toolAdministration";
import type { McpClient } from "../mcp/client";

// W4.2 — the workspace-wide half of the tool-administration surface: which grants can actually fire,
// and where a node's grant list and its behaviour disagree.
//
// This sits on the Access page beside the per-tenant permission toggles because it answers the
// question those toggles raise and could never answer: "if I change what this tenant allows, what
// actually reaches it?" The toggles govern tenant verbs; the table below governs registry grants; the
// drift list is every place the two models of "tool" contradict each other.
//
// Read-only by construction. Nothing here writes, and nothing here is a control — an operator acting
// on a finding does it through workspace_update_node_tools, deliberately, as AGENTS.md invariant 5
// requires.

type Props = { client: McpClient };

export function ToolAdministrationPanel({ client }: Props) {
  const [tools, setTools] = useState<RegistryTool[] | null>(null);
  const [audits, setAudits] = useState<CapabilityAudit[] | null>(null);
  const [summary, setSummary] = useState<CapabilityAuditSummary | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrors([]);
    void Promise.allSettled([
      client.call<{ tools: RegistryTool[] }>("tool.list", {}),
      client.call<{ summary: CapabilityAuditSummary; nodes: CapabilityAudit[] }>("workspace.audit_capabilities", {})
    ]).then(([registry, audit]) => {
      if (cancelled) return;
      const failures: string[] = [];
      // Per-read failure, not all-or-nothing: a drift list that cannot load must not take the
      // reachability table down with it, and vice versa.
      setTools(registry.status === "fulfilled" ? registry.value.tools ?? [] : null);
      if (registry.status === "rejected") failures.push("The controlled tool registry could not be read.");
      setAudits(audit.status === "fulfilled" ? audit.value.nodes ?? [] : null);
      setSummary(audit.status === "fulfilled" ? audit.value.summary ?? null : null);
      if (audit.status === "rejected") failures.push("The capability audit could not be read.");
      setErrors(failures);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [client]);

  const rows = buildRegistryRows(tools);
  const registryTotals = summarizeRegistryRows(rows);
  const drift = buildDriftRows(audits);
  const driftTotals = summarizeDrift(drift);

  return <section className="panel access-panel" aria-label="Tool administration">
    <div className="panel-heading">
      <div>
        <h2>Controlled tools</h2>
        <p className="muted">
          A different kind of "tool" from the permissions above. These are the workspace's own registry tools, which a
          model turn reaches through a node grant, a risk check and the execution ledger — while the permissions above
          govern the tenant's verbs. A grant on a node that runs a deterministic route can never fire, and this is where
          that shows.
        </p>
      </div>
    </div>

    {errors.map((error) => <div key={error} className="status error" role="status">{error}</div>)}
    {loading && <p className="muted" aria-live="polite">Loading…</p>}

    {tools !== null && <>
      <p className="muted">
        {registryTotals.total} registry tools · {registryTotals.live} reachable from at least one node ·{" "}
        {registryTotals.dead} granted but unreachable · {registryTotals.ungranted} granted by no conductor node.
      </p>
      <table className="node-inspector-tools" aria-label="Controlled tool reachability">
        <thead><tr>
          <th scope="col">Tool</th>
          <th scope="col">Risk</th>
          <th scope="col">Granted by</th>
          <th scope="col">Can actually fire from</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.toolId} className={row.dead ? "node-inspector-tool-row--denied" : undefined}>
            <th scope="row"><code>{row.name}</code></th>
            <td><span className={`risk-badge risk-badge--${row.riskLevel}`}>{row.riskLevel}</span></td>
            <td>{row.grantedBy.length ? row.grantedBy.join(", ") : <span className="muted">no conductor node</span>}</td>
            {/* The distinction the whole column exists for: "granted but nothing can call it" is a
                finding; "granted by nobody" is not — those tools are reached from the improvement
                judge, admin chat and tool.test, none of which is a conductor node. */}
            <td>{row.reachableFrom.length
              ? row.reachableFrom.join(", ")
              : row.dead
                ? <strong>nothing — every node holding it runs a deterministic route</strong>
                : <span className="muted">—</span>}</td>
          </tr>)}
        </tbody>
      </table>
    </>}

    <h3>Capability drift</h3>
    <p className="muted">
      Where a node's grant list and what the node actually does disagree. Read-only: acting on one of these is an
      operator decision made through <code>workspace_update_node_tools</code>, never from this page.
    </p>
    {audits !== null && summary && <p className="muted">
      {summary.nodeCount} resolved nodes · {summary.deterministicNodes} deterministic · {summary.nodesWithDeadGrants} carrying{" "}
      {summary.deadGrantCount} grants that can never fire · {summary.nodesReachingTenantFromEngine} reaching a tenant from engine code.
    </p>}
    {audits !== null && drift.length === 0 && <p className="empty-state">No drift: every node's grants match what it can do.</p>}
    {drift.length > 0 && <div className="capability-drift" aria-label="Capability drift findings">
      <p className="muted">{driftTotals.total} finding(s) across {driftTotals.nodes.length} node(s){driftTotals.high > 0 ? `, ${driftTotals.high} at publish or admin risk` : ""}.</p>
      {drift.map((row) => <div key={`${row.nodeId}:${row.code}:${row.items.join(",")}`} className="capability-drift-finding">
        <div>
          <code>{row.nodeId}</code>{" "}
          <span className={`risk-badge risk-badge--${row.severity === "high" ? "admin" : "write"}`}>{row.severity}</span>{" "}
          <code>{row.code}</code>
        </div>
        <div className="muted">{row.detail}</div>
        {row.items.length > 0 && <div>{row.items.map((item) => <code key={item}>{item} </code>)}</div>}
      </div>)}
    </div>}
  </section>;
}
