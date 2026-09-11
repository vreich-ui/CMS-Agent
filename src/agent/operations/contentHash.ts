// Shared deterministic content hashing for the A4 kernel (siteContext.ts's snapshot digest,
// changeSet.ts's changeSetId). Reuses improvementTypes.ts's stableHash (FNV-1a over JSON) rather
// than inventing a second hash — see that file's own comment: enough to detect drift, deliberately
// not cryptographic. What THIS module adds on top is canonicalization: stableHash's own
// JSON.stringify is sensitive to a plain object's key insertion order, which is not a property two
// independently-assembled values (e.g. a snapshot captured twice, or a change set recomputed from
// the same inputs) are guaranteed to share. canonicalize() sorts object keys recursively so
// structurally-identical values always hash identically regardless of how they were built.
//
// Array order is left untouched deliberately: an array is a LIST, and reordering it silently would
// hide a genuine content change (e.g. two different orderings of the same diffs). A caller whose
// array order is not itself meaningful (e.g. a source that may return listObjects() results in an
// unstable order) is responsible for sorting that array before it reaches here — this module cannot
// tell "order carries no meaning" from "order IS the content" for an arbitrary array.
import { stableHash } from "../improvement/improvementTypes.js";

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(record[key]);
        return acc;
      }, {});
  }
  return value;
}

// A stable content hash over `value`'s normalized (key-sorted) form. Pure: no clock, no randomness,
// no I/O — the same value always hashes the same, in this process and any other.
export const contentDigest = (value: unknown): string => stableHash(canonicalize(value));
