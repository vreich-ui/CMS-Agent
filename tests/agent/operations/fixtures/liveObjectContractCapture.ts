// LIVE CAPTURE — post-merge adversarial review of PR #387 (2026-09-18).
//
// PROVENANCE: read-only calls against the live "Kugel-Platform" MCP connector's real object substrate
// — `object_contract({object_type:"page"})`, `object_contract({object_type:"section"})`, and
// `object_get({object_type:"page", object_id:"page_home", projection:"summary"})` — the same
// connector tests/agent/capture/fixtures/platformToolSchemas.ts already captures tool SCHEMAS from.
// This file captures RESPONSE SHAPES instead: the two things a live adversarial review found this
// task's compile/apply path had been tested against a FICTION of (see siteContentObjectCompiler.ts's
// "CORRECTION" note and platformSiteObjectWriter.ts's "readContentRevision/readVersion USE THE SAME
// findDeep TOLERANCE" note for the findings these fixtures now pin).
//
// VERBATIM WHERE IT MATTERS. `LIVE_SECTION_TYPES` below is a TRIMMED subset (the full live
// `section_types` array carries 28 entries; keeping all of them here would dwarf the tests they
// support) but every entry actually included — `hero`, `prose`, `faq`, `bio`, `steps`,
// `shared_ref` — is copied verbatim from the live response, not retyped from memory or paraphrased:
// same key order, same schema, same `editor`/`footprint` blocks. `LIVE_PAGE_GET_SUMMARY` is the full,
// unedited `object_get` response for a real page (`page_home`) on this tenant.
//
// NOT a generated, drift-locked artifact (no `npm run *:update` regenerates this) — like
// platformToolSchemas.ts, this needs a human to re-run the capture below if the platform's contract or
// object_get envelope changes shape and a test here starts failing for a reason unrelated to the code
// under test.
//
// RE-CAPTURE: call `object_contract({object_type:"page"})` (or `"section"` — both carry the identical
// `section_types` registry) and `object_get({object_type:"page", object_id:"<any real page>",
// projection:"summary"})` against the live Kugel-Platform connector, paste the relevant entries in
// verbatim, and update LIVE_CAPTURE_AT below.
import type { PageTypeRule, SectionTypeRegistryEntry } from "../../../../src/agent/operations/siteContext.js";

export const LIVE_CAPTURE_AT = "2026-09-18";
export const LIVE_CAPTURE_SOURCE = 'the live "Kugel-Platform" MCP connector, object_contract(page|section) + object_get(page, page_home)';

// Verbatim entries from `object_contract({object_type:"page"}).contract.section_types` (and,
// identically, `object_contract({object_type:"section"}).contract.section_types` — the same top-level
// registry backs both object types; see siteContentObjectCompiler.ts's header for why that TOP-LEVEL
// key, not a path inside `body_schema`, is the real shape).
export const LIVE_SECTION_TYPES: ReadonlyArray<{
  type: string;
  component_bound: boolean;
  data_schema: Record<string, unknown>;
  editor?: Record<string, unknown>;
  footprint?: Record<string, unknown>;
}> = [
  {
    type: "hero",
    component_bound: true,
    data_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        kicker: { type: "string" },
        heading: { type: "string", minLength: 1 },
        body: { type: "string" },
        actions: { type: "array", items: { type: "object", properties: { label: { type: "string", minLength: 1 } }, required: ["label"], additionalProperties: true } },
        variant: { type: "string", enum: ["center", "split", "background"] }
      },
      required: ["heading", "actions"],
      additionalProperties: false
    },
    editor: {
      label: "Hero",
      icon: "tabler:sparkles",
      useWhen: "Big campaign-weight page opener: kicker, large heading, intro, CTA buttons. Use once, first, on landing/offer pages — interior pages usually want the quieter lede.",
      defaultData: { heading: "New page heading", actions: [] }
    },
    footprint: { region: "flow" }
  },
  {
    type: "prose",
    component_bound: true,
    data_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false
    },
    footprint: { region: "flow" }
  },
  {
    type: "faq",
    component_bound: true,
    data_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        heading: { type: "string" },
        items: {
          type: "array",
          items: { type: "object", properties: { q: { type: "string", minLength: 1 }, a: { type: "string" } }, required: ["q", "a"], additionalProperties: false }
        }
      },
      required: ["items"],
      additionalProperties: false
    },
    footprint: { region: "flow" }
  },
  {
    type: "bio",
    component_bound: true,
    data_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        kicker: { type: "string" },
        heading: { type: "string", minLength: 1 },
        portraitAssetRef: { type: "string" },
        portrait: { type: "object", properties: { src: { type: "string", minLength: 1 }, alt: { type: "string", minLength: 1 } }, required: ["src", "alt"], additionalProperties: false },
        body: { type: "string" },
        trustNotes: { type: "array", items: { type: "string" } },
        disclaimer: { type: "string" },
        anchor: { type: "string" }
      },
      required: ["heading", "body", "trustNotes"],
      additionalProperties: false
    },
    footprint: { region: "flow" }
  },
  {
    type: "steps",
    component_bound: true,
    data_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        kicker: { type: "string" },
        heading: { type: "string" },
        items: {
          minItems: 1,
          type: "array",
          items: { type: "object", properties: { title: { type: "string", minLength: 1 }, description: { type: "string" }, icon: { type: "string", minLength: 1 } }, required: ["title"], additionalProperties: false }
        },
        columns: { anyOf: [{ type: "number", const: 2 }, { type: "number", const: 3 }, { type: "number", const: 4 }] }
      },
      required: ["items"],
      additionalProperties: false
    },
    footprint: { region: "flow" }
  },
  {
    type: "shared_ref",
    component_bound: false,
    data_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { section: { type: "string", minLength: 1 }, sectionName: { type: "string", minLength: 1 } },
      required: ["section"],
      additionalProperties: false
    }
  }
];

// The full 28-name registry (`.type` only) — verbatim order from the live `section_types` array.
// `SECTION_CONTRACT`-style test fixtures use this for membership checks; `LIVE_SECTION_TYPES` above
// carries the full entries for the handful this repo's tests actually exercise a component's `data`
// shape against.
export const LIVE_SECTION_TYPE_NAMES: readonly string[] = [
  "hero", "prose", "lede", "checklist", "bio", "content_grid", "newsletter_signup", "contact_form",
  "cta_banner", "faq", "link_list", "product_preview", "steps", "composition", "content_split",
  "before_after", "pricing_table", "media", "brand_row", "stats", "timeline", "comparison_table",
  "testimonial", "search", "content_embed", "form_confirmation", "card", "shared_ref"
];

// Verbatim `object_get({object_type:"page", object_id:"page_home", projection:"summary"})` response
// against the live "kugel-platform" tenant — the shape that proved readContentRevision/readVersion's
// original shallow read wrong (content_revision/version live under `record`, not the envelope's own
// top level) and that proved the compiler's patch-diffing needs a page's real `body.sections`, not the
// `{}` a bulk object_inventory listing alone can ever supply.
export const LIVE_PAGE_GET_SUMMARY = {
  record: {
    object_id: "page_home",
    object_type: "page",
    schema_version: "page.v1",
    site: "site_platform",
    created_at: "2026-07-26T16:28:01.252Z",
    updated_at: "2026-08-02T18:31:21.615Z",
    status: "active",
    publication: {
      published_time: "2026-08-02T18:31:15.135Z",
      publish_receipt: {
        kind: "object_export_commit",
        branch: "main",
        commit_sha: "19dc5358687063761fe78955f8184a23f03a3c4b",
        tree_sha: "2d1c1d18bf411ccdba4e601c793528ddfd813137",
        no_op: false,
        attempts: 1,
        files: ["sites/platform/data/site/pages/page_home.json"],
        content_revision: 6,
        exported_at: "2026-08-02T18:31:15.135Z"
      }
    },
    version: 21,
    content_revision: 6,
    history_length: 21,
    body: {
      pageType: "system",
      route: "/",
      title: "Platform — home",
      seo: { description: "The platform site — staging, administration, and the instruction manual.", robots: { index: false, follow: false } },
      sections: [
        {
          id: "s_welcome",
          type: "hero",
          data: {
            kicker: "Governed CMS reference",
            heading: "Build, publish, and operate every surface as an object",
            body: "<p>The Platform tenant is executable documentation: its pages, menus, taxonomy, recipes, theme, article, tracking posture, product example, and editorial voice all use the same contracts it explains.</p>",
            actions: [
              { label: "Start here", target: { kind: "page", page: "page_start" }, style: "primary" },
              { label: "Read the manual", target: { kind: "page", page: "page_manual" }, style: "secondary" }
            ],
            variant: "split"
          }
        },
        {
          id: "s_how",
          type: "prose",
          data: {
            body: "<h2>One governed front door</h2><p>Each object type has a strict body schema, a small set of typed patch operations, reference rules, creation policy, and publication policy.</p>"
          }
        }
      ],
      navigationOverrides: { footer: "nav_footer" }
    }
  },
  projection: "summary"
} as const;

// THE REGISTRY GATE, STRUCTURED (C2) — all 28 entries of the live
// `object_contract("page").contract.section_types`, each carrying `type`, `component_bound` and
// `footprint` verbatim. Exactly two entries — `card` and `shared_ref` — carry
// `component_bound: false` / `footprint: null`; `before_after` is present, `component_bound: true`,
// region `flow`. `dataSchema` is carried verbatim for the handful this repo's compiler actually
// routes to (plus `hero`, `card`, `shared_ref`); it is omitted for the rest purely to keep this
// fixture readable — the entries themselves are the complete 28.
export const LIVE_SECTION_REGISTRY: readonly SectionTypeRegistryEntry[] = [
  {
    "type": "hero",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    },
    "dataSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "kicker": {
          "type": "string"
        },
        "heading": {
          "type": "string",
          "minLength": 1
        },
        "body": {
          "type": "string"
        },
        "actions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": {
                "type": "string",
                "minLength": 1
              },
              "target": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "type": "string",
                        "const": "page"
                      },
                      "page": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "required": [
                      "kind",
                      "page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "type": "string",
                        "const": "taxonomy"
                      },
                      "termKind": {
                        "type": "string",
                        "enum": [
                          "category",
                          "tag"
                        ]
                      },
                      "term_id": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "required": [
                      "kind",
                      "termKind",
                      "term_id"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "type": "string",
                        "const": "listing"
                      },
                      "list": {
                        "type": "string",
                        "const": "content_index"
                      }
                    },
                    "required": [
                      "kind",
                      "list"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "type": "string",
                        "const": "external"
                      },
                      "href": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "required": [
                      "kind",
                      "href"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "type": "string",
                        "const": "asset"
                      },
                      "href": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "required": [
                      "kind",
                      "href"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "type": "string",
                        "const": "route"
                      },
                      "href": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "required": [
                      "kind",
                      "href"
                    ],
                    "additionalProperties": false
                  }
                ]
              },
              "style": {
                "type": "string",
                "enum": [
                  "primary",
                  "secondary",
                  "link"
                ]
              }
            },
            "required": [
              "label",
              "target"
            ],
            "additionalProperties": false
          }
        },
        "variant": {
          "type": "string",
          "enum": [
            "center",
            "split",
            "background"
          ]
        }
      },
      "required": [
        "heading",
        "actions"
      ],
      "additionalProperties": false
    }
  },
  {
    "type": "prose",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    },
    "dataSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "body": {
          "type": "string"
        }
      },
      "required": [
        "body"
      ],
      "additionalProperties": false
    }
  },
  {
    "type": "lede",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "checklist",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "bio",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    },
    "dataSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "kicker": {
          "type": "string"
        },
        "heading": {
          "type": "string",
          "minLength": 1
        },
        "portraitAssetRef": {
          "type": "string"
        },
        "portrait": {
          "type": "object",
          "properties": {
            "src": {
              "type": "string",
              "minLength": 1
            },
            "alt": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "src",
            "alt"
          ],
          "additionalProperties": false
        },
        "body": {
          "type": "string"
        },
        "trustNotes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "disclaimer": {
          "type": "string"
        },
        "anchor": {
          "type": "string"
        }
      },
      "required": [
        "heading",
        "body",
        "trustNotes"
      ],
      "additionalProperties": false
    }
  },
  {
    "type": "content_grid",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "newsletter_signup",
    "componentBound": true,
    "footprint": {
      "region": "flow",
      "singleton": true
    }
  },
  {
    "type": "contact_form",
    "componentBound": true,
    "footprint": {
      "region": "flow",
      "singleton": true
    }
  },
  {
    "type": "cta_banner",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "faq",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    },
    "dataSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "heading": {
          "type": "string"
        },
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "q": {
                "type": "string",
                "minLength": 1
              },
              "a": {
                "type": "string"
              }
            },
            "required": [
              "q",
              "a"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "items"
      ],
      "additionalProperties": false
    }
  },
  {
    "type": "link_list",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "product_preview",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "steps",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    },
    "dataSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "kicker": {
          "type": "string"
        },
        "heading": {
          "type": "string"
        },
        "items": {
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "minLength": 1
              },
              "description": {
                "type": "string"
              },
              "icon": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "title"
            ],
            "additionalProperties": false
          }
        },
        "columns": {
          "anyOf": [
            {
              "type": "number",
              "const": 2
            },
            {
              "type": "number",
              "const": 3
            },
            {
              "type": "number",
              "const": 4
            }
          ]
        }
      },
      "required": [
        "items"
      ],
      "additionalProperties": false
    }
  },
  {
    "type": "composition",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "content_split",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "before_after",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    },
    "dataSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "kicker": {
          "type": "string"
        },
        "heading": {
          "type": "string"
        },
        "before": {
          "type": "object",
          "properties": {
            "src": {
              "type": "string",
              "minLength": 1
            },
            "alt": {
              "type": "string",
              "minLength": 1
            },
            "label": {
              "type": "string",
              "minLength": 1,
              "maxLength": 48
            }
          },
          "required": [
            "src",
            "alt",
            "label"
          ],
          "additionalProperties": false
        },
        "after": {
          "type": "object",
          "properties": {
            "src": {
              "type": "string",
              "minLength": 1
            },
            "alt": {
              "type": "string",
              "minLength": 1
            },
            "label": {
              "type": "string",
              "minLength": 1,
              "maxLength": 48
            }
          },
          "required": [
            "src",
            "alt",
            "label"
          ],
          "additionalProperties": false
        },
        "caption": {
          "type": "string",
          "minLength": 1,
          "maxLength": 240
        },
        "action": {
          "type": "object",
          "properties": {
            "label": {
              "type": "string",
              "minLength": 1
            },
            "target": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "page"
                    },
                    "page": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "page"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "taxonomy"
                    },
                    "termKind": {
                      "type": "string",
                      "enum": [
                        "category",
                        "tag"
                      ]
                    },
                    "term_id": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "termKind",
                    "term_id"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "listing"
                    },
                    "list": {
                      "type": "string",
                      "const": "content_index"
                    }
                  },
                  "required": [
                    "kind",
                    "list"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "external"
                    },
                    "href": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "href"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "asset"
                    },
                    "href": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "href"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "route"
                    },
                    "href": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "href"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "style": {
              "type": "string",
              "enum": [
                "primary",
                "secondary",
                "link"
              ]
            }
          },
          "required": [
            "label",
            "target"
          ],
          "additionalProperties": false
        },
        "anchor": {
          "type": "string"
        }
      },
      "required": [
        "before",
        "after"
      ],
      "additionalProperties": false
    }
  },
  {
    "type": "pricing_table",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "media",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "brand_row",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "stats",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "timeline",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "comparison_table",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "testimonial",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "search",
    "componentBound": true,
    "footprint": {
      "region": "flow",
      "singleton": true
    }
  },
  {
    "type": "content_embed",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "form_confirmation",
    "componentBound": true,
    "footprint": {
      "region": "flow"
    }
  },
  {
    "type": "card",
    "componentBound": false,
    "footprint": null,
    "dataSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1
        },
        "description": {
          "type": "string"
        },
        "link": {
          "type": "object",
          "properties": {
            "label": {
              "type": "string",
              "minLength": 1
            },
            "target": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "page"
                    },
                    "page": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "page"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "taxonomy"
                    },
                    "termKind": {
                      "type": "string",
                      "enum": [
                        "category",
                        "tag"
                      ]
                    },
                    "term_id": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "termKind",
                    "term_id"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "listing"
                    },
                    "list": {
                      "type": "string",
                      "const": "content_index"
                    }
                  },
                  "required": [
                    "kind",
                    "list"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "external"
                    },
                    "href": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "href"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "asset"
                    },
                    "href": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "href"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "route"
                    },
                    "href": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "href"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "style": {
              "type": "string",
              "enum": [
                "primary",
                "secondary",
                "link"
              ]
            }
          },
          "required": [
            "label",
            "target"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    }
  },
  {
    "type": "shared_ref",
    "componentBound": false,
    "footprint": null,
    "dataSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "section": {
          "type": "string",
          "minLength": 1
        },
        "sectionName": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "section"
      ],
      "additionalProperties": false
    }
  }
];

// PAGETYPE LAW — the full live `object_contract("page").contract.page_types`, verbatim. Six entries;
// four restrict `allowedSections`. `home` requires `["hero"]`, `listing` requires `["lede"]`;
// `clone` and `standard` place no restriction ("any").
export const LIVE_PAGE_TYPES: readonly PageTypeRule[] = [
  {
    "id": "home",
    "routePattern": "/",
    "allowedSections": [
      "hero",
      "checklist",
      "content_grid",
      "bio",
      "newsletter_signup",
      "shared_ref"
    ],
    "requiredSections": [
      "hero"
    ]
  },
  {
    "id": "clone",
    "routePattern": "/[...captured]",
    "allowedSections": "any",
    "requiredSections": []
  },
  {
    "id": "standard",
    "routePattern": "/[slug]",
    "allowedSections": "any",
    "requiredSections": []
  },
  {
    "id": "system",
    "routePattern": "/[system]",
    "allowedSections": [
      "hero",
      "prose",
      "link_list",
      "cta_banner"
    ],
    "requiredSections": []
  },
  {
    "id": "listing",
    "routePattern": "/[...listing]",
    "allowedSections": [
      "lede",
      "prose",
      "cta_banner",
      "newsletter_signup",
      "content_grid",
      "link_list",
      "shared_ref"
    ],
    "requiredSections": [
      "lede"
    ]
  },
  {
    "id": "content_detail",
    "routePattern": "/[...blog]",
    "allowedSections": [
      "prose",
      "cta_banner",
      "newsletter_signup",
      "content_grid",
      "link_list",
      "shared_ref"
    ],
    "requiredSections": []
  }
];
