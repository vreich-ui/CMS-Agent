// Local TanStack Query hook over api/verbs.ts's project_test_connection.
// src/api/hooks.ts does not expose this verb yet, and we own
// screens/Registry/** but not src/api/** — same pattern as
// screens/Workbench/queries.ts. project_test_connection is a READ verb
// (HANDOFF §6: absent from MUTATING_VERBS in api/client.ts), so verbs.ts
// calls it via callVerb directly, never confirmAction — useMutation here is
// just React Query's imperative-trigger shape, not a mutation gate.

import { useMutation } from '@tanstack/react-query';
import * as verbs from '../../api/verbs';

export function useTestConnection() {
  return useMutation({
    mutationFn: (args: { projectId: string }) => verbs.projectTestConnection(args),
  });
}

/** `err.message` if it's an Error (McpError included), else the fallback. */
export function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
