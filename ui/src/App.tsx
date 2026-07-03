import { useCallback, useEffect, useMemo, useState } from "react";
import Form, { type IChangeEvent } from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import type { RJSFSchema } from "@rjsf/utils";
import { Background, Controls, MiniMap, ReactFlow, type Node, type Edge } from "@xyflow/react";
import { callMcpMethod, callMcpTool, McpClientError } from "./mcpClient";
import type { ArticleValidationResult, WorkspaceDocument, WorkspaceNode } from "./types";

const TOKEN_KEY = "cms-agent.mcpToken";
const DEFAULT_ENDPOINT = "/api/mcp";
const sampleArticleBody = {
  schema_version: "article_body.v1",
  nodes: [{ id: "n_intro", kind: "content", visibility: "public", public: { title: "Sample title", body: "Sample body" } }]
};

const asSchema = (schema: unknown): RJSFSchema | undefined => schema && typeof schema === "object" ? schema as RJSFSchema : undefined;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const promptPreview = (prompt: string) => prompt.length > 96 ? `${prompt.slice(0, 96)}…` : prompt;

type Status = { tone: "info" | "success" | "error"; message: string } | null;
type InitializeResult = { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };

function App() {
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [nodes, setNodes] = useState<WorkspaceNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [workspaceVersion, setWorkspaceVersion] = useState<number | undefined>();
  const [articleSchema, setArticleSchema] = useState<RJSFSchema | undefined>();
  const [articleJson, setArticleJson] = useState(pretty(sampleArticleBody));
  const [articleFormData, setArticleFormData] = useState<unknown>(sampleArticleBody);
  const [validation, setValidation] = useState<ArticleValidationResult | null>(null);
  const [exportedWorkspace, setExportedWorkspace] = useState<WorkspaceDocument | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [connection, setConnection] = useState<InitializeResult | null>(null);

  const config = useMemo(() => ({ endpoint, token }), [endpoint, token]);
  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId]);
  const selectedSchema = asSchema(selectedNode?.schema);

  useEffect(() => {
    localStorage.setItem(TOKEN_KEY, token);
  }, [token]);

  useEffect(() => {
    if (selectedNode) setPromptDraft(selectedNode.prompt);
  }, [selectedNode]);

  const handleError = (error: unknown) => {
    const message = error instanceof McpClientError ? error.message : error instanceof Error ? error.message : "Unknown error";
    setStatus({ tone: "error", message });
  };

  const testConnection = async () => {
    try {
      const result = await callMcpMethod<InitializeResult>(config, "initialize", {});
      setConnection(result);
      setStatus({ tone: "success", message: `Connected to ${result.serverInfo?.name ?? "MCP server"} using protocol ${result.protocolVersion ?? "unknown"}.` });
    } catch (error) {
      setConnection(null);
      handleError(error);
    }
  };

  const loadWorkspace = useCallback(async () => {
    try {
      const [{ nodes: nextNodes }, { schema }] = await Promise.all([
        callMcpTool<{ nodes: WorkspaceNode[] }>(config, "workspace.get_nodes"),
        callMcpTool<{ schema: RJSFSchema }>(config, "article_body.get_schema")
      ]);
      setNodes(nextNodes);
      setArticleSchema(schema);
      setSelectedId((current) => current ?? nextNodes[0]?.id ?? null);
      setStatus({ tone: "success", message: "Workspace loaded from MCP." });
    } catch (error) {
      handleError(error);
    }
  }, [config]);

  const savePrompt = async () => {
    if (!selectedNode) return;
    try {
      const result = await callMcpTool<{ node: WorkspaceNode; workspaceVersion?: number }>(config, "workspace.update_node_prompt", { id: selectedNode.id, prompt: promptDraft });
      setNodes((current) => current.map((node) => node.id === result.node.id ? result.node : node));
      setWorkspaceVersion(result.workspaceVersion);
      setStatus({ tone: "success", message: `Saved prompt for ${result.node.name}.` });
    } catch (error) {
      handleError(error);
    }
  };

  const exportWorkspace = async () => {
    try {
      const document = await callMcpTool<WorkspaceDocument>(config, "workspace.export_workspace");
      setExportedWorkspace(document);
      setWorkspaceVersion(document.workspaceVersion);
      setStatus({ tone: "success", message: "Workspace exported from MCP." });
    } catch (error) {
      handleError(error);
    }
  };

  const validateArticleBody = async (articleBody: unknown) => {
    try {
      const result = await callMcpTool<ArticleValidationResult>(config, "article_body.validate", { articleBody });
      setValidation(result);
      setStatus({ tone: result.valid ? "success" : "error", message: result.valid ? "Article body is valid." : "Article body has validation issues." });
    } catch (error) {
      handleError(error);
    }
  };

  const graphNodes: Node[] = useMemo(() => nodes.map((node, index) => ({
    id: node.id,
    position: { x: 80 + (index % 3) * 280, y: 80 + Math.floor(index / 3) * 180 },
    data: { label: <div className="flow-card"><strong>{node.name}</strong><span>{node.id}</span><small>{promptPreview(node.prompt)}</small><em>{node.schema ? "Schema available" : "No schema"}</em></div> },
    className: node.id === selectedId ? "selected-flow-node" : undefined
  })), [nodes, selectedId]);
  const edges: Edge[] = useMemo(() => nodes.slice(1).map((node, index) => ({ id: `${nodes[index].id}-${node.id}`, source: nodes[index].id, target: node.id })), [nodes]);

  return <main className="app-shell">
    <header className="hero">
      <div><p className="eyebrow">CMS-Agent</p><h1>Workspace UI</h1><p>Visualize and edit workspace state through the MCP server. The MCP server remains the source of truth.</p></div>
      <div className="auth-card">
        <label>Endpoint<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
        <label>MCP bearer token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Stored in localStorage" /></label>
        <div className="auth-actions"><button onClick={testConnection}>Test connection</button><button onClick={loadWorkspace}>Load workspace</button></div>
        {connection && <p className="connection-summary">Server: <strong>{connection.serverInfo?.name ?? "unknown"}</strong><br />Protocol: <strong>{connection.protocolVersion ?? "unknown"}</strong></p>}
      </div>
    </header>

    {status && <div className={`status ${status.tone}`} role="status">{status.message}</div>}

    <section className="workspace-grid">
      <section className="panel graph-panel" aria-label="Workspace graph">
        <div className="panel-heading"><h2>Workspace graph</h2><button onClick={exportWorkspace}>Export Workspace</button></div>
        <ReactFlow nodes={graphNodes} edges={edges} onNodeClick={(_, node) => setSelectedId(node.id)} fitView><Background /><MiniMap /><Controls /></ReactFlow>
      </section>

      <aside className="panel inspector">
        <h2>Node inspector</h2>
        {selectedNode ? <>
          <dl><dt>Node ID</dt><dd>{selectedNode.id}</dd><dt>Name</dt><dd>{selectedNode.name}</dd><dt>Workspace version</dt><dd>{workspaceVersion ?? "Not returned yet"}</dd></dl>
          <label>Prompt<textarea rows={8} value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} /></label>
          <button onClick={savePrompt}>Save Prompt</button>
          <h3>Schema preview</h3><pre>{selectedSchema ? pretty(selectedSchema) : "No schema for this node."}</pre>
        </> : <p>Select a node to inspect it.</p>}
      </aside>
    </section>

    <section className="lower-grid">
      <section className="panel"><h2>Selected node schema form</h2>{selectedSchema ? <Form schema={selectedSchema} validator={validator} onSubmit={() => setStatus({ tone: "info", message: "Schema form data is visual only and is not saved." })} /> : <p>No selected node schema to render.</p>}</section>
      <section className="panel"><h2>article_body schema</h2><pre>{articleSchema ? pretty(articleSchema) : "Load the workspace to fetch article_body.get_schema."}</pre></section>
      <section className="panel validator-panel"><h2>Article body validator</h2><div className="split"><div><h3>JSON input</h3><textarea rows={12} value={articleJson} onChange={(event) => setArticleJson(event.target.value)} /><button onClick={() => { try { void validateArticleBody(JSON.parse(articleJson)); } catch { setStatus({ tone: "error", message: "JSON input is not valid JSON." }); } }}>Validate JSON</button></div><div><h3>RJSF input</h3>{articleSchema ? <Form schema={articleSchema} validator={validator} formData={articleFormData} onChange={(event: IChangeEvent) => setArticleFormData(event.formData)} onSubmit={(event: IChangeEvent) => validateArticleBody(event.formData)} /> : <p>Load schema first.</p>}</div></div>{validation && <div><h3>Validation result</h3><pre>{pretty(validation)}</pre></div>}</section>
      <section className="panel"><h2>Workspace export</h2><pre>{exportedWorkspace ? pretty(exportedWorkspace) : "Click Export Workspace to view the current MCP workspace document."}</pre></section>
    </section>
  </main>;
}

export default App;
