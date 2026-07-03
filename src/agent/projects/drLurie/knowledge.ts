export const drLurieProjectKnowledge = {
  projectId: "dr-lurie",
  sources: [
    "https://github.com/vreich-ui/Dr-Lurie-Blog/docs/diagnostics/",
    "https://github.com/vreich-ui/Dr-Lurie-Blog/docs/cms-architecture/"
  ],
  rules: {
    articleBodyV1: [
      "article_body.v1 is the canonical structured article body for Dr. Lurie content.",
      "Markdown is an adapter/export format only and must not become the canonical editing shape.",
      "Reader-visible image nodes must declare rendering.placement, usually inline, so preview and live rendering agree."
    ],
    contentSourceV1: [
      "content_source.v1 remains the working source envelope for intake and workflow context.",
      "Project adapters may map content_source.v1 into Dr. Lurie records, but must not bypass Dr. Lurie validation or review gates."
    ],
    artifactReferences: [
      "Image artifacts must be preserved as top-level output.artifactReferences arrays when handed to Dr. Lurie publishing flows.",
      "Nested artifactReferences are unsafe because Dr. Lurie publishing historically ignored misplaced references.",
      "Do not rewrite ArtifactReference blobKey values into reader-facing public URLs."
    ],
    imageMaterialization: [
      "Images are artifacts first; they become reader-visible only after Dr. Lurie materializes them into committed assets or another explicit image serving route.",
      "Accepted image materialization behavior is owned by the Dr. Lurie repo/MCP, not by the CMS-Agent workspace MCP."
    ],
    pdfFallbackBehavior: [
      "PDF/document artifacts may route through Dr. Lurie's /pdf/* fallback.",
      "Do not infer an equivalent /image/* public fallback for image artifacts unless Dr. Lurie adds one."
    ],
    inlineImagePlacement: [
      "Inline reader-visible images must use image nodes with rendering.placement: 'inline'.",
      "A node missing inline placement can disappear from the published body even if it appears in admin preview."
    ],
    heroVsInlineImagePaths: [
      "Hero/featured image selection and inline body rendering are separate paths.",
      "Do not assume a hero-designated image will render inline; avoid hero/inline collisions and preserve explicit placement metadata."
    ],
    publishVerificationTiming: [
      "Image verification immediately after publish can hit a pre-deploy page and produce false negatives.",
      "Verification should be deploy-aware and distinguish timing from true missing-image defects."
    ],
    futureCmsObjectModel: [
      "Future Dr. Lurie CMS architecture generalizes articles into ObjectRecord envelopes stored in site-objects.",
      "Object types include site, page, template, section, navigation, taxonomy, and content_item.",
      "Pages use Sections rendered by a Component Registry; articles keep article_body.v1 as a sibling grammar.",
      "Publishing should pass through review/publish gates and derived export materialization."
    ]
  }
} as const;

export type DrLurieProjectKnowledge = typeof drLurieProjectKnowledge;
