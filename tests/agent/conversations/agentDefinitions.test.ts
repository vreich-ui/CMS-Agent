import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLIENT_MANAGER_PROMPT, SUPERSEDED_CLIENT_MANAGER_PROMPTS, classifyConversationalAgentPrompt, createCanonicalClientManagerAgent, pendingCanonicalPromptUpgrades } from "../../../src/agent/conversations/agentDefinitions.js";
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
    expect(createCanonicalClientManagerAgent().rev).toBe(8);
    expect(CLIENT_MANAGER_PROMPT).toContain("## Starting and reporting production");
    expect(CLIENT_MANAGER_PROMPT).toContain("pass the editor's brief verbatim as `input.instructions` — never summarise or shorten it");
    expect(CLIENT_MANAGER_PROMPT).toContain("Set `trafficSource` and `awarenessStage` (ask if unknown)");
    expect(CLIENT_MANAGER_PROMPT).toContain("`input.mediaRequest`");
    expect(CLIENT_MANAGER_PROMPT).toContain("Supply `requestId` in the client's request-id form when the tool requires one.");
    expect(CLIENT_MANAGER_PROMPT).toContain("first name what was produced and is reusable (for example a completed draft), then what failed.");
    // Every earlier canonical text (rev 1 through rev 7) is superseded and upgradeable.
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS).toHaveLength(7);
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
    expect(createCanonicalClientManagerAgent().rev).toBe(8);

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
  // W5 (2026-09-13): rev 7's live-store landing replaced rev 6 wholesale rather than layering on
  // top of it, so this feature no longer lives in CLIENT_MANAGER_PROMPT — it lives in the rev-6
  // historical text, index 5 of SUPERSEDED_CLIENT_MANAGER_PROMPTS. Asserted there instead, as a
  // regression wall on the HISTORY (any tenant still on that exact text upgrades cleanly), not on
  // what ships today. Whether this feature returns to the live prompt is a separate editorial call.
  it("rev 5 routed a one-off look through a named standard, never through words in the brief (historical, superseded by rev 7)", () => {
    expect(createCanonicalClientManagerAgent().rev).toBe(8);
    const rev6Text = SUPERSEDED_CLIENT_MANAGER_PROMPTS[5];

    expect(rev6Text).toContain("## A one-off look for a set of articles");
    // The look is written down once and pointed at — never described into the brief or the prompt.
    expect(rev6Text).toMatch(/never write style words into an image prompt/i);
    expect(rev6Text).toContain("visual identity workflow in template mode");
    expect(rev6Text).toContain("`input.imageStyle.visualStandardId`");
    expect(rev6Text).toMatch(/reuse an existing named look/i);
    // R5: a locked site ignores the pointer and REPORTS it. Never an error to route around.
    expect(rev6Text).toMatch(/locked imagery overrides/i);
    expect(rev6Text).toMatch(/not an error to work around/i);
    // Editor-facing language still holds: a standard is named in words, never by its id.
    expect(rev6Text).toMatch(/never by its id/i);
    // Still project-neutral, and rev 4 is superseded rather than deleted.
    expect(rev6Text).not.toMatch(/dr-lurie|fernwell|platform/i);
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS[3]).toContain("## One production path for articles");
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS[3]).not.toContain("## A one-off look for a set of articles");
    expect(classifyConversationalAgentPrompt(SUPERSEDED_CLIENT_MANAGER_PROMPTS[3])).toBe("superseded");
    expect(classifyConversationalAgentPrompt(rev6Text)).toBe("superseded");
    // The current, live canonical text no longer carries this section (see the rev 7 test below).
    expect(CLIENT_MANAGER_PROMPT).not.toContain("## A one-off look for a set of articles");
  });

  // FIX (chat-recovery) — rev 6. A fresh chat on a site whose house imagery standard had never been
  // written listed the site's visual standards (correctly empty), then assembled an id from the
  // `vis_` prefix and the SITE OBJECT's id and looked it up. The convention puts the site's SHORT
  // NAME in that segment, never another object's id, so the constructed id could not exist — and the
  // editor saw a red not-found card describing a site that was simply new. Nothing in the prompt had
  // named the convention, and nothing had said that an empty list is itself the answer.
  // W5 (2026-09-13): same situation as rev 5 above — this section lives only in the rev-6
  // historical text now (index 5), not in the live CLIENT_MANAGER_PROMPT.
  it("rev 6 forbade assembling an object id and made an empty list an answer, not a dead end (historical, superseded by rev 7)", () => {
    expect(createCanonicalClientManagerAgent().rev).toBe(8);
    const rev6Text = SUPERSEDED_CLIENT_MANAGER_PROMPTS[5];

    expect(rev6Text).toContain("## Object ids you were not given");
    expect(rev6Text).toMatch(/never assemble an object id/i);
    expect(rev6Text).toMatch(/never the id of another object/i);
    expect(rev6Text).toMatch(/an empty list is an answer/i);
    expect(rev6Text).toMatch(/never follow an empty list with a lookup of a name you constructed/i);
    // The house-standard case by name: report it, offer to write one, claim nothing in the meantime.
    expect(rev6Text).toMatch(/the house look has never been written/i);
    expect(rev6Text).toContain("visual identity workflow in house mode");
    // The same rule reaches editorial voice and tracking configuration, which share the convention.
    expect(rev6Text).toMatch(/editorial voice, its tracking configuration/i);

    // Still project-neutral, and rev 5 is superseded rather than deleted.
    expect(rev6Text).not.toMatch(/dr-lurie|fernwell|platform/i);
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS[4]).toContain("## A one-off look for a set of articles");
    expect(SUPERSEDED_CLIENT_MANAGER_PROMPTS[4]).not.toContain("## Object ids you were not given");
    expect(classifyConversationalAgentPrompt(SUPERSEDED_CLIENT_MANAGER_PROMPTS[4])).toBe("superseded");
    expect(classifyConversationalAgentPrompt(rev6Text)).toBe("superseded");
    // rev 8 restored this section to the live canonical text (see the rev 8 test below). rev 6
    // remains a distinct historical entry because it also carried "A one-off look for a set of
    // articles", which rev 8 does NOT bring back.
    expect(CLIENT_MANAGER_PROMPT).toContain("## Object ids you were not given");
    expect(rev6Text).toContain("## A one-off look for a set of articles");
    expect(CLIENT_MANAGER_PROMPT).not.toContain("## A one-off look for a set of articles");
  });

  // W5 (2026-09-13, publication-identity incident) — rev 7 lands the operator's live-store edit of
  // `agt_client_manager` as canonical, byte for byte. The sha256 below was computed, once, from the
  // exact JSON text returned by the single read-only `agent_get` call this task's report cites — it
  // is a checked-in fingerprint of that one fetch, not a live re-verification (this test makes no
  // network or MCP call). If this test ever fails, CLIENT_MANAGER_PROMPT drifted from what was
  // landed; it does not mean the LIVE store has since changed (an operator can always edit it again).
  it("rev 7's live-store fingerprint survives as the superseded entry rev 8 was built from", () => {
    expect(createCanonicalClientManagerAgent().rev).toBe(8);
    // rev 7 is SUPERSEDED_CLIENT_MANAGER_PROMPTS[6] now. The sha256 records one historical read-only
    // fetch and never changes; asserting it here keeps rev 8 honest about what it was derived from.
    const rev7Text = SUPERSEDED_CLIENT_MANAGER_PROMPTS[6];
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(sha256(rev7Text)).toBe("fa143f797dbc827e5519cbdccb011212cea4123ebb1897eefb2bc7873a73ef77");
    expect(rev7Text.length).toBe(9230);

    // New sections the operator's edit introduced.
    expect(CLIENT_MANAGER_PROMPT).toContain("## Say who you are once");
    expect(CLIENT_MANAGER_PROMPT).toMatch(/take the publication's name from the supplied project context/i);
    expect(CLIENT_MANAGER_PROMPT).toContain("## How to answer");
    expect(CLIENT_MANAGER_PROMPT).toContain("## Show what you are doing, not what you will do");
    expect(CLIENT_MANAGER_PROMPT).toContain("## Operations come before plans");
    expect(CLIENT_MANAGER_PROMPT).toMatch(/operation catalog/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/saving is not applying, and applying is not releasing/i);

    // Sections the operator's edit dropped relative to rev 6 (a deliberate wholesale replacement,
    // not a smaller change layered on top — see the header comment above CLIENT_MANAGER_PROMPT).
    // Both were dropped by rev 7; rev 8 brought exactly one of them back.
    expect(rev7Text).not.toContain("## A one-off look for a set of articles");
    expect(rev7Text).not.toContain("## Object ids you were not given");
    expect(CLIENT_MANAGER_PROMPT).not.toContain("## A one-off look for a set of articles");

    // Still project-neutral.
    expect(CLIENT_MANAGER_PROMPT).not.toMatch(/dr-lurie|fernwell|platform|zilberman/i);

    // classifyConversationalAgentPrompt / pendingCanonicalPromptUpgrades still behave: the live
    // store's prompt (now == CLIENT_MANAGER_PROMPT) classifies canonical, and every prior canonical
    // text — including rev 6, now superseded rather than current — is upgradeable.
    expect(classifyConversationalAgentPrompt(CLIENT_MANAGER_PROMPT)).toBe("canonical");
    for (const superseded of SUPERSEDED_CLIENT_MANAGER_PROMPTS) {
      expect(classifyConversationalAgentPrompt(superseded)).toBe("superseded");
      expect(pendingCanonicalPromptUpgrades([{ ...createCanonicalClientManagerAgent(), prompt: superseded }])).toEqual([
        { id: "agt_client_manager", prompt: CLIENT_MANAGER_PROMPT }
      ]);
    }
    // An operator's own further edit — anything not matching a known canonical/superseded text —
    // is never touched by the upgrade path.
    expect(pendingCanonicalPromptUpgrades([{ ...createCanonicalClientManagerAgent(), prompt: "An operator wrote this." }])).toEqual([]);
  });

  // A10 close-out — rev 8 restores the "Object ids you were not given" guardrail that rev 7 dropped.
  // rev 7's job was to make code match the live store byte for byte after an operator edited it in
  // place, and its header named the restoration as "a separate, later editorial decision". This is
  // that decision. The guardrail exists because of a real incident: a fresh chat on a site with no
  // house imagery standard listed its visual standards (correctly empty), then built a `vis_` id out
  // of the SITE OBJECT's id and looked it up, showing the editor a not-found card for a site that
  // was simply new. Nothing else about rev 7 changes, so a tenant still holding rev 7's exact text
  // is upgraded rather than left diverged.
  it("rev 8 restores the object-id guardrail on top of rev 7, changing nothing else", () => {
    expect(createCanonicalClientManagerAgent().rev).toBe(8);
    const rev7Text = SUPERSEDED_CLIENT_MANAGER_PROMPTS[6];

    // The restoration is purely additive against rev 7: delete the new section and rev 7 returns,
    // byte for byte. This is the assertion that makes "changing nothing else" checkable rather than
    // asserted, and it will fail if anyone edits the live text without updating the history.
    const guardrailStart = CLIENT_MANAGER_PROMPT.indexOf("## Object ids you were not given");
    const guardrailEnd = CLIENT_MANAGER_PROMPT.indexOf("## Starting and reporting production");
    expect(guardrailStart).toBeGreaterThan(-1);
    expect(guardrailEnd).toBeGreaterThan(guardrailStart);
    const withoutGuardrail =
      CLIENT_MANAGER_PROMPT.slice(0, guardrailStart) + CLIENT_MANAGER_PROMPT.slice(guardrailEnd);
    expect(withoutGuardrail).toBe(rev7Text);

    // The guardrail's own substance, so a future edit cannot hollow it out and keep the heading.
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never assemble an object id/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never the id of another object/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/an empty list is an answer/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never follow an empty list with a lookup of a name you constructed/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/the house look has never been written/i);
    expect(CLIENT_MANAGER_PROMPT).toContain("visual identity workflow in house mode");
    expect(CLIENT_MANAGER_PROMPT).toMatch(/editorial voice, its tracking configuration/i);

    // Placed where rev 6 carried it: after the editor-facing rules, before production reporting.
    expect(guardrailStart).toBeGreaterThan(CLIENT_MANAGER_PROMPT.indexOf("## One production path for articles"));

    // Still project-neutral, and rev 7 is superseded rather than deleted — so the five live tenants,
    // which hold rev 7's text today, are upgraded by the reconcile instead of going diverged.
    expect(CLIENT_MANAGER_PROMPT).not.toMatch(/dr-lurie|fernwell|platform|zilberman/i);
    expect(classifyConversationalAgentPrompt(rev7Text)).toBe("superseded");
    expect(classifyConversationalAgentPrompt(CLIENT_MANAGER_PROMPT)).toBe("canonical");
    expect(pendingCanonicalPromptUpgrades([{ ...createCanonicalClientManagerAgent(), prompt: rev7Text }])).toEqual([
      { id: "agt_client_manager", prompt: CLIENT_MANAGER_PROMPT }
    ]);
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
