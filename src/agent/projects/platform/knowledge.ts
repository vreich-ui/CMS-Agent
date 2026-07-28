// Safe, non-secret structured guidance for agents working against the platform client. Surfaced on
// project.get exactly like Dr. Lurie's knowledge block, so an agent can learn this client's rules
// without reading its codebase. Keep every line true of the OBJECT-NATIVE client: platform was born
// on the object substrate and carries none of Dr. Lurie's legacy article machinery.

export const platformProjectKnowledge = {
  projectId: "platform",
  sources: [
    "https://kugel-platform.netlify.app/manual",
    "docs/cms-architecture/ in the vreich-ui/platform repo"
  ],
  rules: {
    objectSubstrate: [
      "Every content surface is a governed object (site, page, section, navigation, taxonomy, template, section_template, theme, content_item, tracking_config); articles are content_item objects.",
      "The client's live object_contract for a type is the only source of truth for its shape, patch ops, and lifecycle verbs — fetch it at runtime, never assume.",
      "The self-documenting manual pages under /manual are generated from the live contracts and are safe orientation reading."
    ],
    noLegacyPath: [
      "This client has NO legacy save_json_blob_* article path — those tools throw here by design.",
      "Publishing goes through the object lifecycle: object_checkout -> object_patch/object_create -> object_publish -> release_to_production, under a held lock.",
      "Do not port Dr. Lurie's request/draft conventions onto this client."
    ],
    publishVsRelease: [
      "object_publish commits the export (store-backed, materialized to git) but does NOT deploy; release_to_production is the separate explicit gate that builds and goes live.",
      "A publish without a release accumulates: the next release deploys every pending publish at once — never trigger a release that was not explicitly approved.",
      "Verify go-live deploy-aware: deploy_status for the publish commit, then a reader check; a ready-but-undeployed build is not live."
    ],
    artifacts: [
      "Artifact transfer rides the per-site pdf-tool tenancy (get_pdf_tool_storage_grant); protocol id pdf_tool_platform_blob.v1.",
      "A pattern-valid blob key is not proof of materialization — require verification evidence for the SAME request before trusting any media reference."
    ],
    validation: [
      "object_validate is the client's own validator and the only verdict that counts as evidence; the client blocks unsafe writes (protected env values, hotlink URLs, rich-text vocabulary) at patch/create/publish time.",
      "Taxonomy comes from the site's registry (registry_get); resolve terms before publish or explicitly accept an empty taxonomy."
    ]
  }
};
