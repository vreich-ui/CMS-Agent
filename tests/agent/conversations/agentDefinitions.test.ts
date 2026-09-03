import { describe, expect, it } from "vitest";
import { CLIENT_MANAGER_PROMPT, SUPERSEDED_CLIENT_MANAGER_PROMPTS, classifyConversationalAgentPrompt, createCanonicalClientManagerAgent } from "../../../src/agent/conversations/agentDefinitions.js";
import { WorkspaceStateStore, createDefaultWorkspaceDocument } from "../../../src/agent/mcp/workspace/store.js";
import { MemoryChangeRepository } from "../../../src/agent/repository/memory/MemoryChangeRepository.js";

describe("canonical client_manager workspace definition", () => {
  it("seeds a missing canonical definition once and records the seed in the workspace ledger", async () => {
    const store = new WorkspaceStateStore({ ...createDefaultWorkspaceDocument(), conversationalAgents: [] });
    const changes = new MemoryChangeRepository();
    store.attachChangeSink(changes);

    const first = await store.ensureConversationalAgentSeeds({ actor: { kind: "system" }, source: "system", reason: "test seed" });
    const versionAfterFirstSeed = await store.getWorkspaceVersion();
    const second = await store.ensureConversationalAgentSeeds();

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(versionAfterFirstSeed).toBe(1);
    expect(await store.getWorkspaceVersion()).toBe(versionAfterFirstSeed);
    const events = (await changes.listEvents()).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "agent.seeded", target: { type: "agent", id: first[0].id } });
    const revision = await changes.getRevision(events[0].resultingRevisionId!);
    expect(revision?.conversationalAgents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first[0].id, rev: createCanonicalClientManagerAgent().rev, prompt: CLIENT_MANAGER_PROMPT })
    ]));
  });

  it("increments an agent revision and captures the prompt change in the existing workspace ledger", async () => {
    const store = new WorkspaceStateStore();
    const changes = new MemoryChangeRepository();
    store.attachChangeSink(changes);
    const agent = (await store.listConversationalAgents())[0];

    const updated = await store.updateConversationalAgent(agent.id, { prompt: "Updated shared method." }, { actor: { kind: "human", id: "editor-7" }, source: "mcp", reason: "Improve candidate instruction" });

    expect(updated.agent.rev).toBe(agent.rev + 1);
    const event = (await changes.listEvents()).events[0];
    expect(event).toMatchObject({ type: "agent.updated", target: { type: "agent", id: agent.id }, actor: { kind: "human", id: "editor-7" }, before: { prompt: CLIENT_MANAGER_PROMPT }, after: { prompt: "Updated shared method." } });
  });

  it("keeps the canonical prompt project-neutral while owning learning-mode candidates", () => {
    expect(CLIENT_MANAGER_PROMPT).toMatch(/context\.learning_mode is true/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/2-3 genuinely distinct versions/i);
    expect(CLIENT_MANAGER_PROMPT).not.toMatch(/dr-lurie|fernwell|platform/i);
  });

  // CA6 prompt parity. Each assertion stands for a governance rule the calling platform used to
  // send per-turn and no longer does. A deletion here is a live defect, not a copy change.
  it("carries every house rule the platform stopped sending with its own system prompt", () => {
    // Editor-facing language: the identifiers and internals that must never reach editor text.
    for (const forbidden of ["identifiers", "schema", "provider names", "model names", "credentials", "hidden prompts"]) {
      expect(CLIENT_MANAGER_PROMPT.toLowerCase()).toContain(forbidden);
    }
    // The Owner-only diagnostics escape hatch, and its non-negotiable floor.
    expect(CLIENT_MANAGER_PROMPT).toMatch(/context\.diagnostics_requested is true/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never reveal credentials/i);
    // Lifecycle vocabulary, including the claim that publishing alone never proves Live.
    for (const term of ["Draft means", "Approved means", "Published means", "Live means"]) {
      expect(CLIENT_MANAGER_PROMPT).toContain(term);
    }
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never proves Live/i);
    // Refusal handling and the focus-is-not-authorization framing.
    expect(CLIENT_MANAGER_PROMPT).toMatch(/do not re-submit the same call/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never authorization/i);
  });

  // S1 (chat-path): rev 3 adds the production start/report rules — the brief travels verbatim, the
  // aggression inputs and media request are carried, the request id is caller-supplied, and a
  // blocked/failed run is reported reusable-first.
  it("rev 3 carries the 'Starting and reporting production' rules and rev 2 is superseded", () => {
    expect(createCanonicalClientManagerAgent().rev).toBe(5);
    expect(CLIENT_MANAGER_PROMPT).toContain("## Starting and reporting production");
    expect(CLIENT_MANAGER_PROMPT).toContain("pass the editor's brief verbatim as `input.instructions` — never summarise or shorten it");
    expect(CLIENT_MANAGER_PROMPT).toContain("Set `trafficSource` and `awarenessStage` (ask if unknown)");
    expect(CLIENT_MANAGER_PROMPT).toContain("`input.mediaRequest`");
    expect(CLIENT_MANAGER_PROMPT).toContain("Supply `requestId` in the client's request-id form when the tool requires one.");
    expect(CLIENT_MANAGER_PROMPT).toContain("first name what was produced and is reusable (for example a completed draft), then what failed.");
    // Every earlier canonical text (rev 1 and rev 2) is superseded and upgradeable.
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS).toHaveLength(4);
    for (const superseded of SUPERSEDED_CLIENT_MANAGER_PROMPTS) expect(classifyConversationalAgentPrompt(superseded)).toBe("superseded");
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS[1]).toContain("## Candidates in learning mode");
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS[1]).not.toContain("## Starting and reporting production");
  });

  // ART — the two blocks CA6 never triaged. CA6 audited the platform prompt for DISCLOSURE risk,
  // so its operational instructions were dropped silently: the agent reached a governed create with
  // nothing telling it to read the contract first, and nothing telling it which path an article
  // takes. That is what produced the content_item node-schema failure, and behind that failure the
  // raw verb path could create AND publish an article carrying none of the judge/score substrate.
  // These assertions are the regression wall for both. A deletion here is a live defect.
  it("rev 4 carries read-before-you-write and the single article production path", () => {
    expect(createCanonicalClientManagerAgent().rev).toBe(5);

    // Contract-first: the block platform's systemPrompt() used to send and CA6 left behind.
    expect(CLIENT_MANAGER_PROMPT).toContain("## Read before you write");
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never guess the shape of a governed object/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/object_contract/);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/dry-run a candidate body or patch before proposing the write/i);
    // The object-binding half of the same dropped block.
    expect(CLIENT_MANAGER_PROMPT).toMatch(/work on THAT object unless the editor explicitly asks about another/i);

    // Routing: an article has exactly one production path, and a refused direct create is the
    // system working — never an obstacle to route around.
    expect(CLIENT_MANAGER_PROMPT).toContain("## One production path for articles");
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never hand-assembled from object writes/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/already exists/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/do not treat a refusal of a direct create as an error to work around/i);

    // Still project-neutral, and rev 3 is now superseded rather than deleted.
    expect(CLIENT_MANAGER_PROMPT).not.toMatch(/dr-lurie|fernwell|platform/i);
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS[2]).toContain("## Starting and reporting production");
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS[2]).not.toContain("## Read before you write");
    expect(classifyConversationalAgentPrompt(SUPERSEDED_CLIENT_MANAGER_PROMPTS[2])).toBe("superseded");
  });

  // C3 (BRIEF §3.8) — rev 5. An editor asking for a campaign or a series to LOOK different used to
  // get the look described in the brief, which the site's imagery contract silently overrides
  // server-side; `style` (a named visual_standard template, pointed at by the run's imageStyle) is
  // the only channel that reaches the image model's brand resolution at all. The prompt now routes
  // that request through the visual identity workflow's template mode instead of through prose.
  it("rev 5 routes a one-off look through a named standard, never through words in the brief", () => {
    expect(createCanonicalClientManagerAgent().rev).toBe(5);

    expect(CLIENT_MANAGER_PROMPT).toContain("## A one-off look for a set of articles");
    // The look is written down once and pointed at — never described into the brief or the prompt.
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never write style words into an image prompt/i);
    expect(CLIENT_MANAGER_PROMPT).toContain("visual identity workflow in template mode");
    expect(CLIENT_MANAGER_PROMPT).toContain("`input.imageStyle.visualStandardId`");
    expect(CLIENT_MANAGER_PROMPT).toMatch(/reuse an existing named look/i);
    // R5: a locked site ignores the pointer and REPORTS it. Never an error to route around.
    expect(CLIENT_MANAGER_PROMPT).toMatch(/locked imagery overrides/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/not an error to work around/i);
    // Editor-facing language still holds: a standard is named in words, never by its id.
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never by its id/i);
    // Still project-neutral, and rev 4 is superseded rather than deleted.
    expect(CLIENT_MANAGER_PROMPT).not.toMatch(/dr-lurie|fernwell|platform/i);
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS[3]).toContain("## One production path for articles");
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS[3]).not.toContain("## A one-off look for a set of articles");
    expect(classifyConversationalAgentPrompt(SUPERSEDED_CLIENT_MANAGER_PROMPTS[3])).toBe("superseded");
  });

  it("classifies stored prompts against the shipped canonical text", () => {
    expect(classifyConversationalAgentPrompt(CLIENT_MANAGER_PROMPT)).toBe("canonical");
    expect(classifyConversationalAgentPrompt(SUPERSEDED_CLIENT_MANAGER_PROMPTS[0])).toBe("superseded");
    expect(classifyConversationalAgentPrompt("An operator wrote this.")).toBe("diverged");
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS).not.toContain(CLIENT_MANAGER_PROMPT);
  });

  // A workspace seeded before CA6 holds the superseded text. Seeding is additive, so without this
  // upgrade it would keep the pre-parity prompt forever — while an operator's own edit must survive.
  it("upgrades a superseded canonical prompt on seed but never overwrites an operator edit", async () => {
    const canonical = createCanonicalClientManagerAgent();
    const stale = { ...canonical, prompt: SUPERSEDED_CLIENT_MANAGER_PROMPTS[0], rev: 1 };
    const store = new WorkspaceStateStore({ ...createDefaultWorkspaceDocument(), conversationalAgents: [stale] });

    const upgraded = (await store.ensureConversationalAgentSeeds())[0];
    expect(upgraded.prompt).toBe(CLIENT_MANAGER_PROMPT);
    expect(upgraded.rev).toBe(2);

    // Idempotent: a second pass is a no-op and does not bump the workspace again.
    const versionAfterUpgrade = await store.getWorkspaceVersion();
    await store.ensureConversationalAgentSeeds();
    expect(await store.getWorkspaceVersion()).toBe(versionAfterUpgrade);

    const edited = { ...canonical, prompt: "House rules, rewritten by the operator.", rev: 9 };
    const editedStore = new WorkspaceStateStore({ ...createDefaultWorkspaceDocument(), conversationalAgents: [edited] });
    const afterSeed = (await editedStore.ensureConversationalAgentSeeds())[0];
    expect(afterSeed.prompt).toBe("House rules, rewritten by the operator.");
    expect(afterSeed.rev).toBe(9);
  });
});
