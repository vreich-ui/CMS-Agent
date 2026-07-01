import type { MemoryEnvelope } from "./memoryEnvelope.js";

export interface MemoryAdapter {
  importMemory(input: unknown, defaults: { projectId: string; userId?: string; threadId?: string }): Promise<MemoryEnvelope>;
  exportMemory(memory: MemoryEnvelope): Promise<MemoryEnvelope>;
}
