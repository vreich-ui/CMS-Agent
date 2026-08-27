// TanStack Query hooks over verbs.ts. Query keys are structured arrays so
// invalidation can target broadly (['runs']) or precisely (['run', id]).
// Read hooks stay thin wrappers; mutation hooks invalidate the query keys a
// successful mutation should refresh. Phase 2 (WP-21+) consumes the run
// control mutation hooks directly.

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { getSession, type SessionInfo } from './client';
import * as verbs from './verbs';
import type {
  Agent,
  Dataset,
  FinetuneReadiness,
  Observation,
  Project,
  Rubric,
  Run,
  RunStatus,
  Skill,
  ToolDef,
  UsageSummary,
  Workflow,
  WorkflowNode,
} from '../types';

type Options<T> = Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>;

// ================================== reads =====================================

export function useWorkflows(options?: Options<Workflow[]>) {
  return useQuery({ queryKey: ['workflows'], queryFn: verbs.workflowList, ...options });
}

export function useNodes(workflowId?: string, options?: Options<WorkflowNode[]>) {
  return useQuery({
    queryKey: ['nodes', workflowId ?? 'all'],
    queryFn: () => verbs.workspaceGetNodes({ workflowId }),
    ...options,
  });
}

/**
 * P2-03 — the node the rail just selected is, in almost every case, already
 * in the `['nodes', wf]` list this screen fetched a moment ago. Seeding
 * `initialData` from that cache means selecting a node paints instantly
 * from data the app already holds, and the `workspace_get_node` call
 * becomes a background refresh rather than a gate in front of the
 * inspector. `initialDataUpdatedAt` is carried across so the seeded value
 * is aged correctly rather than looking eternally fresh.
 */
export function useNode(nodeId: string | null | undefined, options?: Options<WorkflowNode | null>) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['node', nodeId],
    queryFn: () => verbs.workspaceGetNode({ nodeId: nodeId as string }),
    enabled: Boolean(nodeId),
    initialData: () => {
      if (!nodeId) return undefined;
      for (const [, data] of qc.getQueriesData<WorkflowNode[]>({ queryKey: ['nodes'] })) {
        const hit = data?.find((n) => n.id === nodeId);
        if (hit) return hit;
      }
      return undefined;
    },
    initialDataUpdatedAt: () => {
      const entry = qc.getQueryCache().findAll({ queryKey: ['nodes'] })[0];
      return entry?.state.dataUpdatedAt;
    },
    ...options,
  });
}

/**
 * The active workflow's real topology — nodes AND edges — from
 * `workspace_get_graph({workflowId})`. This is the only verb that answers
 * "what does this conductor actually look like"; see workspaceGetGraph()'s
 * doc comment for why the previous no-argument call made the rail lie
 * about two of the three workflows.
 */
export function useWorkflowGraph(workflowId: string | null | undefined, options?: Options<verbs.WorkspaceGraph>) {
  return useQuery({
    queryKey: ['graph', workflowId ?? 'all'],
    queryFn: () => verbs.workspaceGetGraph(workflowId ? { workflowId } : undefined),
    enabled: workflowId !== null,
    ...options,
  });
}

export interface RunFilters {
  workflowId?: string;
  projectId?: string;
  status?: RunStatus;
  limit?: number;
}

export function useRuns(filters: RunFilters = {}, options?: Options<Run[]>) {
  return useQuery({
    queryKey: ['runs', filters],
    queryFn: () => verbs.workflowListRuns(filters),
    ...options,
  });
}

export function useRun(runId: string | null | undefined, options?: Options<Run | null>) {
  return useQuery({
    queryKey: ['run', runId],
    queryFn: () => verbs.workflowGetRun({ runId: runId as string }),
    enabled: Boolean(runId),
    ...options,
  });
}

export function useProjects(options?: Options<Project[]>) {
  return useQuery({ queryKey: ['projects'], queryFn: verbs.projectList, ...options });
}

export function useTools(options?: Options<ToolDef[]>) {
  return useQuery({ queryKey: ['tools'], queryFn: verbs.toolList, ...options });
}

/**
 * P2-03 — `skill_list` carries no `assignedTo`, so it has to be joined
 * against the workspace node list. That join used to trigger a second live
 * `workspace_get_nodes` every time. It now reuses whatever node list is
 * already cached and only fetches when there is none.
 */
export function useSkills(options?: Options<Skill[]>) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['skills'],
    queryFn: () => {
      const cached = qc.getQueryData<WorkflowNode[]>(['nodes', 'all']);
      return verbs.skillList(cached);
    },
    ...options,
  });
}

export function useObservations(nodeId?: string, options?: Options<Observation[]>) {
  return useQuery({
    queryKey: ['observations', nodeId ?? 'all'],
    queryFn: () => verbs.learningListObservations({ nodeId }),
    ...options,
  });
}

export function useRubrics(options?: Options<Rubric[]>) {
  return useQuery({ queryKey: ['rubrics'], queryFn: verbs.evaluationListRubrics, ...options });
}

export function useDatasets(options?: Options<Dataset[]>) {
  return useQuery({ queryKey: ['datasets'], queryFn: verbs.datasetList, ...options });
}

export function useUsage(workflowId?: string, options?: Options<UsageSummary>) {
  return useQuery({
    queryKey: ['usage', workflowId ?? 'all'],
    queryFn: () => verbs.usageGetSummary({ workflowId }),
    ...options,
  });
}

export function useReadiness(nodeId?: string, options?: Options<FinetuneReadiness>) {
  return useQuery({
    queryKey: ['readiness', nodeId ?? 'all'],
    queryFn: () => verbs.datasetFinetuneReadiness({ nodeId }),
    ...options,
  });
}

export function useAgents(options?: Options<Agent[]>) {
  return useQuery({ queryKey: ['agents'], queryFn: verbs.agentList, ...options });
}

/**
 * P2-03 — the run cost ledger, split out of `workflowGetRun` into its own
 * lazy query. Nothing above the fold on a run needs it, so it must not sit
 * in front of the run itself. Pass `enabled: false` (or simply do not
 * mount this hook) on surfaces that never show cost.
 */
export function useRunCost(
  runId: string | null | undefined,
  options?: Options<Awaited<ReturnType<typeof verbs.workflowGetRunCost>>>,
) {
  return useQuery({
    queryKey: ['runCost', runId],
    queryFn: () => verbs.workflowGetRunCost({ runId: runId as string }),
    enabled: Boolean(runId),
    ...options,
  });
}

export function useSession(options?: Options<SessionInfo>) {
  return useQuery({ queryKey: ['session'], queryFn: getSession, ...options });
}

// ================================ mutations ===================================
// Every hook below wraps a verbs.ts function that itself goes through
// confirmAction — see confirmAction.ts. Invalidation targets ['runs'] broadly
// (any list/filter combination) plus the specific ['run', id] the mutation
// touched, so both the runs table and a bound-run dock stay in sync.

function invalidateRun(qc: ReturnType<typeof useQueryClient>, runId: string | undefined) {
  qc.invalidateQueries({ queryKey: ['runs'] });
  if (runId) {
    qc.invalidateQueries({ queryKey: ['run', runId] });
    // The cost ledger (useRunCost, P2-03) is its own lazy query, keyed
    // separately from the run itself — every mutation that can change a
    // run's progress (pause/resume/run-next/run-until/retry/cancel/reset)
    // can also change what it's spent, so it has to be invalidated
    // alongside ['run', runId] or the dock's cost-vs-budget display goes
    // stale the moment it first loads and never updates again.
    qc.invalidateQueries({ queryKey: ['runCost', runId] });
  }
}

export function usePauseRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: verbs.workflowPauseRun,
    onSuccess: (_data, vars) => invalidateRun(qc, vars.runId),
  });
}

export function useResumeRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: verbs.workflowResumeRun,
    onSuccess: (_data, vars) => invalidateRun(qc, vars.runId),
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: verbs.workflowCancelRun,
    onSuccess: (_data, vars) => invalidateRun(qc, vars.runId),
  });
}

export function useResetRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: verbs.workflowResetRun,
    onSuccess: (_data, vars) => invalidateRun(qc, vars.runId),
  });
}

export function useRetryNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: verbs.workflowRetryNode,
    onSuccess: (_data, vars) => invalidateRun(qc, vars.runId),
  });
}

export function useRunNextNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: verbs.workflowRunNextNode,
    onSuccess: (_data, vars) => invalidateRun(qc, vars.runId),
  });
}

export function useRunUntil() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: verbs.workflowRunUntil,
    onSuccess: (_data, vars) => invalidateRun(qc, vars.runId),
  });
}

export function useStartDryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: verbs.workflowStartDryRun,
    onSuccess: (data) => invalidateRun(qc, data?.id),
  });
}

export function useSetPublishDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: verbs.workflowSetOperatorPublishDecision,
    onSuccess: (_data, vars) => invalidateRun(qc, vars.runId),
  });
}
