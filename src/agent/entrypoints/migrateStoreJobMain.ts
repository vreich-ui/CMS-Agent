// Process wrapper for the store migration job (see migrateStoreJob.ts) — kept separate so
// importing the logic module never executes anything. Usage: --dry-run | (default migrate) |
// --verify, plus --prefix and --concurrency; see docs/platform/PHASE2_RUNBOOK.md.
import { cliMain } from "./migrateStoreJob.js";

try {
  process.exitCode = await cliMain(process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
