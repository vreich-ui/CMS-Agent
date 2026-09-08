import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { driftOf, loadFixtures } from "../../scripts/contractCheck.js";
import { TRACKING_METRIC_KEYS } from "../../src/agent/improvement/trackingIngest.js";
import { OBJECT_ROLLUP_MEASURE_COLUMNS } from "../../src/agent/improvement/strategyReview.js";

// The fixtures are only worth having if the CONSUMERS are held to them. `npm run contract:check`
// holds the fixture against the producer; this holds the fixture against us.
const read = (relative: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8"));

const objectFixture = read("tests/contracts/kugel-data/rollups-by-object.json");
const producerFixture = read("tests/contracts/kugel-data/rollups-by-producer.json");
const strategyFixture = read("tests/contracts/kugel-data/rollups-by-strategy.json");

describe("kugel-data by=object", () => {
  it("serves every measure column strategyReview groups by", () => {
    for (const column of OBJECT_ROLLUP_MEASURE_COLUMNS) expect(objectFixture.measures).toContain(column);
  });

  it("serves every metric trackingIngest reads", () => {
    for (const key of TRACKING_METRIC_KEYS) expect(objectFixture.measures).toContain(key);
  });

  it("carries no topic and no funnel stage, which is why two strategy-review dimensions have never produced a line (S-04b)", () => {
    // Recorded, not lamented. The reader handles the absence; the fixture is what stops a future
    // test from inventing the labels again.
    expect(objectFixture.columns).not.toContain("topic");
    expect(objectFixture.columns).not.toContain("funnel_stage");
  });
});

describe("kugel-data by=producer", () => {
  it("sends the exact spellings producerField reads first, in snake_case and never nested", () => {
    expect(producerFixture.columns).toContain("node_id");
    expect(producerFixture.columns).toContain("run_id");
    expect(producerFixture.sample).not.toHaveProperty("producer");
    expect(producerFixture.sample).not.toHaveProperty("nodeId");
  });
});

describe("kugel-data by=strategy", () => {
  it("is still unimplemented at the producer, which is why strategyLearning has never seen a row", () => {
    // strategyLearning.ts reads row.strategy / row.intent with no fallback. There is no view behind
    // them: the sink answers 503 "grain not implemented" deliberately (S-04). When that changes,
    // contract:check fails on this fixture FIRST, which is the moment to agree the column names
    // rather than to discover them from an empty result.
    expect(strategyFixture.producerState).toBe("unimplemented");
    expect(strategyFixture.consumerReads).toEqual(["strategy", "intent"]);
  });
});

describe("the check itself", () => {
  it("finds every fixture and reports where a changed producer stopped matching", () => {
    const fixtures = loadFixtures();
    expect(fixtures.map((entry) => entry.file)).toEqual([
      "tests/contracts/kugel-data/rollups-by-object.json",
      "tests/contracts/kugel-data/rollups-by-producer.json",
      "tests/contracts/kugel-data/rollups-by-strategy.json",
    ]);
    // A producer file that still contains the excerpt verbatim, with surrounding code around it —
    // not the excerpt alone, which would make the "no drift" case true by construction.
    const source = `// unrelated header\n\n${objectFixture.excerpt.join("\n\nfunction unrelated() {}\n\n")}\n\nexport const somethingElse = 1;\n`;
    expect(driftOf(objectFixture, source)).toEqual([]);
    // A deliberately edited producer — the column renamed — is caught and named.
    expect(driftOf(objectFixture, source.replace("object_id: String(row.object_id", "objectId: String(row.objectId"))[0])
      .toMatch(/first line no longer present|reordered or split/);
    // A producer file missing the shape entirely is drift on every excerpt, not silence.
    expect(driftOf(objectFixture, "// the file was rewritten\n")).toHaveLength(objectFixture.excerpt.length);
  });
});
