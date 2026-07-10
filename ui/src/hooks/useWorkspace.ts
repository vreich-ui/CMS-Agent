import { useCallback, useEffect, useMemo, useState } from "react";
import type { RJSFSchema } from "@rjsf/utils";
import { callMcpTool } from "../mcp/client";
import type { ArticleBodySchema, ArticleValidationResult, McpConfig, RepositoryHealthSummary, WorkspaceDocument, WorkspaceNode } from "../types/workspace";

const sampleArticleBody = {
  schema_version: "article_body.v1",
  nodes: [{ id: "n_intro", kind: "content", visibility: "public", public: { title: "Sample title", body: "Sample body" } }]
};

const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const asSchema = (schema: unknown): RJSFSchema | undefined => schema && typeof schema === "object" ? schema as RJSFSchema : undefined;

export function useWorkspace(config: McpConfig) {
  const [nodes, setNodes] = useState<WorkspaceNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [workspaceVersion, setWorkspaceVersion] = useState<number | undefined>();
  const [articleSchema, setArticleSchema] = useState<ArticleBodySchema | undefined>();
  const [articleJson, setArticleJson] = useState(pretty(sampleArticleBody));
  const [articleFormData, setArticleFormData] = useState<unknown>(sampleArticleBody);
  const [validation, setValidation] = useState<ArticleValidationResult | null>(null);
  const [exportedWorkspace, setExportedWorkspace] = useState<WorkspaceDocument | null>(null);
  const [repositoryHealth, setRepositoryHealth] = useState<RepositoryHealthSummary | null>(null);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId]);
  const selectedSchema = asSchema(selectedNode?.outputSchema ?? selectedNode?.schema);

  useEffect(() => {
    if (selectedNode) setPromptDraft(selectedNode.prompt);
  }, [selectedNode]);

  const loadWorkspace = useCallback(async () => {
    const [{ nodes: nextNodes }, { schema }] = await Promise.all([
      callMcpTool<{ nodes: WorkspaceNode[] }>(config, "workspace.get_nodes"),
      callMcpTool<{ schema: ArticleBodySchema }>(config, "article_body.get_schema")
    ]);
    setNodes(nextNodes);
    setArticleSchema(schema);
    setWorkspaceVersion((await callMcpTool<WorkspaceDocument>(config, "workspace.export_workspace")).workspaceVersion);
    setSelectedId((current) => current ?? nextNodes[0]?.id ?? null);
  }, [config]);

  const mutationArgs = (summary: string) => ({ expectedWorkspaceVersion: workspaceVersion ?? 0, summary });

  const savePrompt = async () => {
    if (!selectedNode) return null;
    const result = await callMcpTool<{ node: WorkspaceNode; workspaceVersion?: number }>(config, "workspace.update_node_prompt", { id: selectedNode.id, prompt: promptDraft, ...mutationArgs("UI prompt update") });
    setNodes((current) => current.map((node) => node.id === result.node.id ? result.node : node));
    setWorkspaceVersion(result.workspaceVersion);
    return result;
  };

  const refreshNodes = async (nextVersion?: number) => { const { nodes: nextNodes } = await callMcpTool<{ nodes: WorkspaceNode[] }>(config, "workspace.get_nodes"); setNodes(nextNodes); if (nextVersion !== undefined) setWorkspaceVersion(nextVersion); };
  const createNode = async () => { const id = `custom_${Date.now()}`; const result = await callMcpTool<{ node: WorkspaceNode; workspaceVersion: number }>(config, "workspace.create_node", { node: { id, name: "New node", kind: "custom", description: "", prompt: "", inputSchema: { type: "object" }, outputSchema: { type: "object" }, allowedTools: [], assignedSkills: [], requiredInputs: [], produces: [], dependsOn: [], riskLevel: "read", status: "draft", position: { x: 0, y: nodes.length * 96 }, updatedAt: new Date().toISOString() }, ...mutationArgs("UI create node") }); await refreshNodes(result.workspaceVersion); setSelectedId(result.node.id); return result; };
  const cloneNode = async () => { if (!selectedNode) return null; const result = await callMcpTool<{ node: WorkspaceNode; workspaceVersion: number }>(config, "workspace.clone_node", { id: selectedNode.id, newId: `${selectedNode.id}_copy_${Date.now()}`, ...mutationArgs("UI clone node") }); await refreshNodes(result.workspaceVersion); setSelectedId(result.node.id); return result; };
  const deleteNode = async () => { if (!selectedNode) return null; const result = await callMcpTool<{ workspaceVersion: number }>(config, "workspace.delete_node", { id: selectedNode.id, ...mutationArgs("UI delete node") }); await refreshNodes(result.workspaceVersion); setSelectedId(null); return result; };
  const updateNodePatch = async (patch: Partial<WorkspaceNode>, summary: string) => { if (!selectedNode) return null; const result = await callMcpTool<{ node: WorkspaceNode; workspaceVersion: number }>(config, "workspace.update_node", { id: selectedNode.id, patch, ...mutationArgs(summary) }); await refreshNodes(result.workspaceVersion); return result; };
  const updateOutputSchema = async (schema: unknown) => { if (!selectedNode) return null; const result = await callMcpTool<{ node: WorkspaceNode; workspaceVersion: number }>(config, "workspace.update_node_output_schema", { id: selectedNode.id, schema, ...mutationArgs("UI output schema update") }); await refreshNodes(result.workspaceVersion); return result; };
  const reorderNodes = async (orderedNodeIds: string[]) => { const result = await callMcpTool<{ workspaceVersion: number }>(config, "workspace.reorder_nodes", { orderedNodeIds, ...mutationArgs("UI graph reorder") }); await refreshNodes(result.workspaceVersion); return result; };
  const validateGraph = async () => callMcpTool<{ validation: { valid: boolean; issues: string[] } }>(config, "workspace.validate_graph", {});

  const exportWorkspace = async () => {
    const document = await callMcpTool<WorkspaceDocument>(config, "workspace.export_workspace");
    setExportedWorkspace(document);
    setWorkspaceVersion(document.workspaceVersion);
    return document;
  };

  const validateArticleBody = async (articleBody: unknown) => {
    const result = await callMcpTool<ArticleValidationResult>(config, "article_body.validate", { articleBody });
    setValidation(result);
    return result;
  };

  const loadRepositoryHealth = async () => {
    const result = await callMcpTool<{ health: RepositoryHealthSummary }>(config, "repository.get_health");
    setRepositoryHealth(result.health);
    return result.health;
  };

  return {
    nodes,
    selectedId,
    selectedNode,
    selectedSchema,
    promptDraft,
    workspaceVersion,
    articleSchema,
    articleJson,
    articleFormData,
    validation,
    exportedWorkspace,
    repositoryHealth,
    setSelectedId,
    setPromptDraft,
    setArticleJson,
    setArticleFormData,
    loadWorkspace,
    savePrompt,
    createNode,
    cloneNode,
    deleteNode,
    updateNodePatch,
    updateOutputSchema,
    reorderNodes,
    validateGraph,
    exportWorkspace,
    validateArticleBody,
    loadRepositoryHealth
  };
}
