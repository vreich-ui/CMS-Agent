import { cliMain } from "./conversationTurnGcJob.js";

try {
  process.exitCode = await cliMain(process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
