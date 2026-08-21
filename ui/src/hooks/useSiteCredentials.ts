import { useCallback, useEffect, useRef, useState } from "react";
import type { McpClient } from "../mcp/client";
import { getErrorMessage } from "./useConnection";
import { isTerminalExecutionState } from "../siteCredentials";
import type { SiteCredentialApplyResult, SiteCredentialExecutionStatus, SiteCredentialPlan } from "../types/workspace";

// How often to re-poll site_credentials_execution_status while a repair is in flight. Exported so
// tests can advance fake timers by exactly this amount instead of guessing.
export const SITE_CREDENTIALS_POLL_INTERVAL_MS = 5000;

// Drives the tenant scoped-bearer repair panel. site_credentials_plan is read-only and safe to
// call on mount (mirrors useProjects' auto-load-on-[client] shape); site_credentials_apply fires a
// long-running Cloud Run Job and returns immediately, so this hook owns the poll loop against
// site_credentials_execution_status until the execution reaches a terminal state — the panel only
// ever renders state this hook already resolved, never drives fetch/poll timing itself.
export function useSiteCredentials(client: McpClient) {
  const [plan, setPlan] = useState<SiteCredentialPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [executionName, setExecutionName] = useState<string | null>(null);
  const [jobName, setJobName] = useState<string | null>(null);
  const [execution, setExecution] = useState<SiteCredentialExecutionStatus | null>(null);
  // true from the moment apply() is confirmed until the polled execution reaches a terminal
  // state (or the request to fire it fails outright) — this is what the panel disables the
  // button on, distinct from planLoading which only covers the fast read-only plan fetch.
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Recursive-setTimeout handle for the in-flight poll (never setInterval, so a slow status call
  // can never overlap the next tick). pollGeneration is bumped by cancelPoll every time polling is
  // intentionally stopped or restarted (unmount, client change, a fresh apply); every scheduled
  // continuation captures its generation and checks it before doing anything further, so an
  // in-flight status fetch that resolves AFTER cancellation can update state harmlessly but can
  // never resurrect a timer — that's what actually prevents the leak, not just clearTimeout, since
  // clearTimeout alone can't cancel a fetch that's already in flight when cancelPoll runs.
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGeneration = useRef(0);
  const cancelPoll = useCallback(() => {
    pollGeneration.current += 1;
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const refreshPlan = useCallback(async () => {
    // Reset before fetching, same as useProjects.refresh — an endpoint/token change must never
    // leave the PREVIOUS connection's tenant plan on screen while the new one loads.
    setPlan(null);
    setPlanLoading(true);
    setPlanError(null);
    try {
      const result = await client.call<SiteCredentialPlan>("site_credentials_plan", {});
      setPlan(result);
      return result;
    } catch (err) {
      setPlanError(getErrorMessage(err));
      throw err;
    } finally {
      setPlanLoading(false);
    }
  }, [client]);

  // One status check. Returns whether the execution has reached a terminal state, so callers
  // decide whether to schedule another poll.
  const checkStatusOnce = useCallback(async (name: string): Promise<boolean> => {
    try {
      const status = await client.call<SiteCredentialExecutionStatus>("site_credentials_execution_status", { executionName: name });
      setExecution(status);
      if (isTerminalExecutionState(status.state)) {
        setApplying(false);
        // The fleet just finished rebuilding (or failing to) — refresh the plan so the tenant
        // list reflects reality instead of the pre-repair snapshot, without the operator having
        // to remember to hit Refresh themselves.
        void refreshPlan().catch(() => {});
        return true;
      }
      return false;
    } catch (err) {
      // A transient status-check failure must not silently end the poll, nor claim the fleet
      // rebuild finished — the Cloud Run Job keeps running regardless of whether this fetch
      // succeeded. Surface the error and report "not yet terminal" so polling continues.
      setApplyError(getErrorMessage(err));
      return false;
    }
  }, [client, refreshPlan]);

  const schedulePoll = useCallback((name: string, generation: number) => {
    pollTimer.current = setTimeout(() => {
      pollTimer.current = null;
      if (pollGeneration.current !== generation) return; // superseded by cancelPoll since this fired
      void checkStatusOnce(name).then((terminal) => {
        if (pollGeneration.current !== generation) return; // superseded while the status fetch was in flight
        if (!terminal) schedulePoll(name, generation);
      });
    }, SITE_CREDENTIALS_POLL_INTERVAL_MS);
  }, [checkStatusOnce]);

  const apply = useCallback(async () => {
    cancelPoll(); // also invalidates any poll left over from a previous apply
    const generation = pollGeneration.current;
    setApplyError(null);
    setExecution(null);
    setApplying(true);
    try {
      const result = await client.call<SiteCredentialApplyResult>("site_credentials_apply", {});
      setExecutionName(result.executionName);
      setJobName(result.jobName);
      // Check once immediately for fast feedback instead of waiting a full poll interval before
      // showing anything, then fall back to the regular interval for everything after.
      const terminal = await checkStatusOnce(result.executionName);
      if (pollGeneration.current === generation && !terminal) schedulePoll(result.executionName, generation);
      return result;
    } catch (err) {
      setApplying(false);
      setApplyError(getErrorMessage(err));
      throw err;
    }
  }, [client, cancelPoll, checkStatusOnce, schedulePoll]);

  // Cancel any outstanding poll on unmount — otherwise a repair kicked off just before navigating
  // away (or closing the tab) would keep firing site_credentials_execution_status forever.
  useEffect(() => cancelPoll, [cancelPoll]);

  // A plan, execution name, and poll are all meaningless (and actively misleading) once the UI
  // points at a different MCP connection — clear everything and cancel any outstanding poll the
  // instant the client changes, then let the mount-effect below reload the plan for the new one.
  useEffect(() => {
    cancelPoll();
    setExecutionName(null);
    setJobName(null);
    setExecution(null);
    setApplying(false);
    setApplyError(null);
  }, [client, cancelPoll]);

  useEffect(() => {
    void refreshPlan().catch(() => {});
  }, [refreshPlan]);

  return {
    plan,
    planLoading,
    planError,
    refreshPlan,
    executionName,
    jobName,
    execution,
    applying,
    applyError,
    apply
  };
}
