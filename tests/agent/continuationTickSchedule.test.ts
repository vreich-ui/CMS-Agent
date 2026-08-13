import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTINUATION_TICK_CRON } from "../../src/agent/workspace/runContinuation.js";

// The continuation tick's schedule is written TWICE on purpose and neither copy can be replaced by a
// reference to the other:
//
//   1. netlify/functions/run-continuation.mts `export const config` must hold a LITERAL. When it held
//      the imported CONTINUATION_TICK_CRON identifier, deploy 6a7df900 (2026-08-13T17:04:38Z) came
//      back with function_schedules: [] — the build could not resolve the identifier, the function
//      deployed, and nothing ever called it.
//   2. runContinuation.ts's CONTINUATION_TICK_CRON is what the tick's own logic and its unit tests
//      reason about.
//
// So this test is the seam that keeps them equal. It reads the deploy shell as TEXT rather than
// importing it, because importing a Netlify function module to assert on its config is exactly the
// coupling that made the literal necessary.
const FUNCTION_PATH = fileURLToPath(new URL("../../netlify/functions/run-continuation.mts", import.meta.url));

describe("continuation tick schedule", () => {
  const source = readFileSync(FUNCTION_PATH, "utf8");

  it("declares the schedule as a literal, not an imported identifier", () => {
    // A literal is the whole point: /schedule:\s*"…"/ must match, and the identifier form must not.
    expect(source).toMatch(/export const config = \{ schedule: "[^"]+" \}/);
    expect(source).not.toMatch(/export const config = \{ schedule: CONTINUATION_TICK_CRON \}/);
  });

  it("keeps that literal equal to CONTINUATION_TICK_CRON", () => {
    const match = source.match(/export const config = \{ schedule: "([^"]+)" \}/);
    expect(match?.[1]).toBe(CONTINUATION_TICK_CRON);
  });

  it("keeps netlify.toml's v1 fallback schedule equal too", () => {
    // Inert for a v2 function (proven by the empty function_schedules above) but kept as the safety
    // net if this function ever regresses to v1 — a stale value there would be a silent wrong cadence.
    const toml = readFileSync(fileURLToPath(new URL("../../netlify.toml", import.meta.url)), "utf8");
    const block = toml.match(/\[functions\."run-continuation"\]\s*\n\s*schedule = "([^"]+)"/);
    expect(block?.[1]).toBe(CONTINUATION_TICK_CRON);
  });

  it("imports nothing at module scope, so config extraction never executes the agent runtime", () => {
    const beforeHandler = source.slice(0, source.indexOf("export default"));
    expect(beforeHandler).not.toMatch(/^import\s/m);
  });
});
