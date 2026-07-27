import { useCallback, useEffect, useRef, useState } from "react";
import type { McpClient } from "../mcp/client";
import type { EffectivePrompt, EffectiveTool } from "../nodeInspector";
import type { SkillDefinition, SkillResolvedPolicy } from "../types/workspace";

// Effective-layer loader for the S4 inspector (CHANGE-PLAN R-11, read-only phase).
//
// Three resolver reads per node, all read-only, all served by the workspace itself — no client
// connection required, which is why the Effective layer is always available while Identity is not:
//
//   node.get_effective_prompt  -> the prompt that actually runs, incl. injected skill instructions
//   node.get_effective_tools   -> per-tool allowed/denied with the resolver's denialReasons
//   node.get_effective_skills  -> the resolved skill policy incl. its conflicts array
//
// Failures are per-read, not all-or-nothing: if the skill policy read fails, the Tools tab still
// renders. A tab with no data says so rather than rendering an empty state that reads as "clean".

export type NodeInspectorState = {
  effectivePrompt: EffectivePrompt | null;
  effectiveTools: EffectiveTool[] | null;
  skillPolicy: SkillResolvedPolicy | null;
  // The registry the Skills tab offers for assignment. Workspace-wide rather than per-node, so a
  // failure here disables assignment without touching the rest of the inspector.
  skills: SkillDefinition[] | null;
  loading: boolean;
  errors: string[];
  fetchedAt: string | null;
  reload: () => Promise<void>;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useNodeInspector(client: McpClient, nodeId: string | null): NodeInspectorState {
  const [effectivePrompt, setEffectivePrompt] = useState<EffectivePrompt | null>(null);
  const [effectiveTools, setEffectiveTools] = useState<EffectiveTool[] | null>(null);
  const [skillPolicy, setSkillPolicy] = useState<SkillResolvedPolicy | null>(null);
  const [skills, setSkills] = useState<SkillDefinition[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  // Guards against a slow response for node A (or for a previous connection) landing after the
  // operator has already selected node B — the same out-of-order defence useWorkspace uses.
  const activeRequest = useRef(0);

  const reload = useCallback(async () => {
    if (!nodeId) {
      setEffectivePrompt(null);
      setEffectiveTools(null);
      setSkillPolicy(null);
      setSkills(null);
      setErrors([]);
      setFetchedAt(null);
      setLoading(false);
      return;
    }

    const requestId = ++activeRequest.current;
    setLoading(true);
    setErrors([]);

    const [prompt, tools, skills, registry] = await Promise.allSettled([
      client.call<EffectivePrompt>("node.get_effective_prompt", { nodeId }),
      client.call<{ tools: EffectiveTool[] }>("node.get_effective_tools", { nodeId }),
      client.call<{ policy: SkillResolvedPolicy }>("node.get_effective_skills", { nodeId }),
      client.call<{ skills: SkillDefinition[] }>("skill.list")
    ]);

    if (requestId !== activeRequest.current) return;

    const failures: string[] = [];
    setEffectivePrompt(prompt.status === "fulfilled" ? prompt.value : null);
    if (prompt.status === "rejected") failures.push(`Effective prompt unavailable: ${errorMessage(prompt.reason)}`);

    setEffectiveTools(tools.status === "fulfilled" ? tools.value.tools ?? [] : null);
    if (tools.status === "rejected") failures.push(`Effective tools unavailable: ${errorMessage(tools.reason)}`);

    setSkillPolicy(skills.status === "fulfilled" ? skills.value.policy ?? null : null);
    if (skills.status === "rejected") failures.push(`Skill policy unavailable: ${errorMessage(skills.reason)}`);

    setSkills(registry.status === "fulfilled" ? registry.value.skills ?? [] : null);
    if (registry.status === "rejected") failures.push(`Skill registry unavailable: ${errorMessage(registry.reason)}`);

    setErrors(failures);
    setFetchedAt(failures.length === 4 ? null : new Date().toISOString());
    setLoading(false);
  }, [client, nodeId]);

  useEffect(() => {
    // Reset synchronously before the fetch so a node switch never shows the previous node's
    // resolved tools next to the new node's name.
    setEffectivePrompt(null);
    setEffectiveTools(null);
    setSkillPolicy(null);
    setSkills(null);
    setFetchedAt(null);
    void reload();
  }, [reload]);

  return { effectivePrompt, effectiveTools, skillPolicy, skills, loading, errors, fetchedAt, reload };
}
