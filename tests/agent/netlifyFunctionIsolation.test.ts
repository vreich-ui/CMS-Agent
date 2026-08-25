import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// THE ONE IMPORT THAT TAKES A SURFACE DOWN.
//
// From 2026-08-14 both `mcp` and `workspace-mcp` answered every request with HTTP 502,
//
//   Error [ERR_REQUIRE_ESM]: require() of ES Module /var/task/mcp.mts from /var/task/mcp.js
//
// while `agent` and `session` on the same site were fine. The single structural difference was that
// workspace-mcp.mts imported its SIBLING FUNCTION (`import { handler } from "./mcp.mjs"`). A
// cross-function import makes the bundler materialise the imported function as a second entry with a
// CommonJS interop wrapper, which then require()s the ESM source beside it — killing the importer
// and the imported alike.
//
// Runs were never affected — they are driven by the Cloud Run planes. What was affected is the
// Conductor Workbench, whose only data path is /api/workspace-mcp: the page loads and every read
// 502s.
//
// Nothing in the type system says that netlify/functions/ is the one directory where an ordinary
// relative import changes how the deployment is built, which is why this looked harmless for months.
// This test says it instead: shared code goes in src/, and a function is an entry point and nothing
// else.
const FUNCTIONS_DIR = path.resolve(fileURLToPath(new URL("../../netlify/functions", import.meta.url)));

describe("netlify functions are entry points, never each other's modules", () => {
  it("no function imports a sibling function", async () => {
    const files = (await readdir(FUNCTIONS_DIR)).filter((name) => /\.(mts|ts|mjs|js)$/.test(name));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(FUNCTIONS_DIR, file), "utf8");
      for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^\n;]*?from\s+["'](\.\/[^"']+)["']/g)) {
        offenders.push(`${file} -> ${match[1]}`);
      }
      for (const match of source.matchAll(/\bawait import\(\s*["'](\.\/[^"']+)["']\s*\)/g)) {
        offenders.push(`${file} -> ${match[1]} (dynamic)`);
      }
    }

    expect(offenders, `Netlify functions must not import one another; move the shared code into src/ instead. Offenders: ${offenders.join(", ")}`).toEqual([]);
  });
});
