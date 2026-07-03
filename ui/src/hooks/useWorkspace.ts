import { useCallback, useEffect, useMemo, useState } from "react";
import type { RJSFSchema } from "@rjsf/utils";
import { callMcpTool } from "../mcp/client";
import type { ArticleBodySchema, ArticleValidationResult, McpConfig, WorkspaceDocument, WorkspaceNode } from "../types/workspace";

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

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId]);
  const selectedSchema = asSchema(selectedNode?.schema);

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
    setSelectedId((current) => current ?? nextNodes[0]?.id ?? null);
  }, [config]);

  const savePrompt = async () => {
    if (!selectedNode) return null;
    const result = await callMcpTool<{ node: WorkspaceNode; workspaceVersion?: number }>(config, "workspace.update_node_prompt", { id: selectedNode.id, prompt: promptDraft });
    setNodes((current) => current.map((node) => node.id === result.node.id ? result.node : node));
    setWorkspaceVersion(result.workspaceVersion);
    return result;
  };

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
    setSelectedId,
    setPromptDraft,
    setArticleJson,
    setArticleFormData,
    loadWorkspace,
    savePrompt,
    exportWorkspace,
    validateArticleBody
  };
}
