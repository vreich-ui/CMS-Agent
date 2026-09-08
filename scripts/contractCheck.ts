/**
 * `npm run contract:check` — hold the vendored producer fixtures against the producers (W4 / T-14).
 *
 * THE PROBLEM IT ADDRESSES. A shape that crosses a repository boundary is a contract nobody wrote
 * down. docs/CONTRACTS.md is the writing-down; this is the part that stays true. Every reader in
 * `src/agent/improvement/` is deliberately built never to throw on a malformed producer row, which
 * is right for a nightly job and is exactly what makes drift invisible: the grain returns nothing
 * and "nothing" is indistinguishable from a quiet week.
 *
 * WHAT IT COMPARES. Each fixture under `tests/contracts/<producer>/<shape>.json` carries `excerpt`:
 * the producer's own shaping code, verbatim, as it stood at `sha`. This fetches the producer file
 * from GitHub at `main` and asserts each excerpt still appears in it. A reformat trips this. That is
 * intended — the alarm is cheap, and re-capturing a fixture is one command, while a silently
 * renamed column costs a season of learning nobody notices is missing.
 *
 * EXIT CODES, and why there are three. 0 verified, 1 drift, **2 unverified**. Unverified is not
 * green: without GITHUB_TOKEN nothing was compared, and a check that passes when it did no work is
 * how the executor-jobs list stayed stale through every green build (C-10).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

type Fixture = {
  producer: string;
  path: string;
  sha: string;
  capturedAt: string;
  shape?: string;
  excerpt: string[];
};

const repoFile = (relative: string) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

export const loadFixtures = (root = repoFile("tests/contracts")): Array<{ file: string; fixture: Fixture }> => {
  const found: Array<{ file: string; fixture: Fixture }> = [];
  for (const producer of readdirSync(root)) {
    const directory = `${root}/${producer}`;
    if (!statSync(directory).isDirectory()) continue;
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
      found.push({ file: `tests/contracts/${producer}/${name}`, fixture: JSON.parse(readFileSync(`${directory}/${name}`, "utf8")) as Fixture });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
};

/** Which excerpts are missing from the producer's current file, and where each one starts to differ. */
export const driftOf = (fixture: Fixture, producerSource: string): string[] => {
  const problems: string[] = [];
  for (const excerpt of fixture.excerpt) {
    if (producerSource.includes(excerpt)) continue;
    const lines = excerpt.split("\n");
    const firstMissing = lines.find((line) => line.trim().length > 0 && !producerSource.includes(line));
    problems.push(firstMissing
      ? `first line no longer present: ${firstMissing.trim()}`
      : `every line is still present but not contiguously — the block was reordered or split`);
  }
  return problems;
};

type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const fetchProducerFile = async (fetcher: Fetcher, token: string, producer: string, path: string): Promise<string> => {
  const url = `https://api.github.com/repos/${producer}/contents/${path}?ref=main`;
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "cms-agent-contract-check" } });
  if (!response.ok) throw new Error(`GitHub GET /repos/${producer}/contents/${path} failed: HTTP ${response.status}`);
  const body = (await response.json()) as { content?: string; encoding?: string };
  if (typeof body.content !== "string") throw new Error(`GitHub returned no content for ${producer}/${path}`);
  return Buffer.from(body.content, (body.encoding as BufferEncoding) ?? "base64").toString("utf8");
};

const main = async (): Promise<void> => {
  const fixtures = loadFixtures();
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log(`UNVERIFIED — ${fixtures.length} fixture(s) were NOT compared against their producers.`);
    console.log("GITHUB_TOKEN is not set. Nothing was checked; this is not a pass. Exit 2.");
    for (const { file, fixture } of fixtures) console.log(`  · ${file} → ${fixture.producer}/${fixture.path} @ ${fixture.sha.slice(0, 7)}`);
    process.exit(2);
  }

  let drifted = 0;
  for (const { file, fixture } of fixtures) {
    let source: string;
    try {
      source = await fetchProducerFile(fetch as unknown as Fetcher, token, fixture.producer, fixture.path);
    } catch (error) {
      console.log(`UNVERIFIED ${file}: ${error instanceof Error ? error.message : String(error)}`);
      drifted += 1;
      continue;
    }
    const problems = driftOf(fixture, source);
    if (!problems.length) {
      console.log(`✓ ${file} — ${fixture.producer}/${fixture.path} still matches (captured at ${fixture.sha.slice(0, 7)})`);
      continue;
    }
    drifted += 1;
    console.log(`✗ ${file} — ${fixture.producer}/${fixture.path} has DRIFTED from the fixture captured at ${fixture.sha.slice(0, 7)}:`);
    for (const problem of problems) console.log(`    ${problem}`);
    console.log(`    ${fixture.shape ?? ""}`);
    console.log("    Re-read the producer, agree the shape, then re-capture the fixture and its sha. Do not just update the fixture.");
  }

  console.log("");
  console.log(drifted ? `✗ ${drifted} of ${fixtures.length} contract(s) drifted.` : `✓ All ${fixtures.length} contract(s) match their producers.`);
  process.exit(drifted ? 1 : 0);
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
