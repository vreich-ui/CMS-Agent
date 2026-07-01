import type { ObservabilityAdapter } from "./ObservabilityAdapter.js";

function sanitize(metadata: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !/authorization|token|api[_-]?key|cookie/i.test(key)));
}

export const consoleObservability: ObservabilityAdapter = {
  runStarted: (metadata) => console.info("agent.run.started", sanitize(metadata)),
  runEnded: (metadata) => console.info("agent.run.ended", sanitize(metadata)),
  runErrored: (metadata, error) => console.error("agent.run.errored", sanitize({ ...metadata, error: error instanceof Error ? error.message : String(error) })),
  toolCalled: (metadata) => console.info("agent.tool.called", sanitize(metadata))
};
