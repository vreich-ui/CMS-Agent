import { useEffect, useMemo, useState } from "react";
import { callMcpTool } from "../mcp/client";
import type { McpConfig, WorkspaceNode } from "../types/workspace";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const parseJson = (value: string) => value.trim() ? JSON.parse(value) : {};

type Props = { config: McpConfig; nodes: WorkspaceNode[]; selectedNodeId?: string | null; onSelectNode: (nodeId: string) => void; onError: (error: unknown) => void; onStatus: (message: string) => void };

export function NodeConsole({ config, nodes, selectedNodeId, onSelectNode, onError, onStatus }: Props) {
  const [inputJson, setInputJson] = useState("{}");
  const [inspection, setInspection] = useState<unknown>(null);
  const [preparation, setPreparation] = useState<unknown>(null);
  const [execution, setExecution] = useState<unknown>(null);
  const [latestOutput, setLatestOutput] = useState<unknown>(null);
  const [history, setHistory] = useState<unknown[]>([]);
  const [validation, setValidation] = useState<unknown>(null);
  const selected = useMemo(() => nodes.find((node) => node.id === selectedNodeId), [nodes, selectedNodeId]);

  const inspect = async () => {
    if (!selectedNodeId) return;
    try {
      const [node, prompt, skills, tools] = await Promise.all([
        callMcpTool(config, "node.get", { nodeId: selectedNodeId }),
        callMcpTool(config, "node.get_effective_prompt", { nodeId: selectedNodeId }),
        callMcpTool(config, "node.get_effective_skills", { nodeId: selectedNodeId }),
        callMcpTool(config, "node.get_effective_tools", { nodeId: selectedNodeId })
      ]);
      setInspection({ node, prompt, skills, tools });
      onStatus(`Inspected ${selectedNodeId}.`);
    } catch (error) { onError(error); }
  };

  const prepare = async () => {
    if (!selectedNodeId) return;
    try {
      const result = await callMcpTool(config, "node.prepare_execution", { nodeId: selectedNodeId, input: parseJson(inputJson) });
      setPreparation(result);
      onStatus(`Prepared ${selectedNodeId}.`);
    } catch (error) { onError(error); }
  };

  const execute = async () => {
    if (!selectedNodeId) return;
    try {
      const result = await callMcpTool(config, "node.execute", { nodeId: selectedNodeId, input: parseJson(inputJson), executionMode: "mock" });
      setExecution(result);
      await refreshOutputs();
      onStatus(`Executed ${selectedNodeId}.`);
    } catch (error) { onError(error); }
  };

  const validate = async () => {
    if (!selectedNodeId) return;
    try {
      const result = await callMcpTool(config, "node.validate_input", { nodeId: selectedNodeId, value: parseJson(inputJson) });
      setValidation(result);
      onStatus(`Validated input for ${selectedNodeId}.`);
    } catch (error) { onError(error); }
  };

  const refreshOutputs = async () => {
    if (!selectedNodeId) return;
    try {
      const [outputResult, historyResult] = await Promise.all([
        callMcpTool<{ output: unknown }>(config, "node.get_latest_output", { nodeId: selectedNodeId }),
        callMcpTool<{ executions: unknown[] }>(config, "node.list_executions", { nodeId: selectedNodeId })
      ]);
      setLatestOutput(outputResult.output);
      setHistory(historyResult.executions ?? []);
    } catch (error) { onError(error); }
  };

  useEffect(() => { void refreshOutputs(); }, [selectedNodeId]);

  return <section className="panel node-console">
    <div className="panel-heading"><div><h2>Node Console</h2><p className="muted">Inspect, prepare, validate, execute, and retrieve outputs for one node without running the full workflow.</p></div><button onClick={inspect} disabled={!selectedNodeId}>Inspect</button></div>
    <label>Node<select value={selectedNodeId ?? ""} onChange={(event) => onSelectNode(event.target.value)}><option value="" disabled>Select a node</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
    {selected && <p className="muted">{selected.description}</p>}
    <label>Test input JSON<textarea value={inputJson} onChange={(event) => setInputJson(event.target.value)} rows={8} spellCheck={false} /></label>
    <div className="auth-actions"><button onClick={validate} disabled={!selectedNodeId}>Validate input</button><button onClick={prepare} disabled={!selectedNodeId}>Prepare execution</button><button onClick={execute} disabled={!selectedNodeId}>Execute node</button><button onClick={refreshOutputs} disabled={!selectedNodeId}>Refresh history</button></div>
    <div className="console-grid"><section><h3>Inspection</h3><pre>{inspection ? pretty(inspection) : "Inspect effective prompt, skills, tools, schemas, and latest output."}</pre></section><section><h3>Preparation</h3><pre>{preparation ? pretty(preparation) : "No preparation yet."}</pre></section><section><h3>Validation</h3><pre>{validation ? pretty(validation) : "No validation yet."}</pre></section><section><h3>Structured output</h3><pre>{latestOutput ? pretty(latestOutput) : execution ? pretty(execution) : "No output yet."}</pre></section><section><h3>Execution history</h3><pre>{history.length ? pretty(history) : "No independent executions yet."}</pre></section></div>
  </section>;
}
