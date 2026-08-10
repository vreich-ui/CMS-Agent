#!/usr/bin/env tsx
/**
 * One-off purge of the "[ALIGN" coordination-board learning observations (2.8, handoff 2026-08-10).
 *
 * WHY THIS SCRIPT EXISTS
 *
 * 27 of the 34 learning observations recorded to date are an inter-agent coordination board — records
 * whose text starts with "[ALIGN" — that both parties agreed must be excluded from editorial curation
 * ("These are coordination messages, NOT editorial learnings — playbook curation should skip the
 * [ALIGN prefix"), under a binding sunset directive that was never actually executed. There was no
 * delete/archive path for the observation store until 2.8 added one (LearningObservation gained an
 * optional status field; the repository gained archiveObservation / archiveObservationsByPredicate;
 * listObservations defaults to excluding archived records). This script applies that directive.
 *
 * Nothing is ever hard-deleted: archiving sets status:"archived" plus archivedAt/archivedReason on the
 * matching records, in place. A purge run is fully reversible by hand (there is no un-archive tool by
 * design — this is a one-off script, not a recurring lifecycle op — but the records themselves are
 * untouched otherwise and remain readable with includeArchived:true).
 *
 * SAFETY. This script is DRY-RUN BY DEFAULT: it always reports what it would archive; only --write
 * actually calls archiveObservationsByPredicate against the configured repository. Nothing is written
 * without an explicit flag.
 *
 * Usage:
 *   npx tsx scripts/purgeAlignObservations.ts             # dry run (default): report matches, write nothing
 *   npx tsx scripts/purgeAlignObservations.ts --write      # archive the matches
 *   npx tsx scripts/purgeAlignObservations.ts --prefix "[SOMETHING" --write   # archive a different marker
 */
import { repositoryManager } from "../src/agent/runtime/repositories.js";

const DEFAULT_PREFIX = "[ALIGN";
const DEFAULT_REASON = "2.8 purge: sunset coordination-board directive — these are inter-agent coordination messages, not editorial learnings, and were never meant to reach playbook curation.";

const say = (message: string) => process.stdout.write(`${message}\n`);

const main = async () => {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const prefixIndex = args.indexOf("--prefix");
  const prefix = prefixIndex === -1 ? DEFAULT_PREFIX : args[prefixIndex + 1];
  if (!prefix) throw new Error("--prefix requires a value");

  const learningRepository = repositoryManager.getLearningRepository();
  const observations = await learningRepository.listObservations();
  const matches = observations.filter((observation) => observation.observation.startsWith(prefix));

  say(`prefix            ${JSON.stringify(prefix)}`);
  say(`active observations scanned  ${observations.length}`);
  say(`matched           ${matches.length}`);
  for (const observation of matches) say(`                  ${observation.id}  ${observation.observation.slice(0, 80).replace(/\n/g, " ")}${observation.observation.length > 80 ? "…" : ""}`);

  if (!write) {
    say("");
    say(matches.length ? "DRY RUN — nothing was written. Re-run with --write to archive the matches above." : "DRY RUN — nothing matched, nothing to archive.");
    return;
  }

  if (!matches.length) {
    say("nothing to archive — no active observation matched the prefix.");
    return;
  }

  const result = await learningRepository.archiveObservationsByPredicate((observation) => observation.observation.startsWith(prefix), DEFAULT_REASON);
  say("");
  say(`archived          ${result.archived}`);
  for (const id of result.ids) say(`                  ${id}`);
};

await main();
