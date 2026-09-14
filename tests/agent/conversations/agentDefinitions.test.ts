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
    // Every earlier canonical text (rev 1 through rev 6) is superseded and upgradeable.
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
    // The current, live canonical text no longer carries this section either.
    expect(CLIENT_MANAGER_PROMPT).not.toContain("## Object ids you were not given");
  });

  // W5 (2026-09-13, publication-identity incident) — rev 7 landed the operator's live-store edit of
  // `agt_client_manager` as canonical, byte for byte. The sha256 below was computed, once, from the
  // exact JSON text returned by the single read-only `agent_get` call that task's report cited — it
  // is a checked-in fingerprint of that one fetch, not a live re-verification. ASV2-W4-CA
  // (2026-09-14) superseded this text with rev 8 (see below), so it now lives only at
  // SUPERSEDED_CLIENT_MANAGER_PROMPTS[6] — this test moved with it rather than being deleted, the
  // same pattern the rev 5/rev 6 historical tests above already follow.
  it("rev 7 landed the live-store operator edit verbatim, byte for byte (historical, superseded by rev 8)", () => {
    expect(createCanonicalClientManagerAgent().rev).toBe(8);
    const rev7Text = SUPERSEDED_CLIENT_MANAGER_PROMPTS[6];
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(sha256(rev7Text)).toBe("fa143f797dbc827e5519cbdccb011212cea4123ebb1897eefb2bc7873a73ef77");
    expect(rev7Text.length).toBe(9230);

    // New sections the operator's edit introduced.
    expect(rev7Text).toContain("## Say who you are once");
    expect(rev7Text).toMatch(/take the publication's name from the supplied project context/i);
    expect(rev7Text).toContain("## How to answer");
    expect(rev7Text).toContain("## Show what you are doing, not what you will do");
    expect(rev7Text).toContain("## Operations come before plans");
    expect(rev7Text).toMatch(/operation catalog/i);
    expect(rev7Text).toMatch(/saving is not applying, and applying is not releasing/i);

    // Sections the operator's edit dropped relative to rev 6 (a deliberate wholesale replacement,
    // not a smaller change layered on top — see the header comment above CLIENT_MANAGER_PROMPT).
    expect(rev7Text).not.toContain("## A one-off look for a set of articles");
    expect(rev7Text).not.toContain("## Object ids you were not given");
    // And it does not yet carry the rev 8 controls-protocol section.
    expect(rev7Text).not.toContain("## Choices and actions render as controls, not prose");

    // Still project-neutral.
    expect(rev7Text).not.toMatch(/dr-lurie|fernwell|platform|zilberman/i);

    expect(classifyConversationalAgentPrompt(rev7Text)).toBe("superseded");
    // The current, live canonical text is rev 8, not rev 7.
    expect(CLIENT_MANAGER_PROMPT).not.toBe(rev7Text);
  });

  // ASV2-W4-CA (2026-09-14, docs/cms-architecture/chat-controls-protocol.md §6-§7 in the platform
  // repo) — rev 8 mirrors the chat-controls protocol v2 into Client Manager: prefer a `controls`
  // block over typed-out prose for a finite choice, offer an `ui_capabilities.actions` entry as an
  // `actions` button instead of describing it, never name a verb outside that turn's
  // `ui_capabilities.actions`, one block per message, and treat a `[controls:…]` reply as the
  // editor's settled decision rather than re-asking. This is the ONLY change from rev 7 — nothing
  // else in the prompt moved (see the header comment above CLIENT_MANAGER_PROMPT).
  it("rev 8 teaches the chat-controls protocol v2 (ui_capabilities, controls blocks, offered-verb rule)", () => {
    expect(createCanonicalClientManagerAgent().rev).toBe(8);
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(sha256(CLIENT_MANAGER_PROMPT)).toBe("c3109cb6c011787fea898c3795f24a1235b8791a723a8752d1bf570c51609027");
    expect(CLIENT_MANAGER_PROMPT.length).toBe(10586);

    expect(CLIENT_MANAGER_PROMPT).toContain("## Choices and actions render as controls, not prose");
    expect(CLIENT_MANAGER_PROMPT).toMatch(/emit one `controls` block instead of typing the options into prose/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/at most one block per message/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/context\.ui_capabilities/);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/ui_capabilities\.controls/);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/ui_capabilities\.actions/);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/never name a verb that is not present in that turn's `ui_capabilities\.actions`/i);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/\[controls:<id>\]/);
    expect(CLIENT_MANAGER_PROMPT).toMatch(/is the editor's own settled decision, already recorded/i);

    // Every section rev 7 carried is still present — this was an insertion, not a rewrite.
    expect(CLIENT_MANAGER_PROMPT).toContain("## Say who you are once");
    expect(CLIENT_MANAGER_PROMPT).toContain("## Operations come before plans");
    expect(CLIENT_MANAGER_PROMPT).toContain("## One production path for articles");
    expect(CLIENT_MANAGER_PROMPT).toContain("## Starting and reporting production");

    // Still project-neutral.
    expect(CLIENT_MANAGER_PROMPT).not.toMatch(/dr-lurie|fernwell|platform|zilberman/i);

    // classifyConversationalAgentPrompt / pendingCanonicalPromptUpgrades still behave: the live
    // store's prompt (now == CLIENT_MANAGER_PROMPT) classifies canonical, and every prior canonical
    // text — including rev 7, now superseded rather than current — is upgradeable.
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

  // The mechanism the report cites: an existing workspace's stored rev is NOT force-set to the code
  // literal above — ensureConversationalAgentSeeds only ever increments the LIVE stored rev by one,
  // off whatever it currently holds, and only when that stored prompt still exactly matches a known
  // superseded text (never a diverged, operator-edited one). A store on rev 7's exact text moves to
  // rev 8's *text* but its own stored rev becomes (its rev)+1, which may not equal the literal 8
  // above if that workspace's live rev had already drifted from the freshly-seeded baseline.
  it("upgrades a workspace still on the rev 7 text to the rev 8 text, incrementing whatever rev it already held", async () => {
    const rev7Text = SUPERSEDED_CLIENT_MANAGER_PROMPTS[6];
    const stale = { ...createCanonicalClientManagerAgent(), prompt: rev7Text, rev: 41 };
    const store = new WorkspaceStateStore({ ...createDefaultWorkspaceDocument(), conversationalAgents: [stale] });

    const upgraded = (await store.ensureConversationalAgentSeeds())[0];
    expect(upgraded.prompt).toBe(CLIENT_MANAGER_PROMPT);
    expect(upgraded.rev).toBe(42);
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
