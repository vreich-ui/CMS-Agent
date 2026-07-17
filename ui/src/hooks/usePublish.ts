import { useCallback, useState } from "react";
import type { McpClient } from "../mcp/client";
import { getErrorMessage } from "./useConnection";
import type { PublishReadinessInput, PublishReadinessResponse, PublishResult } from "../types/workspace";

// Drives the explicit PUBLISH gate from the UI. checkReadiness is read-only (workflow.publish_readiness,
// no side effects); publish attempts the gated publish (workflow.publish_run) which returns a dry-run
// plan, a resumable blocked_for_publish_execution safety state, an error, or — only with every gate
// satisfied — a live publish. The hook owns readiness/result/error so the panel renders them inline.
export type PublishRequest = {
  projectId: string;
  runId: string;
  requestId: string;
  approved?: boolean;
  live?: boolean;
  publishedTime?: string | null;
  readiness?: PublishReadinessInput;
};

export function usePublish(client: McpClient) {
  const [readiness, setReadiness] = useState<PublishReadinessResponse | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkReadiness = useCallback(async (input: { projectId: string; runId?: string; readiness?: PublishReadinessInput }) => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.call<{ readiness: PublishReadinessResponse }>("workflow.publish_readiness", {
        projectId: input.projectId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.readiness ? { readiness: input.readiness } : {})
      });
      setReadiness(result.readiness);
      return result.readiness;
    } catch (err) {
      setError(getErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client]);

  const publish = useCallback(async (request: PublishRequest) => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.call<{ publish: PublishResult }>("workflow.publish_run", {
        runId: request.runId,
        projectId: request.projectId,
        requestId: request.requestId,
        ...(request.approved !== undefined ? { approved: request.approved } : {}),
        ...(request.live !== undefined ? { live: request.live } : {}),
        ...(request.publishedTime !== undefined ? { publishedTime: request.publishedTime } : {}),
        ...(request.readiness ? { readiness: request.readiness } : {})
      });
      setPublishResult(result.publish);
      // Keep the readiness view in step with whatever the publish path evaluated.
      if ("readiness" in result.publish && result.publish.readiness) {
        const evaluated = result.publish.readiness;
        setReadiness((current) => ({ available: true, articleBodyValid: current?.articleBodyValid ?? true, readiness: evaluated }));
      }
      return result.publish;
    } catch (err) {
      setError(getErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client]);

  const reset = useCallback(() => {
    setReadiness(null);
    setPublishResult(null);
    setError(null);
  }, []);

  return { readiness, publishResult, loading, error, checkReadiness, publish, reset };
}
