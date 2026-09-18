// CMS-Agent track A (2026-09-18) — the one shared "which playbook scope am I
// looking at" selection for the whole Learning surface + the node-level
// Learning tab (Workbench/tabs/LearningTab.tsx). Same module-external
// useSyncExternalStore pattern as ./overlay.ts, for the same reason: this is
// UI selection state that several unrelated screens read and write, and it
// has to survive navigating between them (pick a tenant once, it stays
// picked). It is NOT app-wide navigation state (screen/tab), so it does not
// belong in ../../store.ts — see activityNav.ts's own header for the same
// precedent of keeping a cross-screen-but-Learning-scoped concern local.
//
// Why "unselected" is a real third state, not just "fleet by default": the
// backend's playbook.get/playbook.apply_delta treat an OMITTED projectId as
// an explicit request for the FLEET record (see improvementTools.ts's own
// doc comment on playbook.get). If this module defaulted to the fleet scope
// silently, a curated lesson typed before the operator ever looked at the
// scope control would land in the fleet playbook — the one every tenant's
// dispatch reads — without anyone deciding that on purpose. So the default
// is a genuine "nothing chosen yet" state that disables every playbook read
// and mutation until the operator picks either a tenant or Fleet explicitly.

import { useSyncExternalStore } from 'react';

export type PlaybookScope = { kind: 'unselected' } | { kind: 'fleet' } | { kind: 'project'; projectId: string };

export const UNSELECTED_SCOPE: PlaybookScope = { kind: 'unselected' };
export const FLEET_SCOPE: PlaybookScope = { kind: 'fleet' };
export const projectScope = (projectId: string): PlaybookScope => ({ kind: 'project', projectId });

/** The `projectId` argument to send on the wire — `undefined` means "omit it", which IS the backend's own spelling of the fleet scope. Never called while `kind === 'unselected'`; callers gate reads/mutations on that separately. */
export function scopeProjectId(scope: PlaybookScope): string | undefined {
  return scope.kind === 'project' ? scope.projectId : undefined;
}

export function scopeLabel(scope: PlaybookScope, projects: ReadonlyArray<{ id: string; name: string }>): string {
  if (scope.kind === 'unselected') return 'no scope selected';
  if (scope.kind === 'fleet') return 'Fleet — shared by every tenant';
  const project = projects.find((p) => p.id === scope.projectId);
  return project ? `${project.name} (${project.id})` : scope.projectId;
}

let scope: PlaybookScope = UNSELECTED_SCOPE;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot(): PlaybookScope {
  return scope;
}

export function setLearnScope(next: PlaybookScope): void {
  scope = next;
  emit();
}

export function getLearnScope(): PlaybookScope {
  return scope;
}

export function useLearnScope(): PlaybookScope {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
