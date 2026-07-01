import type { MemoryAdapter } from "./MemoryAdapter.js";
import { normalizeMemoryEnvelope, type MemoryEnvelope } from "./memoryEnvelope.js";

export class JsonMemoryAdapter implements MemoryAdapter {
  async importMemory(input: unknown, defaults: { projectId: string; userId?: string; threadId?: string }): Promise<MemoryEnvelope> {
    return normalizeMemoryEnvelope(input, defaults);
  }

  async exportMemory(memory: MemoryEnvelope): Promise<MemoryEnvelope> {
    return { ...memory, updatedAt: new Date().toISOString() };
  }
}
