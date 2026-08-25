// Local TanStack Query hooks over api/verbs.ts, for reads WP-12's tabs need
// that src/api/hooks.ts does not yet expose (node executions, effective
// prompt, schemas, run context/cost, stage output, playbook, changes). We own
// screens/Workbench/** but not src/api/**, so these live here rather than
// growing the shared hooks file. Pattern mirrors hooks.ts exactly: thin
// useQuery wrappers, structured query keys, `enabled` gates on the id.

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import * as verbs from '../../api/verbs';
import type { Skill } from '../../types';

type Options<T> = Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>;

export function useNodeExecutions(
  nodeId: string | null | undefined,
  runId?: string,
  options?: Options<verbs.NodeExecution[]>,
) {
  return useQuery({
    queryKey: ['nodeExecutions', nodeId, runId ?? 'any'],
    queryFn: () => verbs.nodeListExecutions({ nodeId: nodeId as string, runId }),
    enabled: Boolean(nodeId),
    ...options,
  });
}

export function useEffectivePrompt(nodeId: string | null | undefined, options?: Options<verbs.EffectivePrompt>) {
  return useQuery({
    queryKey: ['effectivePrompt', nodeId],
    queryFn: () => verbs.nodeGetEffectivePrompt({ nodeId: nodeId as string }),
    enabled: Boolean(nodeId),
    ...options,
  });
}

export function useInputSchema(nodeId: string | null | undefined, options?: Options<verbs.JSONSchema>) {
  return useQuery({
    queryKey: ['inputSchema', nodeId],
    queryFn: () => verbs.nodeGetInputSchema({ nodeId: nodeId as string }),
    enabled: Boolean(nodeId),
    ...options,
  });
}

export function useEffectiveSkills(nodeId: string | null | undefined, options?: Options<Skill[]>) {
  return useQuery({
    queryKey: ['effectiveSkills', nodeId],
    queryFn: () => verbs.nodeGetEffectiveSkills({ nodeId: nodeId as string }),
    enabled: Boolean(nodeId),
    ...options,
  });
}

export function useOutputSchema(nodeId: string | null | undefined, options?: Options<verbs.JSONSchema>) {
  return useQuery({
    queryKey: ['outputSchema', nodeId],
    queryFn: () => verbs.nodeGetOutputSchema({ nodeId: nodeId as string }),
    enabled: Boolean(nodeId),
    ...options,
  });
}

/** Live schema requires both `runId` and `projectId` — see verbs.ts. */
export function useRunContext(
  runId: string | null | undefined,
  projectId: string | null | undefined,
  options?: Options<verbs.RunContext | null>,
) {
  return useQuery({
    queryKey: ['runContext', runId, projectId],
    queryFn: () => verbs.workflowGetRunContext({ runId: runId as string, projectId: projectId as string }),
    enabled: Boolean(runId) && Boolean(projectId),
    ...options,
  });
}

export function useStageOutput(
  runId: string | null | undefined,
  nodeId: string | null | undefined,
  options?: Options<verbs.StageOutput>,
) {
  return useQuery({
    queryKey: ['stageOutput', runId, nodeId],
    queryFn: () => verbs.stageGetOutput({ runId: runId as string, nodeId: nodeId as string }),
    enabled: Boolean(runId) && Boolean(nodeId),
    ...options,
  });
}

export function useChangesList(nodeId: string | null | undefined, options?: Options<verbs.ChangeRecord[]>) {
  return useQuery({
    queryKey: ['changes', nodeId],
    queryFn: () => verbs.changesList({ nodeId: nodeId as string }),
    enabled: Boolean(nodeId),
    ...options,
  });
}

export function usePlaybook(nodeId: string | null | undefined, options?: Options<verbs.Playbook>) {
  return useQuery({
    queryKey: ['playbook', nodeId],
    queryFn: () => verbs.playbookGet({ nodeId: nodeId as string }),
    enabled: Boolean(nodeId),
    ...options,
  });
}

// Added by WP-32 (Skills tab) — the effective-resolution view is specced
// against `skill_resolve_for_node` by name (HANDOFF's WP-32 line), a
// separate verb from `node_get_effective_skills` (already wired above as
// useEffectiveSkills for WP-12's read-only view) even though both resolve
// to the same mock handler today (client.ts's skillsFor()). Kept as its own
// hook/query key rather than reusing useEffectiveSkills so the verb actually
// invoked matches the spec if the two ever diverge live.
export function useSkillResolution(nodeId: string | null | undefined, options?: Options<Skill[]>) {
  return useQuery({
    queryKey: ['skillResolution', nodeId],
    queryFn: () => verbs.skillResolveForNode({ nodeId: nodeId as string }),
    enabled: Boolean(nodeId),
    ...options,
  });
}
