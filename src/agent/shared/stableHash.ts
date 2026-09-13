// Shared, deterministic hashing helpers. Extracted from noProgressFingerprint.ts (R2 Piece 1) so a
// second caller (capabilityGapTypes.ts, R2 Piece 2 — the "normalized requested outcome" component of
// a capability-gap record's identity) hashes values the identical way rather than growing its own
// copy. Pure: no I/O, no clock, no randomness — same input always yields the same output.
import { createHash } from "node:crypto";

/**
 * Stable, order-independent JSON stringification: object keys are sorted recursively so two
 * logically identical values (same keys, same values, different insertion order) stringify — and
 * therefore hash — identically. Arrays keep their own order (order is usually meaningful there);
 * `undefined`/functions/symbols drop out exactly as JSON.stringify already does.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}
function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableStringify);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortForStableStringify(record[key]);
      return acc;
    }, {});
  }
  return value;
}

/** SHA-256 of `input`, truncated to 20 hex characters — short enough for a readable key segment. */
export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 20);
}
