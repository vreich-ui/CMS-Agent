export interface ObservabilityAdapter {
  runStarted(metadata: Record<string, unknown>): void;
  runEnded(metadata: Record<string, unknown>): void;
  runErrored(metadata: Record<string, unknown>, error: unknown): void;
  toolCalled(metadata: Record<string, unknown>): void;
}
