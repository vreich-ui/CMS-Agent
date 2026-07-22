import type { ExecutionMode } from "./executionContext.js";
import type { NodeRunner } from "./runners/NodeRunner.js";
import { MockNodeRunner } from "./runners/MockNodeRunner.js";
import { OpenAINodeRunner } from "./runners/OpenAINodeRunner.js";
import { AnthropicNodeRunner } from "./runners/AnthropicNodeRunner.js";

const runners: NodeRunner[] = [new MockNodeRunner(), new OpenAINodeRunner()];
// Phase 6 (docs/platform/DIRECTION.md §6): the native Anthropic runner is selected by PROVIDER, not by
// ExecutionMode — a node/rubric whose modelConfig.provider is "anthropic" runs on the Messages API
// directly instead of the OpenAI-compatible path. It is held outside the mode-indexed `runners` list so
// mode-based lookup is unchanged; getNodeRunner routes to it only when the caller passes an anthropic
// modelConfig for a live (non-mock) mode.
const anthropicRunner = new AnthropicNodeRunner();
const isAnthropicProvider = (modelConfig?: Record<string, unknown>): boolean =>
  typeof modelConfig?.provider === "string" && modelConfig.provider.trim().toLowerCase() === "anthropic";

export function getNodeRunner(mode: ExecutionMode, modelConfig?: Record<string, unknown>): NodeRunner {
  if (mode !== "mock" && isAnthropicProvider(modelConfig)) return anthropicRunner;
  const runner = runners.find((r) => r.supports(mode));
  if (!runner) throw new Error(`Unsupported execution mode: ${mode}`);
  return runner;
}
export function listNodeRunners() { return [...runners, anthropicRunner]; }
export const __test__ = { anthropicRunner, isAnthropicProvider };
