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

export function useNode(nodeId: string | null | undefined, options?: Options<WorkflowNode | null>) {
  return useQuery({
    queryKey: ['node', nodeId],
    queryFn: () => verbs.workspaceGetNode({ nodeId: nodeId as string }),
    enabled: Boolean(nodeId),
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

export function useSkills(options?: Options<Skill[]>) {
  return useQuery({ queryKey: ['skills'], queryFn: verbs.skillList, ...options });
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
  if (runId) qc.invalidateQueries({ queryKey: ['run', runId] });
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
