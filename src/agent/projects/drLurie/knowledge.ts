// Safe, non-secret structured guidance for agents working against the Dr. Lurie client. Surfaced on
// project.get so an agent can learn this client's rules without reading its codebase.
//
// Dr. Lurie is a tenant of the same object substrate as platform (client 0): articles are governed
// content_item objects, and the pre-object-model save_json_blob_*/markdown pipeline is frozen. Every
// line here must be true of the OBJECT path — the legacy-path rules this block used to carry
// (top-level output.artifactReferences, "never rewrite blobKey into a public URL", the
// rendering.placement render gate, "future CMS object model") were inverted or retired by it.
//
// Per-site identifiers are read from the connection config rather than restated as prose, so the
// registry ids an agent is told about cannot drift from the ones the publish hook actually uses.

import { DR_LURIE_OBJECT_DIALECT } from "./definition.js";
import { DR_LURIE_VOICE_FALLBACK } from "./editorialVoice.js";

export const drLurieProjectKnowledge = {
  projectId: "dr-lurie",
  // P-2 CLOSED (GUI rework Session B): this field is NO LONGER the runtime source of Dr. Lurie's
  // voice — a live run reads voice_drlurie fetched once per run by the conductor (voicePrefetch.ts)
  // and delivered directly in the input of every voice-consuming node, never through project.get.
  // What's surfaced here is descriptive only, for an agent inspecting the client's rules: which live
  // object id backs the voice, and the exact seed voicePrefetch.ts falls back to when that object is
  // unconfigured, unreachable, or missing (always with a named, run-visible warning — never silently).
  editorial: { voiceObjectId: DR_LURIE_OBJECT_DIALECT.voiceObjectId, fallback: DR_LURIE_VOICE_FALLBACK },
  sources: [
    "https://github.com/vreich-ui/Dr-Lurie-Blog/docs/agents/publishing-policy.md",
    "https://github.com/vreich-ui/Dr-Lurie-Blog/docs/cms-architecture/",
    "CMS-Agent/docs/projects/dr-lurie-agent-publishing-policy.md"
  ],
  site: {
    siteObjectId: DR_LURIE_OBJECT_DIALECT.siteObjectId,
    taxonomyRegistryObjectId: DR_LURIE_OBJECT_DIALECT.taxonomyRegistryObjectId,
    requestIdPattern: DR_LURIE_OBJECT_DIALECT.requestIdPattern
  },
  rules: {
    objectSubstrate: [
      "Every content surface is a governed object; articles are content_item objects, not markdown files.",
      "The live object_contract for a type is the only source of truth for its body shape, patch ops, and lifecycle verbs — fetch it at runtime rather than assuming.",
      "Look answers up (object_contract, object_inventory, object_validate) instead of probing the write path."
    ],
    noLegacyPath: [
      "The save_json_blob_* article pipeline and the five-agent per-stage output tools are FROZEN legacy: zero new writes, and they are blocked for this project at both the config and call_tool layers.",
      "Publishing goes through the object lifecycle: object_create -> object_checkout -> object_validate -> object_patch -> object_publish -> object_checkin.",
      "Reader URLs come from the publish response, never hand-constructed; the legacy /post/<slug> markdown route is dead."
    ],
    identityAndIds: [
      "The request id is the spine: req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case, caller-supplied and NEVER auto-generated.",
      "A content_item keeps that request-id shape as its object id, so the request id is sent as requested_id on create — get it right before doing anything else.",
      "Node ids are opaque n_* ids and must never carry strategy or commercial vocabulary; omit node.id on upsert_node to have one minted."
    ],
    bodyMapping: [
      "client_object.v1 is what the workspace authors; content_item.v1 is what the client stores. Map between them — do not send one as the other.",
      "Drop schema_version at the mapping step: the content_item body has no such field and its schema is strict, so an unknown key is rejected at write.",
      "Root slug, title, deck, description, taxonomy, seo, image, and editorial at the body; they are not node fields.",
      "An article is a sequence of functional blocks, each annotated with private.strategy and private.intent — one giant text node is a policy violation even when it validates."
    ],
    judgementsStayWorkspaceSide: [
      "The engine never writes the judgement substrate (scores, claims, sources, compliance, emotional_strategy, lineage) into a client object, even though set_article_meta's open fields map would accept it."
    ],
    artifacts: [
      "Images and PDFs are produced by PDF-Tool under a brokered storage grant (get_pdf_tool_storage_grant); never mint a storage key, repo path, or URL by hand.",
      "Renderable fields carry the PUBLIC path (/img/{req}/{sha}.ext, /pdf/{req}/{sha}.pdf); a raw blobKey in a renderable field is a write blocker and breaks the build. Raw refs belong only in *AssetRef / artifact_ref carrier fields.",
      "Artifact trust is scoped per request id — cross-request reuse is rejected by design; verify materialization before any object write, and a pattern-valid key is not proof of materialization.",
      "A PDF can never be the hero image."
    ],
    validationAndTaxonomy: [
      "object_validate is the client's own validator and the only verdict that counts as evidence; dry-run the exact candidate patch before patching.",
      `Taxonomy category and tags must resolve to ACTIVE terms in the ${DR_LURIE_OBJECT_DIALECT.taxonomyRegistryObjectId} registry; unknown terms block the write.`,
      "That registry is a curated, agent-editable vocabulary: prefer an existing term, otherwise extend it (add_term) — never delete terms to clean up, deprecate with a merge target."
    ],
    publishVsRelease: [
      "object_publish commits the export as a dark commit and does NOT deploy; release_to_production is the separate, explicit, paid gate that ships everything accumulated.",
      "Publishing is never a release: this workspace's publish path must not call release_to_production, and whether a run releases at all is decided upstream, never by the agent.",
      "Verify go-live deploy-aware: a verification run immediately after publish can hit a pre-deploy page and produce a false negative."
    ]
  }
} as const;

export type DrLurieProjectKnowledge = typeof drLurieProjectKnowledge;
