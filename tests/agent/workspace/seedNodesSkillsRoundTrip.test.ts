// T3 regression net for renderSkills (scripts/seedNodesFromWorkspace.ts).
//
// THE BUG. seededSkills.ts references standardsPackSkillDefinition BY IDENTIFIER (its header says why:
// STANDARDS_PACK_VERSION must stay the single source of truth for both the seeded definition and
// templateProvenance.ts's pin). renderSkills emitted pure JSON with a fixed header and no import, so
// byte-equality with the checked-in file was unreachable: `npm run nodes:check:offline` exited 1 on a
// clean checkout with `seededSkills.ts DRIFTED`, and `nodes:update` would have deleted the import.
//
// That is worse than an untidy file. The offline gate is the only credential-free check for this seam,
// and a gate that cannot be green never gets added to CI — which is how canonical and the live store
// were free to diverge with nothing watching. These tests hold the round-trip open.
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { __test__ } from "../../../scripts/seedNodesFromWorkspace.js";
import { seededSkillDefinitions } from "../../../src/agent/skills/seededSkills.js";
import { standardsPackSkillDefinition } from "../../../src/agent/skills/standardsPack.js";
import type { SkillDefinition } from "../../../src/agent/skills/skillTypes.js";

const SKILLS_PATH = fileURLToPath(new URL("../../../src/agent/skills/seededSkills.ts", import.meta.url));

describe("renderSkills", () => {
  it("round-trips the checked-in seededSkills.ts byte-for-byte", async () => {
    // The offline drift gate, asserted directly: a hand-edit the generator would not reproduce fails
    // here as well as in `npm run nodes:check:offline`.
    expect(__test__.renderSkills(seededSkillDefinitions)).toBe(await readFile(SKILLS_PATH, "utf8"));
  });

  it("emits the standards-pack import and the bare identifier, never a copy of its JSON", () => {
    const rendered = __test__.renderSkills(seededSkillDefinitions);

    expect(rendered).toContain('import { standardsPackSkillDefinition } from "./standardsPack.js";');
    expect(rendered).toContain("\n  standardsPackSkillDefinition");
    expect(rendered).not.toContain(`"skillId": "${standardsPackSkillDefinition.skillId}"`);
  });

  it("substitutes the identifier for a live store definition that deep-equals the constant, key order aside", () => {
    // What a re-seed from a live workspace that HAS run skill_create for the pack actually hands the
    // generator: the same values as JSON, with no guarantee about key order.
    const shuffled = Object.fromEntries(
      Object.keys(standardsPackSkillDefinition).reverse().map((key) => [key, (standardsPackSkillDefinition as unknown as Record<string, unknown>)[key]])
    ) as unknown as SkillDefinition;

    const rendered = __test__.renderSkills([shuffled]);

    expect(rendered).toContain("\n  standardsPackSkillDefinition\n");
    expect(rendered).not.toContain(`"skillId": "${standardsPackSkillDefinition.skillId}"`);
  });

  it("inlines a standards-pack definition that has genuinely diverged from the code constant", () => {
    // The signal that standardsPack.ts needs a deliberate version bump. Substituting the identifier
    // here would silently discard the live text and claim the pinned version shipped it.
    const diverged = { ...standardsPackSkillDefinition, version: "2099.01.01-1" } as SkillDefinition;

    const rendered = __test__.renderSkills([diverged]);

    expect(rendered).toContain(`"skillId": "${standardsPackSkillDefinition.skillId}"`);
    expect(rendered).toContain('"version": "2099.01.01-1"');
  });

  it("orders every skill by skillId, identifier included", () => {
    const rendered = __test__.renderSkills(seededSkillDefinitions);
    const emitted = [...rendered.matchAll(/^  (?:"skillId": "([a-z_]+)"|(standardsPackSkillDefinition))/gm)]
      .map((match) => match[1] ?? standardsPackSkillDefinition.skillId);

    expect(emitted).toEqual([...emitted].sort());
    expect(emitted).toContain(standardsPackSkillDefinition.skillId);
  });
});
