// W4.2 — the Access page's two new surfaces. The model logic is tested by root vitest
// (tests/ui/toolAdministration.test.ts); this covers what only the DOM can answer: that "who has
// reached this tenant" is rendered as calls that happened rather than as intent, that an empty
// ledger does not read as "nothing uses this project", and that the controlled-tool registry is
// presented as a DIFFERENT kind of tool from the tenant permissions above it rather than as more
// rows of the same table.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { AccessPage } from "../src/components/pages/AccessPage";
import type { McpClient } from "../src/mcp/client";
import type { ProjectSummary } from "../src/types/workspace";

const project: ProjectSummary = {
  projectId: "dr-lurie",
  name: "Dr. Lurie",
  authMode: "bearer_env",
  allowedTools: [],
  defaultToolPolicy: "blocked",
  toolPolicies: {},
  contentContract: { contentContract: "client_object.v1" },
  publishingPolicy: { publishEnabled: false, requiresExplicitPublish: true, description: "" },
  status: "active",
  connection: { endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN" }
} as unknown as ProjectSummary;

type Overrides = Partial<Record<string, () => unknown>>;

const makeClient = (overrides: Overrides = {}): McpClient => ({
  method: async () => { throw new Error("unused"); },
  call: async <T,>(name: string): Promise<T> => {
    const override = overrides[name];
    if (override) return override() as T;
    if (name === "project.list_tools") return { ok: true, tools: [{ name: "object_get", description: "Read an object." }] } as T;
    if (name === "project.get") return { usedBy: { sampledCalls: 0, sampleLimit: 500, nodes: [] } } as T;
    if (name === "tool.list") return { tools: [] } as T;
    if (name === "workspace.audit_capabilities") return { summary: { nodeCount: 0, modelNodes: 0, deterministicNodes: 0, nodesWithDeadGrants: 0, deadGrantCount: 0, nodesReachingTenantFromEngine: 0, nodesReachingHighRiskVerbs: [] }, nodes: [] } as T;
    throw new Error(`unexpected tool call: ${name}`);
  }
});

const renderPage = (client: McpClient) => render(<AccessPage
  client={client}
  projects={[project]}
  projectsError={null}
  onRefreshProjects={() => {}}
  selectedProjectId="dr-lurie"
  onStatus={() => {}}
  onError={() => {}}
/>);

describe("AccessPage — used by (W4.2)", () => {
  it("names the nodes that reached the tenant, their verbs, and which came from engine code", async () => {
    renderPage(makeClient({
      "project.get": () => ({ usedBy: { sampledCalls: 3, sampleLimit: 500, nodes: [
        { nodeId: "publish_executor", calls: 2, callers: ["engine"], routeIds: [], verbs: ["object_checkout", "object_publish"], lastAt: "2026-09-09T10:00:00.000Z" },
        { nodeId: "article_body", calls: 1, callers: ["model"], routeIds: [], verbs: ["object_get"], lastAt: "2026-09-09T09:00:00.000Z" }
      ] } })
    }));

    const table = await waitFor(() => screen.getByLabelText("Tenant callers"));
    const publishRow = within(table).getByRole("row", { name: /publish_executor/ });
    expect(within(publishRow).getByText("object_publish")).toBeInTheDocument();
    // An engine-invoked call passed no grant and no risk check, so it is emphasised rather than
    // rendered identically to a model turn's call.
    expect(within(publishRow).getByText("engine").tagName).toBe("STRONG");
    // ...and a model turn's call is rendered plainly, so the emphasis means something.
    expect(within(within(table).getByRole("row", { name: /article_body/ })).getByText("model").tagName).toBe("TD");
  });

  // The ledger is new. An empty one is a real state and must not be rendered as a claim about the
  // world — it is a claim about the ledger.
  it("says an empty ledger means no recorded calls, not that nothing uses the project", async () => {
    renderPage(makeClient());
    await waitFor(() => expect(screen.getByText(/not that nothing uses this project/)).toBeInTheDocument());
  });
});

describe("AccessPage — controlled tools (W4.2)", () => {
  it("presents registry tools as a different kind of tool from the tenant permissions above", async () => {
    renderPage(makeClient({
      "tool.list": () => ({ tools: [
        { toolId: "capture.crawl", name: "capture.crawl", category: "capture", riskLevel: "write", reachability: { grantedBy: ["capture_crawl"], reachableFrom: [], dead: true } }
      ] })
    }));

    const panel = await waitFor(() => screen.getByLabelText("Tool administration"));
    expect(within(panel).getByText(/different kind of "tool"/)).toBeInTheDocument();
    const table = within(panel).getByLabelText("Controlled tool reachability");
    const row = within(table).getByRole("row", { name: /capture\.crawl/ });
    // The whole point of the column: granted, and callable by nothing.
    expect(within(row).getByText(/every node holding it runs a deterministic route/)).toBeInTheDocument();
  });

  it("renders capability drift with the dangerous finding first", async () => {
    renderPage(makeClient({
      "workspace.audit_capabilities": () => ({
        summary: { nodeCount: 51, modelNodes: 28, deterministicNodes: 23, nodesWithDeadGrants: 22, deadGrantCount: 60, nodesReachingTenantFromEngine: 6, nodesReachingHighRiskVerbs: ["visual_standard_materializer"] },
        nodes: [
          { nodeId: "capture_crawl", executionKind: "deterministic", deadGrants: ["capture.crawl"], engineRequiredTools: [], findings: [{ code: "grants_never_fire", detail: "Grants cannot fire.", grants: ["capture.crawl"] }] },
          { nodeId: "visual_standard_materializer", executionKind: "deterministic", deadGrants: [], engineRequiredTools: [], findings: [{ code: "high_risk_engine_verb", detail: "Reaches an admin verb from engine code.", verbs: ["site_apply_brand_imagery"] }] }
        ]
      })
    }));

    const findings = await waitFor(() => screen.getByLabelText("Capability drift findings"));
    const codes = within(findings).getAllByText(/^(high_risk_engine_verb|grants_never_fire)$/).map((element) => element.textContent);
    expect(codes[0]).toBe("high_risk_engine_verb");
  });

  it("says so plainly when the audit cannot be read, rather than showing an empty clean state", async () => {
    renderPage(makeClient({ "workspace.audit_capabilities": () => { throw new Error("down"); } }));
    await waitFor(() => expect(screen.getByText("The capability audit could not be read.")).toBeInTheDocument());
    // ...and the registry half still rendered, because the reads are settled independently.
    expect(screen.getByLabelText("Controlled tool reachability")).toBeInTheDocument();
  });
});
