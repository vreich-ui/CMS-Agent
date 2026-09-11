// The operation registry (A2). Mirrors workflowRegistry.ts's shape and discipline exactly: a
// module-level Map, a register function that throws on a duplicate key, and lookup helpers with no
// fallback to caller-supplied data.
//
// LOOKUP IS BY REGISTERED ID ONLY. No operation id, tool name, authority, scope, or principal may
// ever be accepted from a model-proposed plan and treated as though it were registered — that is
// the entire point of this module existing as a closed, code-defined catalog rather than an open
// dispatch table. getOperation() on an id nobody registered returns a STRUCTURED "unknown operation"
// result naming the real, registered alternatives; it never falls through to a pass-through, never
// echoes the caller's string back as though it were now a usable id, and never guesses. A caller
// (a model turn included) gets exactly one way to reach a real OperationDescriptor: name an id this
// module actually holds.
import { OPERATION_ID_PATTERN, type OperationDescriptor } from "./operationTypes.js";

const registry = new Map<string, OperationDescriptor>(); // key: `${operationId}@${version}`
const latestVersionByOperationId = new Map<string, number>();

export function registerOperation(descriptor: OperationDescriptor): void {
  if (!OPERATION_ID_PATTERN.test(descriptor.operationId)) {
    throw new Error(`Invalid operationId (must be snake_case): ${descriptor.operationId}`);
  }
  if (!Number.isInteger(descriptor.version) || descriptor.version < 1) {
    throw new Error(`Invalid version for operation ${descriptor.operationId}: ${descriptor.version} (must be a positive integer)`);
  }
  const key = `${descriptor.operationId}@${descriptor.version}`;
  if (registry.has(key)) throw new Error(`Operation already registered: ${key}`);
  registry.set(key, descriptor);
  const currentLatest = latestVersionByOperationId.get(descriptor.operationId);
  if (currentLatest === undefined || descriptor.version > currentLatest) {
    latestVersionByOperationId.set(descriptor.operationId, descriptor.version);
  }
}

export const listOperationIds = (): string[] => [...latestVersionByOperationId.keys()].sort((left, right) => left.localeCompare(right));

export type OperationLookupResult =
  | { found: true; descriptor: OperationDescriptor }
  | { found: false; operationId: string; registeredOperationIds: string[] };

// version omitted -> latest registered version for that operationId. An id nobody registered, or a
// version nobody registered under that id, both come back as the SAME structured "not found" shape
// — a caller does not get to distinguish "typo'd the id" from "guessed a version" by probing this
// function, which is deliberate: neither answer reveals more than "here is what IS registered".
export function getOperation(operationId: string, version?: number): OperationLookupResult {
  const resolvedVersion = version ?? latestVersionByOperationId.get(operationId);
  const descriptor = resolvedVersion === undefined ? undefined : registry.get(`${operationId}@${resolvedVersion}`);
  if (!descriptor) return { found: false, operationId, registeredOperationIds: listOperationIds() };
  return { found: true, descriptor };
}

// Latest version of every registered operationId, sorted by operationId — deterministic, no clock,
// no randomness, safe to snapshot for a diff.
export function listOperations(): OperationDescriptor[] {
  return listOperationIds()
    .map((operationId) => registry.get(`${operationId}@${latestVersionByOperationId.get(operationId)}`))
    .filter((descriptor): descriptor is OperationDescriptor => Boolean(descriptor));
}

// Every registered version of one operationId, oldest first.
export function listOperationVersions(operationId: string): OperationDescriptor[] {
  return [...registry.values()]
    .filter((descriptor) => descriptor.operationId === operationId)
    .sort((left, right) => left.version - right.version);
}

// Test-only: clears the registry so tests can register a private fixture catalog without colliding
// with the six production descriptors (registerOperations.ts) or with each other across test files.
export function __resetOperationCatalogForTests(): void {
  registry.clear();
  latestVersionByOperationId.clear();
}
