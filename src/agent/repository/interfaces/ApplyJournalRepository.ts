import type { ApplyJournal, ApplyJournalRecord } from "../../operations/siteContentObjectApplier.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

// P2 v2 -- the durable backend for siteContentObjectApplier.ts's `ApplyJournal` port. This interface
// is deliberately IDENTICAL in shape to `ApplyJournal` itself (read/write, same params) plus `health`,
// which every repository in this codebase exposes; a concrete implementation of this interface is
// therefore usable anywhere an `ApplyJournal` is expected, with no adapter layer in between.
//
// WHY THIS NEEDS CAS, NOT AN UNCONDITIONAL OVERWRITE. Two concurrent apply attempts against the SAME
// materializationKey (a genuine retry racing a still-in-flight first attempt, or two callers who
// compiled the same plan) must not let one attempt's "pending" write clobber the other's "applied"
// write that landed a moment later -- that is exactly the CAS discipline BlobCapabilityGapRepository's
// own header describes for the same reason (two concurrent discoveries of the same gap). Unlike that
// module, this one's `write` is called by the applier as a strict read-modify-then-write sequence it
// already serializes itself (journal.read once, then journal.write before and after its one effect),
// so a caller of THIS interface never needs to retry a CAS conflict itself -- see the blob
// implementation's own header for how a genuine race (two applier calls for the same key, truly
// concurrent) is still handled honestly rather than silently lost.
export interface ApplyJournalRepository extends ApplyJournal {
  health(): Promise<RepositoryHealth>;
}
