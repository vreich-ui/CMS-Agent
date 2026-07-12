import { useCallback, useEffect, useRef, useState } from "react";
import { listChangesArgs, type ChangeLedgerFilters } from "../changes";
import { getErrorMessage } from "./useConnection";
import type { McpClient } from "../mcp/client";
import type { RevisionDiff, WorkspaceChangeEvent, WorkspaceChangePage } from "../types/workspace";

const PAGE_SIZE = 30;

// Paged, filterable view over the immutable change ledger. Diffs are fetched lazily per expanded
// event and cached — progressive disclosure means most rows never load one.
export function useChanges(client: McpClient) {
  const [events, setEvents] = useState<WorkspaceChangeEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [filters, setFilters] = useState<ChangeLedgerFilters>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diffCache = useRef(new Map<string, RevisionDiff>());
  const requestSeq = useRef(0);

  const load = useCallback(async (activeFilters: ChangeLedgerFilters, cursor?: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const page = await client.call<WorkspaceChangePage>("changes.list", listChangesArgs(activeFilters, PAGE_SIZE, cursor));
      if (seq !== requestSeq.current) return; // a newer request superseded this one
      setEvents((current) => cursor ? [...current, ...page.events] : page.events);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setError(getErrorMessage(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  const applyFilters = useCallback((next: ChangeLedgerFilters) => {
    setEvents([]);
    setNextCursor(undefined);
    setFilters(next);
  }, []);

  const loadMore = useCallback(() => {
    if (nextCursor) void load(filters, nextCursor);
  }, [filters, load, nextCursor]);

  const refresh = useCallback(() => load(filters), [filters, load]);

  const fetchDiff = useCallback(async (fromRevisionId: string, toRevisionId: string): Promise<RevisionDiff> => {
    const key = `${fromRevisionId}->${toRevisionId}`;
    const cached = diffCache.current.get(key);
    if (cached) return cached;
    const { diff } = await client.call<{ diff: RevisionDiff }>("changes.compare", { fromRevisionId, toRevisionId });
    diffCache.current.set(key, diff);
    return diff;
  }, [client]);

  // Restore is append-only: on success the ledger is reloaded so the new restore event appears
  // at the top — the visible proof that history was extended, not rewritten.
  const restore = useCallback(async (revisionId: string, nodeId: string) => {
    const result = await client.call<{ node: unknown; workspaceVersion: number; restoredFromRevisionId: string }>(
      "changes.restore",
      { revisionId, nodeId, source: "ui", summary: `Restored ${nodeId} from revision ${revisionId}` }
    );
    await load(filters);
    return result;
  }, [client, filters, load]);

  return { events, nextCursor, filters, loading, error, applyFilters, loadMore, refresh, fetchDiff, restore };
}
