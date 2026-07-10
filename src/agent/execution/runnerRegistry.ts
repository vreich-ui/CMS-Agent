import type { ExecutionMode } from "./executionContext.js";
import type { NodeRunner } from "./runners/NodeRunner.js";
import { MockNodeRunner } from "./runners/MockNodeRunner.js";
import { OpenAINodeRunner } from "./runners/OpenAINodeRunner.js";
const runners: NodeRunner[] = [new MockNodeRunner(), new OpenAINodeRunner()];
export function getNodeRunner(mode: ExecutionMode): NodeRunner { const runner = runners.find((r) => r.supports(mode)); if (!runner) throw new Error(`Unsupported execution mode: ${mode}`); return runner; }
export function listNodeRunners() { return [...runners]; }
