import type { WorkspaceNode, WorkspaceGraphValidation } from "./nodeTypes.js";
// W6.5: contract_intelligence.v1 and article_brief.v1 carry trafficSource/awarenessStage validation
// below sourced from aggressionVector.ts's canonical value lists, not a hand-copied enum, so the two
// can never drift out of sync with the mapping tables that actually govern the aggression vector.
import { AWARENESS_STAGE_VALUES, RECOGNIZED_TRAFFIC_SOURCES } from "./aggressionVector.js";

const TRAFFIC_SOURCE_ENUM_PROPERTY = {
  type: "string",
  enum: [...RECOGNIZED_TRAFFIC_SOURCES],
  description: "The run's traffic source, echoed for provenance. Validated against aggressionVector.ts's RECOGNIZED_TRAFFIC_SOURCES (the same table placement_resolver's target computation reads) — never a hand-copied list, so this cannot drift from the value that actually determined the aggression target/ceiling/resolved vectors upstream."
} as const;
const AWARENESS_STAGE_ENUM_PROPERTY = {
  type: "string",
  enum: [...AWARENESS_STAGE_VALUES],
  description: "The run's awareness stage, echoed for provenance. Validated against aggressionVector.ts's AWARENESS_STAGE_VALUES (the same five-stage set computeAggressionTarget's base table is keyed on) — never a hand-copied list, so this cannot drift from the value that actually determined the aggression target/ceiling/resolved vectors upstream."
} as const;

export const publishingConductorNodes = [
  {
    "id": "input_triage",
    "name": "CMS Input Triage",
    "kind": "intake",
    "description": "Clarify the publishing request, identify missing inputs, and establish the working content_source.v1 envelope.",
    "prompt": "Objective: Clarify the publishing request, identify missing inputs, and establish the working content_source.v1 envelope.\nInputs expected: user request and any supplied content_source.v1 envelope.\nOutput required: produce content_source.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "content_source.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "content_source.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "content_source.v1"
    ],
    "produces": [
      "content_source.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [],
    "status": "active",
    "position": {
      "x": -391,
      "y": 148
    },
    "updatedAt": "2026-07-31T09:33:42.728Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 90000,
      "budgetUsd": 0.1,
      "maxOutputTokens": 2000
    }
  },
  {
    "id": "placement_resolver",
    "name": "Placement Resolver",
    "kind": "strategy",
    "description": "Compute the aggression TARGET vector — claim_strength, urgency, emotional_agitation, cta_density on a 0-1 scale — deterministically from the request's traffic source and awareness stage. The target is computed by engine code, never hand-set; the resolved vector applied downstream is min(client ceiling, target) componentwise.",
    "prompt": "Objective: Establish the aggression TARGET vector for this placement — four dials (claim_strength, urgency, emotional_agitation, cta_density), each 0-1 — from the request's trafficSource and awarenessStage.\nInputs expected: input_triage (the content_source.v1 envelope; trafficSource and awarenessStage are read from it or from the run's initial input).\nDeterminism policy: the target is COMPUTED by the engine's deterministic mapping (aggressionVector.ts), which runs before any model turn and normally completes this node without one. Never invent, adjust, or hand-set a dial value; never resolve against a client ceiling here — resolution (min(ceiling, target) componentwise) happens where the client contract is available, and an absent ceiling is a blocker there, not a default.\nOutput required: produce placement_resolution.v1 with trafficSource and awarenessStage echoed, target carrying the four dials as numbers 0-1, and rationale naming the mapping applied.\nCompletion criteria: the target reflects the deterministic mapping for the declared traffic source and awareness stage; the scale is 0-1; rationale is explicit.\nBlocker criteria: trafficSource or awarenessStage missing from the request — a target must never be guessed from content alone.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "trafficSource",
        "awarenessStage",
        "target",
        "rationale"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "placement_resolution.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "trafficSource": {
          "type": "string",
          "minLength": 1
        },
        "awarenessStage": {
          "type": "string",
          "minLength": 1
        },
        "target": {
          "type": "object",
          "description": "The aggression TARGET vector, 0-1 scale per dial, computed deterministically from (trafficSource, awarenessStage) — never hand-set. Resolution against the client ceiling (min componentwise; absent ceiling blocks) happens downstream where the contract is available.",
          "required": [
            "claim_strength",
            "urgency",
            "emotional_agitation",
            "cta_density"
          ],
          "additionalProperties": false,
          "properties": {
            "claim_strength": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "urgency": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "emotional_agitation": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "cta_density": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            }
          }
        },
        "rationale": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "trafficSource",
        "awarenessStage",
        "target",
        "rationale"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "placement_resolution.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "trafficSource": {
          "type": "string",
          "minLength": 1
        },
        "awarenessStage": {
          "type": "string",
          "minLength": 1
        },
        "target": {
          "type": "object",
          "description": "The aggression TARGET vector, 0-1 scale per dial, computed deterministically from (trafficSource, awarenessStage) — never hand-set. Resolution against the client ceiling (min componentwise; absent ceiling blocks) happens downstream where the contract is available.",
          "required": [
            "claim_strength",
            "urgency",
            "emotional_agitation",
            "cta_density"
          ],
          "additionalProperties": false,
          "properties": {
            "claim_strength": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "urgency": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "emotional_agitation": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "cta_density": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            }
          }
        },
        "rationale": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "input_triage"
    ],
    "produces": [
      "placement_resolution.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "input_triage"
    ],
    "status": "active",
    "position": {
      "x": -60,
      "y": 0
    },
    "updatedAt": "2026-08-10T00:00:00.000Z",
    "metadata": {
      "approvalRequired": false,
      "placementResolverDeterministic": true
    },
    "modelConfig": {
      "maxTurns": 2,
      "toolCallLimit": 1,
      "timeout": 60000,
      "budgetUsd": 0.05,
      "maxOutputTokens": 1500
    }
  },
  {
    "id": "topic_opportunity",
    "name": "Topic Opportunity Agent",
    "kind": "strategy",
    "description": "Assess topic viability, audience value, search/editorial opportunity, and recommended positioning.",
    "prompt": "Objective: Decide whether the request should become an article, page section, content update, product/resource support asset, or no-build recommendation for the target client.\nInputs expected: input_triage and placement_resolver (the computed aggression TARGET vector for this placement — use it to judge how commercially assertive the recommended route may be; never recompute or override its dials), plus clientProjectId (the run's registered client) delivered in this node's input.\nOutput required: produce topic_opportunity.v1 with recommended content route, reader value, business value, SEO/search intent notes when relevant, evidence depth needed, and cost path.\nCost policy: choose the smallest workflow that can satisfy the request safely. Recommend deep research only for current, comparative, regulatory, source-sensitive, or claim-heavy work; a client whose domain needs a stricter evidence bar (health, finance, legal) declares it in its own record. Recommend skipping redundant strategy passes when the request is simple.\nNext-step policy: prefer content that moves a reader toward a useful next step: related reading, newsletter, routine decision, product/resource consideration, or trust-building.\nClient policy: this node serves any registered client. clientProjectId names the target; the client's voice, audience, and commercial direction come from the client's own record and the run's inputs, never from this prompt. When the conductor delivers editorialVoice in this node's input (fetched live from the client's voice_<project> record, or its seeded fallback when the live record is unavailable — editorialVoiceSource names which), use its audience/tone/frameworks to judge reader value and route; do not assume a different client's voice when editorialVoice is absent. Treat a missing or unresolvable client identity as a blocker rather than assuming a client.\nCompletion criteria: the route, audience value, evidence need, and blockers are explicit.\nBlocker criteria: unclear target, missing or unresolvable target client, unsafe request, no viable reader value, missing critical input, or requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "topic_opportunity.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "topic_opportunity.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [
      "seo_review"
    ],
    "requiredInputs": [
      "input_triage",
      "placement_resolver"
    ],
    "produces": [
      "topic_opportunity.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "input_triage",
      "placement_resolver"
    ],
    "status": "active",
    "position": {
      "x": 280,
      "y": 0
    },
    "updatedAt": "2026-07-31T09:33:42.729Z",
    "metadata": {
      "approvalRequired": false,
      "voicePrefetch": true
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 90000,
      "budgetUsd": 0.1,
      "maxOutputTokens": 2500
    }
  },
  {
    "id": "monetization_strategy",
    "name": "Monetization Strategy Agent",
    "kind": "strategy",
    "description": "Select the commercial offer (or an explicit no-offer decision) for the piece BEFORE the brief is written, using the monetizer project's live offer data reached read-only at runtime.",
    "prompt": "Objective: Decide what this piece is monetizing before the brief exists: select one offer from the monetizer project's live data, or decide explicitly that no offer fits, and say why.\nInputs expected: topic_opportunity (the recommended route and audience/business value), plus clientProjectId (the run's registered client) delivered in this node's input.\nOffer policy: reach the monetizer project read-only through project.call_read_tool to list and inspect candidate offers. Prefer offers matching the topic's commercial intent and the client's audience; an unmatched topic gets selectedOffer null with the gap named in offerRationale rather than a forced fit. Never invent an offer, a payout, or a merchant that the monetizer's own data does not carry.\nOutput required: produce monetization_strategy.v1 with selectedOffer (the chosen offer's identifying fields as the monetizer returns them, or null), offerRationale (why this offer, or why none), and commercialIntent (the piece's commercial posture, e.g. transactional, commercial, supporting, none).\nCompletion criteria: the brief architect can aim the brief at a named offer or a named no-offer decision without re-doing this selection; assumptions and blockers are explicit.\nBlocker criteria: missing topic_opportunity, missing or unresolvable target client, or the monetizer project being unreachable when an offer decision materially depends on live offer data — record the outage rather than guessing.\nTool policy: use only allowedTools; reads go through project.call_read_tool, which needs no approval; project.call_tool is approval-gated and reserved for writes, which this node never performs — do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "selectedOffer",
        "offerRationale",
        "commercialIntent"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "monetization_strategy.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "selectedOffer": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true,
          "description": "The chosen offer's identifying fields as returned by the monetizer project (id/name/merchant/url/payout as available), or null when no offer fits this piece."
        },
        "offerRationale": {
          "type": "string",
          "minLength": 1
        },
        "commercialIntent": {
          "type": "string",
          "minLength": 1,
          "description": "The piece's commercial posture, e.g. transactional, commercial, supporting, none."
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "selectedOffer",
        "offerRationale",
        "commercialIntent"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "monetization_strategy.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "selectedOffer": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true,
          "description": "The chosen offer's identifying fields as returned by the monetizer project (id/name/merchant/url/payout as available), or null when no offer fits this piece."
        },
        "offerRationale": {
          "type": "string",
          "minLength": 1
        },
        "commercialIntent": {
          "type": "string",
          "minLength": 1,
          "description": "The piece's commercial posture, e.g. transactional, commercial, supporting, none."
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs",
      "project.call_read_tool",
      "monetize.ev_floor"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "topic_opportunity"
    ],
    "produces": [
      "monetization_strategy.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "topic_opportunity"
    ],
    "status": "active",
    "position": {
      "x": 420,
      "y": 90
    },
    "updatedAt": "2026-08-10T00:00:00.000Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 4,
      "toolCallLimit": 3,
      "timeout": 120000,
      "budgetUsd": 0.2,
      "maxOutputTokens": 3000
    }
  },
  {
    "id": "reader_insight",
    "name": "Reader Insight Agent",
    "kind": "strategy",
    "description": "Define reader needs, motivations, sophistication, pains, desired outcomes, and decision context.",
    "prompt": "Objective: Define reader needs, motivations, sophistication, pains, desired outcomes, and decision context.\nInputs expected: topic_opportunity.\nOutput required: produce reader_insight.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "reader_insight.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "reader_insight.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "topic_opportunity"
    ],
    "produces": [
      "reader_insight.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "topic_opportunity"
    ],
    "status": "active",
    "position": {
      "x": 560,
      "y": 0
    },
    "updatedAt": "2026-07-31T09:33:42.729Z",
    "metadata": {
      "externalStageMapping": "reader_insight",
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 90000,
      "budgetUsd": 0.1,
      "maxOutputTokens": 2500
    }
  },
  {
    "id": "research",
    "name": "Research Agent",
    "kind": "research",
    "description": "Gather source-backed claims, evidence, examples, constraints, and open questions for the article.",
    "prompt": "Objective: Gather only the evidence needed to support the article's material claims, reader decisions, and the trust standard the target client's content must meet.\nInputs expected: reader_insight, plus clientProjectId (the run's registered client) delivered in this node's input.\nOutput required: produce research_brief.v1 with sourced facts, practical implications, claim risk notes, open questions, and source references.\nCost policy: do not browse by default. Use web.search/web.fetch only for claims that are current, comparative, regulatory, or otherwise source-sensitive; a client whose domain needs a stricter evidence bar declares it in its own record. Prefer primary, authoritative, or source-owner pages when available. Stop once reliable evidence covers the decision the article must help the reader make. Extract what you need from each fetched page as soon as you read it — quote the finding with its source — instead of re-fetching or carrying whole pages forward; every retained page is re-sent on each of your subsequent turns.\nEvidence policy: separate sourced facts, interpretation, uncertainty, and unsupported claims. Flag claims that should be softened or removed. When this node's input carries editorialVoice, its claim_policy and reader_safety_notes set the evidence bar for THIS client — a stricter bar (e.g. a health/finance/legal audience) tightens what counts as sufficient sourcing; treat its absence as no stricter bar declared, not as license to relax defaults.\nCompletion criteria: required inputs are addressed, sources are concise and relevant, output matches schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unavailable evidence for important claims, unsupported certainty on high-stakes claims, contradictory instructions, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "research_brief.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "research_brief.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs",
      "web.search",
      "web.fetch"
    ],
    "assignedSkills": [
      "web_research"
    ],
    "requiredInputs": [
      "reader_insight"
    ],
    "produces": [
      "research_brief.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "reader_insight"
    ],
    "status": "active",
    "position": {
      "x": 840,
      "y": 0
    },
    "updatedAt": "2026-07-31T09:33:42.729Z",
    "metadata": {
      "externalStageMapping": "research",
      "approvalRequired": false,
      "voicePrefetch": true
    },
    "modelConfig": {
      "maxTurns": 8,
      "toolCallLimit": 5,
      "timeout": 240000,
      "budgetUsd": 3,
      "maxOutputTokens": 4000,
      "retryCount": 1
    }
  },
  {
    "id": "objection_mapping",
    "name": "Objection Mapping Agent",
    "kind": "strategy",
    "description": "Map reader objections, skepticism, points of confusion, and trust gaps to address in the narrative.",
    "prompt": "Objective: Map reader objections, skepticism, points of confusion, and trust gaps to address in the narrative.\nInputs expected: research.\nOutput required: produce objection_map.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "objection_map.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "objection_map.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "research"
    ],
    "produces": [
      "objection_map.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "research"
    ],
    "status": "active",
    "position": {
      "x": 1120,
      "y": 0
    },
    "updatedAt": "2026-07-31T09:33:42.729Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 90000,
      "budgetUsd": 0.15,
      "maxOutputTokens": 3000
    }
  },
  {
    "id": "narrative_movement",
    "name": "Narrative Movement Agent",
    "kind": "strategy",
    "description": "Design the article's reader journey, section movement, stakes, transitions, and resolution arc.",
    "prompt": "Objective: Design the article's reader journey, section movement, stakes, transitions, and resolution arc.\nInputs expected: objection_mapping.\nOutput required: produce narrative_movement.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "narrative_movement.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "narrative_movement.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "objection_mapping"
    ],
    "produces": [
      "narrative_movement.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "objection_mapping"
    ],
    "status": "active",
    "position": {
      "x": 0,
      "y": 180
    },
    "updatedAt": "2026-07-31T09:35:11.082Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 90000,
      "budgetUsd": 0.15,
      "maxOutputTokens": 3500
    }
  },
  {
    "id": "angle_strategy",
    "name": "Angle Strategist",
    "kind": "strategy",
    "description": "Select the strongest angle, promise, tension, differentiation, and external five-stage angle mapping.",
    "prompt": "Objective: Select the strongest angle, promise, tension, differentiation, and external five-stage angle mapping.\nInputs expected: narrative_movement.\nOutput required: produce angle_strategy.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "angle_strategy.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "angle_strategy.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "narrative_movement"
    ],
    "produces": [
      "angle_strategy.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "narrative_movement"
    ],
    "status": "active",
    "position": {
      "x": 280,
      "y": 180
    },
    "updatedAt": "2026-07-31T09:35:11.082Z",
    "metadata": {
      "externalStageMapping": "angle",
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 90000,
      "budgetUsd": 0.15,
      "maxOutputTokens": 3000
    }
  },
  {
    "id": "brief_architect",
    "name": "Brief Architect",
    "kind": "planning",
    "description": "Convert strategy into an executable article brief with structure, claims, proof points, and acceptance criteria.",
    "prompt": "Objective: Convert upstream strategy and evidence into one executable article/content brief for the target client.\nInputs expected: topic_opportunity, monetization_strategy (the selected offer — or explicit no-offer decision — this brief must be aimed at; a hard input, never re-decided here), reader_insight, research, objection_mapping, narrative_movement, and angle_strategy — all delivered directly in this node's input as dependency outputs — plus clientProjectId (the run's registered client). Everything this brief needs is already in your input; do not fetch stage outputs or hunt for additional context.\nOutput required: produce article_brief.v1 with title/slug direction, reader promise, article structure, claim/proof map, reader next step, SEO/meta notes, tone guardrails, acceptance criteria, and what to skip — plus mediaSlots, a structured array with one entry {slotId, purpose, desiredKind, placement} per media need the run's envelope actually requests (a hero image, an inline diagram, whatever the reader promise calls for). mediaSlots policy: derive slots ONLY from what the envelope's media request states or the article structure demonstrably needs — never invent a slot to make the brief feel complete. When the envelope requests no media at all, emit mediaSlots as an EMPTY ARRAY, not an absent field and not null: artifact_plan's zero-media skip predicate reads this exact array before doing any other work, so an honest empty array is what tells it, cheaply and structurally, that there is nothing to plan. Never omit mediaSlots and never emit null in its place — either would read as 'unknown', which runs artifact_plan needlessly, or worse, silently reads a stale answer from another carrier.\nCost policy: collapse duplicate strategy into this brief. Do not ask downstream agents to rediscover the angle. Include only sections, claims, and review needs that materially improve the article.\nNext-step policy: make the content useful first and commercially aware second. Add a low-pressure next step only where it fits the reader journey.\nClient policy: clientProjectId names the target client. Voice, styling, and audience direction belong to the client's own record, never to this prompt. Take tone guardrails ONLY from what is present in this node's input (the run's initial instructions and the delivered upstream outputs); when a client voice record exists the conductor delivers it in your input as editorialVoice (fetched live from voice_<project>, or its seeded fallback when the live record is unavailable — editorialVoiceSource names which), and its tone/cadence/lexicon/cta_policy/frameworks are this brief's tone guardrails. If no voice direction is present, record that gap as an assumption, set neutral reader-first guardrails, and continue — do not spend tool calls searching other stages for a voice record that was not delivered. Treat a missing or unresolvable client identity as a blocker rather than assuming a client.\nContract policy: note likely target object type, expected content-object fields, taxonomy needs, and whether contract_intelligence must inspect anything beyond the client's default object type.\nCompletion criteria: the draft writer can write without guessing; research and factual risks are visible; blockers are explicit.\nBlocker criteria: missing strategy, missing or unresolvable target client, missing evidence for required claims, unsupported certainty on high-stakes claims, unclear audience/action, or requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "mediaSlots",
        "resolved",
        "resolvedBasis"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "article_brief.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "trafficSource": TRAFFIC_SOURCE_ENUM_PROPERTY,
        "awarenessStage": AWARENESS_STAGE_ENUM_PROPERTY,
        "mediaSlots": {
          "type": "array",
          "description": "Every media need the envelope's media request implies, one entry per slot. EMPTY ARRAY (never absent, never null) when the run requests no media at all — the honest 'asked, none wanted' signal artifact_plan's no_media_slots skip predicate reads before it does any structural scan.",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "slotId",
              "purpose"
            ],
            "properties": {
              "slotId": {
                "type": "string",
                "minLength": 1
              },
              "purpose": {
                "type": "string",
                "minLength": 1
              },
              "desiredKind": {
                "type": "string"
              },
              "placement": {
                "type": "string"
              }
            }
          }
        },
        "resolved": {
          "type": "object",
          "description": "The aggression vector this brief actually resolved to (0..1 per axis) — the store-truth carrier draft_writer reads. Never omitted: when no adjustment was needed, echo the placement target verbatim.",
          "additionalProperties": false,
          "required": [
            "claim_strength",
            "urgency",
            "emotional_agitation",
            "cta_density"
          ],
          "properties": {
            "claim_strength": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "urgency": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "emotional_agitation": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "cta_density": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            }
          }
        },
        "resolvedBasis": {
          "type": "string",
          "minLength": 1,
          "description": "One line naming what `resolved` was derived from (placement target echoed, ceiling clamp applied, editorial adjustment) so the vector is auditable."
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "mediaSlots",
        "resolved",
        "resolvedBasis"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "article_brief.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "trafficSource": TRAFFIC_SOURCE_ENUM_PROPERTY,
        "awarenessStage": AWARENESS_STAGE_ENUM_PROPERTY,
        "mediaSlots": {
          "type": "array",
          "description": "Every media need the envelope's media request implies, one entry per slot. EMPTY ARRAY (never absent, never null) when the run requests no media at all — the honest 'asked, none wanted' signal artifact_plan's no_media_slots skip predicate reads before it does any structural scan.",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "slotId",
              "purpose"
            ],
            "properties": {
              "slotId": {
                "type": "string",
                "minLength": 1
              },
              "purpose": {
                "type": "string",
                "minLength": 1
              },
              "desiredKind": {
                "type": "string"
              },
              "placement": {
                "type": "string"
              }
            }
          }
        },
        "resolved": {
          "type": "object",
          "description": "The aggression vector this brief actually resolved to (0..1 per axis) — the store-truth carrier draft_writer reads. Never omitted: when no adjustment was needed, echo the placement target verbatim.",
          "additionalProperties": false,
          "required": [
            "claim_strength",
            "urgency",
            "emotional_agitation",
            "cta_density"
          ],
          "properties": {
            "claim_strength": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "urgency": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "emotional_agitation": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "cta_density": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            }
          }
        },
        "resolvedBasis": {
          "type": "string",
          "minLength": 1,
          "description": "One line naming what `resolved` was derived from (placement target echoed, ceiling clamp applied, editorial adjustment) so the vector is auditable."
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [
      "article_structuring",
      "editorial_craft"
    ],
    "requiredInputs": [
      "topic_opportunity",
      "monetization_strategy",
      "reader_insight",
      "research",
      "objection_mapping",
      "narrative_movement",
      "angle_strategy",
      "placement_resolver"
    ],
    "produces": [
      "article_brief.v1"
    ],
    "riskLevel": "read",
    // W6.5 (2026-08-12): placement_resolver added as an explicit dependency so the conductor delivers
    // placement_resolution.v1 (the trafficSource/awarenessStage-derived aggression TARGET) directly in
    // this node's input, rather than the node having to fetch it itself as a fallback stage read. This
    // edge exists in the live workspace store already; it is added here to the code seed so the two
    // stop drifting — reaching the LIVE store still requires a deliberate re-seed (npm run
    // nodes:update), which this change does not perform.
    "dependsOn": [
      "topic_opportunity",
      "monetization_strategy",
      "reader_insight",
      "research",
      "objection_mapping",
      "narrative_movement",
      "angle_strategy",
      "placement_resolver"
    ],
    "status": "active",
    "position": {
      "x": 560,
      "y": 180
    },
    "updatedAt": "2026-07-31T09:35:11.082Z",
    "metadata": {
      "approvalRequired": false,
      "voicePrefetch": true
    },
    "modelConfig": {
      "maxTurns": 4,
      "toolCallLimit": 2,
      "timeout": 180000,
      "budgetUsd": 0.4,
      "maxOutputTokens": 5000
    }
  },
  {
    "id": "draft_writer",
    "name": "Full Draft Writer",
    "kind": "drafting",
    "description": "Write a complete draft from the approved brief while preserving canonical structured artifacts over Markdown.",
    "prompt": "Objective: Write the complete reader-facing draft from article_brief.v1 in the target client's editorial voice.\nInputs expected: brief_architect, plus clientProjectId (the run's registered client) delivered in this node's input.\nVoice policy: the client's voice and styling direction come from the client's own record and the brief's tone guardrails, never from this prompt. When this node's input carries editorialVoice (fetched live from voice_<project>, or its seeded fallback when the live record is unavailable — editorialVoiceSource names which), write in that name/audience/tone/cadence, prefer its lexicon.prefer terms, avoid its lexicon.avoid terms, follow its claim_policy and cta_policy, and choose a frameworks entry (default_framework if none fits better) to shape the piece. If no client voice direction is supplied, write calm, precise, practical, evidence-led, reader-first prose and record the gap as an assumption. Never write in a client voice the input does not declare.\nOutput required: produce draft.v1 with proposed title, deck/description, slug candidate, section-by-section draft, source/claim notes, suggested CTA/next step, and unresolved questions.\nAggression policy: the brief's `resolved` vector (claim_strength, urgency, emotional_agitation, cta_density; 0..1 each) sets how hard this draft pushes. If the brief carries no `resolved` vector, write to the placement target delivered in your input and record `aggression_vector_assumed` in `notes` — do not block.\nStyle policy: calm, precise, practical, evidence-led, and reader-first. Avoid hype, fear tactics, fake urgency, invented sources, and overclaiming; never state certainty the evidence does not support, and never imply professional advice (medical, legal, financial) the content is not qualified to give — a client whose domain needs stricter caution declares it in its own record. Use concrete decisions, tradeoffs, and reassurance.\nStructure policy: write in a form that can be converted into the client's content-object nodes. Keep headings and paragraphs clean. Do not expose private strategy labels in reader-visible copy.\nCost policy: do not re-research; use the brief and research outputs. Mark evidence gaps instead of inventing support.\nCompletion criteria: the draft can be reviewed without major missing sections; claims are tied to research or flagged; blockers are explicit.\nBlocker criteria: missing brief, missing or unresolvable target client, missing evidence for required claims, unsupported certainty on high-stakes claims, unclear audience/action, or requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "draft.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "draft.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [
      "editorial_craft"
    ],
    "requiredInputs": [
      "brief_architect"
    ],
    "produces": [
      "draft.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "brief_architect"
    ],
    "status": "active",
    "position": {
      "x": 840,
      "y": 180
    },
    "updatedAt": "2026-07-31T09:35:11.082Z",
    "metadata": {
      "externalStageMapping": "draft",
      "approvalRequired": false,
      "voicePrefetch": true
    },
    "modelConfig": {
      "maxTurns": 4,
      "toolCallLimit": 2,
      "timeout": 300000,
      "budgetUsd": 0.5,
      "maxOutputTokens": 8000,
      "retryCount": 1
    }
  },
  {
    "id": "human_texture",
    "name": "Human Texture Editor",
    "kind": "review",
    "description": "Improve specificity, rhythm, voice, examples, and lived-in human texture without changing factual meaning.",
    "prompt": "Objective: Improve specificity, rhythm, voice, examples, and lived-in human texture without changing factual meaning.\nInputs expected: draft_writer.\nOutput required: produce human_texture_review.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "human_texture_review.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "human_texture_review.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [
      "editorial_craft"
    ],
    "requiredInputs": [
      "draft_writer"
    ],
    "produces": [
      "human_texture_review.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "draft_writer"
    ],
    "status": "active",
    "position": {
      "x": 1120,
      "y": 180
    },
    "updatedAt": "2026-07-31T09:35:11.082Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 180000,
      "budgetUsd": 0.25,
      "maxOutputTokens": 4000
    }
  },
  {
    "id": "trust_factual",
    "name": "Trust / Factual Editor",
    "kind": "review",
    "description": "Check claims, citations, hedging, trust signals, factual risk, and unsupported assertions.",
    "prompt": "Objective: Check the draft for claim safety, citation sufficiency, hedging, reader trust, and the evidence standards the target client's content must meet.\nInputs expected: draft_writer and research, plus clientProjectId (the run's registered client) delivered in this node's input.\nOutput required: produce trust_factual_review.v1 with claims to keep, soften, support, remove, or re-source; citation gaps; compliance risk; and concise revision instructions.\nCost policy: use existing research first. Fetch only source URLs already cited or clearly necessary to resolve a material uncertainty. Do not run broad new research unless the draft contains an important unsupported claim.\nEvidence policy: distinguish sourced facts, interpretation, and uncertainty. Flag unsupported claims and overconfident language on high-stakes points; a client whose domain needs a stricter evidence bar declares it in its own record. When this node's input carries editorialVoice (fetched live from voice_<project>, or its seeded fallback when the live record is unavailable — editorialVoiceSource names which), its claim_policy and reader_safety_notes ARE that bar — apply them directly rather than inferring a generic one. Prefer softer practical phrasing when evidence is limited.\nCompletion criteria: factual risks are prioritized, actionable, and tied to the draft; blockers are explicit.\nBlocker criteria: missing draft, missing research for material claims, unavailable source evidence, unsupported certainty on high-stakes claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "trust_factual_review.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "trust_factual_review.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs",
      "web.fetch"
    ],
    "assignedSkills": [
      "factual_review",
      "source_verification"
    ],
    "requiredInputs": [
      "draft_writer",
      "research"
    ],
    "produces": [
      "trust_factual_review.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "draft_writer",
      "research"
    ],
    "status": "active",
    "position": {
      "x": -57,
      "y": 386
    },
    "updatedAt": "2026-07-31T09:36:03.991Z",
    "metadata": {
      "approvalRequired": false,
      "voicePrefetch": true
    },
    "modelConfig": {
      "maxTurns": 8,
      "toolCallLimit": 5,
      "timeout": 180000,
      "budgetUsd": 0.4,
      "maxOutputTokens": 3000,
      "retryCount": 1
    }
  },
  {
    "id": "emotional_resonance",
    "name": "Emotional Resonance Evaluator",
    "kind": "review",
    "description": "Evaluate emotional clarity, stakes, empathy, reader momentum, and resonance with the intended audience.",
    "prompt": "Objective: Evaluate emotional clarity, stakes, empathy, reader momentum, and resonance with the intended audience.\nInputs expected: draft_writer, input_triage (the original request envelope, for audience and intent), reader_insight (the audience definition: needs, motivations, sophistication, decision context) and objection_mapping (the reader's skepticism, confusion points, and trust gaps).\nOutput required: produce emotional_resonance_review.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "emotional_resonance_review.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "emotional_resonance_review.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [
      "editorial_craft"
    ],
    "requiredInputs": [
      "draft_writer",
      "input_triage",
      "reader_insight",
      "objection_mapping"
    ],
    "produces": [
      "emotional_resonance_review.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "draft_writer",
      "input_triage",
      "reader_insight",
      "objection_mapping"
    ],
    "status": "active",
    "position": {
      "x": 280,
      "y": 360
    },
    "updatedAt": "2026-07-31T09:36:03.991Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 120000,
      "budgetUsd": 0.2,
      "maxOutputTokens": 2500
    }
  },
  {
    "id": "reader_simulation",
    "name": "Reader Simulation",
    "kind": "review",
    "description": "Simulate likely reader reactions, drop-off points, questions, objections, and conversion readiness.",
    "prompt": "Objective: Simulate likely reader reactions, drop-off points, questions, objections, and conversion readiness.\nInputs expected: draft_writer, reader_insight (who this reader is and what they came for), objection_mapping (the objections and trust gaps they are likely to raise) and angle_strategy (the promised angle and tension the piece must pay off).\nOutput required: produce reader_simulation.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "reader_simulation.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "reader_simulation.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "draft_writer",
      "reader_insight",
      "objection_mapping",
      "angle_strategy"
    ],
    "produces": [
      "reader_simulation.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "draft_writer",
      "reader_insight",
      "objection_mapping",
      "angle_strategy"
    ],
    "status": "active",
    "position": {
      "x": 560,
      "y": 360
    },
    "updatedAt": "2026-07-31T09:36:03.991Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 120000,
      "budgetUsd": 0.2,
      "maxOutputTokens": 2500
    }
  },
  {
    "id": "review_aggregator",
    "name": "Review Aggregator",
    "kind": "review",
    "description": "Combine parallel reviews into prioritized revisions, unresolved conflicts, and final build instructions.",
    "prompt": "Objective: Combine parallel reviews into prioritized revisions, unresolved conflicts, and final build instructions.\nInputs expected: human_texture, trust_factual, emotional_resonance, reader_simulation.\nOutput required: produce review_aggregation.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "review_aggregation.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "review_aggregation.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "human_texture",
      "trust_factual",
      "emotional_resonance",
      "reader_simulation"
    ],
    "produces": [
      "review_aggregation.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "human_texture",
      "trust_factual",
      "emotional_resonance",
      "reader_simulation"
    ],
    "status": "active",
    "position": {
      "x": 840,
      "y": 360
    },
    "updatedAt": "2026-07-31T09:36:03.991Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 120000,
      "budgetUsd": 0.25,
      "maxOutputTokens": 3500
    }
  },
  {
    "id": "contract_intelligence",
    "name": "Contract Intelligence Agent",
    "kind": "research",
    "description": "Fetch the target client's live object contract at runtime and reduce it to the rules downstream nodes must obey. The client contract is the single source of truth; never author content rules from memory or from a workspace-local copy.",
    "prompt": "Objective: Turn the target client's ALREADY-FETCHED, ALREADY-REDUCED object contract into contract_intelligence.v1, the rules every downstream node must obey. The client's contract is the single source of truth for content shape, ids, media paths, taxonomy, and publishing gates. Never author these rules from memory, from a workspace-local schema, or from another client's contract.\nInputs expected: brief_architect (its article_brief.v1 output), plus clientProjectId (the run's registered client — the conductor delivers it in every node's input; never guess it and never substitute a remembered client) and `prefetchedContract` supplied directly in your input — the conductor calls the client's contract surface deterministically, in code, BEFORE you run, and reduces it (dropping prose, examples, and error catalogues) precisely so you never have to fetch or carry the raw multi-KB contract yourself across your own turns. `prefetchedContract` carries: clientObjectType, bodySchema (the real JSON Schema, kept whole — it is structural, not prose), idConventions, mediaConvention, taxonomy, constraints (with severity and enforcedLive), publishPolicy, workflowSequence, validationSurface (patch/write operations with their required fields), contractSource {tool, fetchedAtISO}, and an `unmapped` bucket for anything the deterministic reduction did not recognize but preserved anyway.\nIf `prefetchedContract` is present: this is a validation and pass-through step, not a discovery one. Sanity-check it, write a concise summary, carry its fields into your own output verbatim (mapping field names as needed — see Output required), and surface anything in `unmapped` worth downstream attention. Do not call project.call_read_tool to re-fetch the primary contract — it has already been fetched this run. Reach for project.call_read_tool ONLY for something genuinely missing from the prefetch (e.g. a registry/taxonomy lookup the client's contract pointed at but did not inline, or the client's own contract tool for a DIFFERENT object type than what was prefetched) — it needs no approval and only reaches read operations (object_contract, registry_get, object_inventory, object_get, object_list, object_validate, ping); reserve project.call_tool for a genuine write, which this node does not perform.\nIf `prefetchError` is present instead (the deterministic fetch failed — unreachable client, policy block, unsupported object type): treat it exactly as the unreachable-client blocker criterion below; do not attempt to fetch the contract yourself as a substitute unless prefetchedContract is entirely absent from your input (an older run/deployment that never wired the prefetch), in which case fall back to the discovery policy your allowedTools describe.\nOutput required: produce contract_intelligence.v1 carrying, at minimum: clientProjectId (from your own input's clientProjectId — the run's registered client), clientObjectType, bodySchema (from prefetchedContract.bodySchema, or your own reduction of a fetched contract, verbatim — never the full raw contract re-derived, so the large fetched payload does not compound across turns nor get carried whole into every downstream node's input), the id conventions (object id and node/child id patterns, from prefetchedContract.idConventions), the media/artifact path convention (raw artifact reference field vs public serving path, and which fields accept which, from prefetchedContract.mediaConvention), the taxonomy source and whether unknown terms block (from prefetchedContract.taxonomy), the enumerated structural constraints with their severity and whether each is enforced live (from prefetchedContract.constraints), the publish policy including whether approval is required and any pinning rules (from prefetchedContract.publishPolicy), and contractSource {tool, fetchedAtISO} (from prefetchedContract.contractSource, or your own fetch's).\nGeneralization policy: this node must work for ANY client the workflow encounters, not one named client. Do not hardcode a client's field names, path prefixes, or object types into your reasoning; read them from prefetchedContract (or the contract you fetched) and pass them forward as data. Where a client's contract is silent, say so explicitly as an assumption rather than filling the gap from another client's conventions.\nCompletion criteria: a downstream node can construct and validate a client object using only your output plus the client's own validator, without guessing and without consulting any workspace-local schema.\nBlocker criteria: the client project is unreachable or unconfigured, clientProjectId is missing from your input, its contract tools are unavailable or denied by policy, the requested object type is unsupported, the contract cannot be fetched read-only, or the contract declares constraints this workspace cannot satisfy.\nTool policy: use only allowedTools; reach the client only through project.call_read_tool and only with its permitted read-only contract, registry, inventory, and validation operations, and only for what prefetchedContract does not already supply; project.call_tool is approval-gated and reserved for writes only; this node performs no writes and must never publish, create, patch, or otherwise mutate the client.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; never persist secrets, storage grants, raw authorization headers, or tokens.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "clientProjectId",
        "clientObjectType",
        "contractSource"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "contract_intelligence.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "clientProjectId": {
          "type": "string",
          "minLength": 1
        },
        "clientObjectType": {
          "type": "string",
          "minLength": 1
        },
        "contractSource": {
          "type": "object",
          "additionalProperties": true
        },
        "trafficSource": TRAFFIC_SOURCE_ENUM_PROPERTY,
        "awarenessStage": AWARENESS_STAGE_ENUM_PROPERTY,
        "bodySchema": {
          "type": "object",
          "additionalProperties": true
        },
        "idConventions": {
          "type": "object",
          "additionalProperties": true
        },
        "mediaConvention": {
          "type": "object",
          "additionalProperties": true
        },
        "taxonomy": {
          "type": "object",
          "additionalProperties": true
        },
        "constraints": {
          "type": "array"
        },
        "publishPolicy": {
          "type": "object",
          "additionalProperties": true
        },
        "mediaPolicy": {
          "type": "object",
          "additionalProperties": true
        },
        "contract_findings": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "assumptions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "clientProjectId",
        "clientObjectType",
        "contractSource"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "contract_intelligence.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "clientProjectId": {
          "type": "string",
          "minLength": 1
        },
        "clientObjectType": {
          "type": "string",
          "minLength": 1
        },
        "contractSource": {
          "type": "object",
          "additionalProperties": true
        },
        "trafficSource": TRAFFIC_SOURCE_ENUM_PROPERTY,
        "awarenessStage": AWARENESS_STAGE_ENUM_PROPERTY,
        "bodySchema": {
          "type": "object",
          "additionalProperties": true
        },
        "idConventions": {
          "type": "object",
          "additionalProperties": true
        },
        "mediaConvention": {
          "type": "object",
          "additionalProperties": true
        },
        "taxonomy": {
          "type": "object",
          "additionalProperties": true
        },
        "constraints": {
          "type": "array"
        },
        "publishPolicy": {
          "type": "object",
          "additionalProperties": true
        },
        "mediaPolicy": {
          "type": "object",
          "additionalProperties": true
        },
        "contract_findings": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "assumptions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.save_output",
      "stage.list_outputs",
      "project.call_tool",
      "project.call_read_tool"
    ],
    "assignedSkills": [
      "contract_intelligence"
    ],
    "requiredInputs": [
      "brief_architect"
    ],
    "produces": [
      "contract_intelligence.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "brief_architect"
    ],
    "status": "active",
    "position": {
      "x": 1420,
      "y": 700
    },
    "updatedAt": "2026-07-31T09:36:03.991Z",
    "metadata": {
      "approvalRequired": false,
      "contractPrefetch": true,
      "contractIntelligenceDeterministic": true
    },
    "modelConfig": {
      "maxTurns": 6,
      "toolCallLimit": 3,
      "timeout": 180000,
      "budgetUsd": 0.35,
      "maxOutputTokens": 6000,
      "retryCount": 1
    }
  },
  {
    "id": "artifact_plan",
    "name": "Artifact Planning Agent",
    "kind": "adapter",
    "description": "Plan and MATERIALIZE media/artifact requirements from brief_architect's mediaSlots, against the client's declared artifact protocol and id conventions, before article_body runs. No legacy fallbacks, no unverified media.",
    "prompt": "Objective: Plan and MATERIALIZE every media/artifact need brief_architect declared, using only the artifact protocol the client's contract declares — and hand article_body verified references to build with, before article_body ever runs.\nSource of truth: the client's fetched contract declares the artifact protocol, the request-id convention, the media path rules, and the media budget. Read them from contract_intelligence, delivered directly in this node's input, rather than assuming. Carry clientProjectId, clientObjectType and contractSource forward.\nInputs expected: brief_architect (mediaSlots — the desired-media declaration, one entry {slotId, purpose, desiredKind, placement} per slot the envelope's media request asked for) and contract_intelligence (the artifact protocol, id convention, media path rules and budget), both delivered directly in this node's input. article_body has not run yet — do not expect it, do not wait for it, and do not read a body that does not exist yet.\nZero-media shortcut: when brief_architect's mediaSlots is an empty array, emit the plan immediately from your input with an empty slot list and zero tool calls. There is nothing to verify; spending turns proving the absence of media is the failure mode this node's budget exists to prevent. A zero-media plan may omit artifactProtocol entirely — there was no protocol to consult, and inventing a protocol string for an empty plan is exactly the fabrication this node forbids elsewhere.\nRequest id policy: derive the requestId from the CLIENT's id convention, record that convention in requestIdConvention, and confirm the id is acceptable to the client before any artifact is written. An artifact generator may accept a laxer id than the client's index does; writing under a non-conforming id creates an artifact the client can never list, reconcile, or delete. If the id cannot be confirmed, mark slots blocked rather than materializing.\nArtifact protocol policy: the client's declared protocol is the only valid transfer path. Media must be represented by references the protocol produced for the CURRENT request. Never use repo paths, remote URLs, data URIs, direct-save fallbacks, references copied from another request or slug, or hand-authored keys.\nMaterialization policy — one call, verified: for each non-empty slot, call the client site bridge's artifact-generation tool (create_agent_artifact_job, reached through project.call_tool) with the slot's purpose, desiredKind and the client's brand styling — this single call GENERATES the artifact AND VERIFIES it was materialized for the current request before returning, so its response IS the verification evidence: record its returned key, digest, content type, size and timestamp in the slot's verification field. Never mark a slot has_trusted_artifact because a key merely matches a pattern — only a materialization response (or an explicit verification tool's proof, where the artifact service offers one instead) is evidence. Absent verification, pending or timed-out approval, or a synthetic reference means status needs_generation or blocked, plus a blocker.\nPublic path policy: when the contract distinguishes a raw artifact reference from a rendered public path, resolve and record both on the slot — the raw reference for the client's reference fields and publicPath for its rendered fields (this is the exact value article_body must bind into body.image.src). Do not hand-author a public path the contract did not define.\nMedia budget policy: honor the client's declared image budget and preferred format. If an artifact exceeds the budget, follow the client's over-budget rule — flag it when the policy warns, block it when the policy blocks, and prefer asking the artifact service to re-encode within budget over shipping an oversize asset.\nCapability policy: if the artifact service's required capabilities are not permitted by the registered project policy, do not attempt generation. Emit blockers naming the exact missing capabilities in requiredArtifactCapabilities and the slots that need them.\nApproval/resume policy: if generation or verification needs operator approval and it is unavailable or times out, never invent a pointer. Emit a blocker carrying requestId, slotId, the required capability, and the pending action so the run can resume safely.\nCompletion criteria: every desired slot is either bound to a verified current-request artifact with its correct raw and public forms, or explicitly blocked with the missing capability, approval, or verification reason. No unverified media passes downstream — article_body must be able to trust every artifactReferences entry and every slot's publicPath you emit without re-verifying them itself.\nBlocker criteria: missing mediaSlots declaration when one was expected; missing or unconfirmable request id; unreachable client or artifact service; missing storage grant path; denied capabilities; unverified materialization; approval timeout; over-budget media under a blocking policy; or any request to use a legacy fallback.\nTool policy: use only allowedTools. Read-only policy, status, and id-confirmation lookups go through project.call_read_tool, which needs no approval; project.call_tool is approval-gated and reserved for writes, including the create_agent_artifact_job generate-and-verify call. Do not publish, release, or mutate the client from this node.\nMemory policy: save only this node's structured output; never persist storage grants, tokens, raw authorization headers, or scoped upload credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "artifact",
        "summary",
        "clientProjectId",
        "clientObjectType",
        "media_slots"
      ],
      "if": {
        "required": [
          "media_slots"
        ],
        "properties": {
          "media_slots": {
            "minItems": 1
          }
        }
      },
      "then": {
        "required": [
          "artifactProtocol"
        ]
      },
      "properties": {
        "artifact": {
          "const": "artifact_plan.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "clientProjectId": {
          "type": "string",
          "minLength": 1
        },
        "clientObjectType": {
          "type": "string",
          "minLength": 1
        },
        "contractSource": {
          "type": "object",
          "additionalProperties": true
        },
        "artifactProtocol": {
          "type": "string",
          "minLength": 1
        },
        "requestId": {
          "type": "string",
          "minLength": 1
        },
        "requestIdConvention": {
          "type": "string"
        },
        "requestIdConfirmedByClient": {
          "type": "boolean"
        },
        "media_slots": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "slotId",
              "purpose",
              "status"
            ],
            "properties": {
              "slotId": {
                "type": "string",
                "minLength": 1
              },
              "purpose": {
                "type": "string",
                "minLength": 1
              },
              "status": {
                "enum": [
                  "has_trusted_artifact",
                  "needs_generation",
                  "blocked"
                ]
              },
              "nodeId": {
                "type": "string"
              },
              "placement": {
                "type": "string"
              },
              "desiredKind": {
                "type": "string"
              },
              "artifactReference": {
                "type": "object",
                "additionalProperties": true
              },
              "verification": {
                "type": "object",
                "additionalProperties": true
              },
              "publicPath": {
                "type": "string"
              },
              "missingCapability": {
                "type": "string"
              },
              "blocker": {
                "type": "string"
              }
            }
          }
        },
        "artifactReferences": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "requiredArtifactCapabilities": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "additionalProperties": true,
      "properties": {
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        },
        "stageOutputs": {
          "type": "object"
        }
      },
      "type": "object"
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "artifact",
        "summary",
        "clientProjectId",
        "clientObjectType",
        "media_slots"
      ],
      "if": {
        "required": [
          "media_slots"
        ],
        "properties": {
          "media_slots": {
            "minItems": 1
          }
        }
      },
      "then": {
        "required": [
          "artifactProtocol"
        ]
      },
      "properties": {
        "artifact": {
          "const": "artifact_plan.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "clientProjectId": {
          "type": "string",
          "minLength": 1
        },
        "clientObjectType": {
          "type": "string",
          "minLength": 1
        },
        "contractSource": {
          "type": "object",
          "additionalProperties": true
        },
        "artifactProtocol": {
          "type": "string",
          "minLength": 1
        },
        "requestId": {
          "type": "string",
          "minLength": 1
        },
        "requestIdConvention": {
          "type": "string"
        },
        "requestIdConfirmedByClient": {
          "type": "boolean"
        },
        "media_slots": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "slotId",
              "purpose",
              "status"
            ],
            "properties": {
              "slotId": {
                "type": "string",
                "minLength": 1
              },
              "purpose": {
                "type": "string",
                "minLength": 1
              },
              "status": {
                "enum": [
                  "has_trusted_artifact",
                  "needs_generation",
                  "blocked"
                ]
              },
              "nodeId": {
                "type": "string"
              },
              "placement": {
                "type": "string"
              },
              "desiredKind": {
                "type": "string"
              },
              "artifactReference": {
                "type": "object",
                "additionalProperties": true
              },
              "verification": {
                "type": "object",
                "additionalProperties": true
              },
              "publicPath": {
                "type": "string"
              },
              "missingCapability": {
                "type": "string"
              },
              "blocker": {
                "type": "string"
              }
            }
          }
        },
        "artifactReferences": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "requiredArtifactCapabilities": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.save_output",
      "stage.list_outputs",
      "project.call_tool",
      "project.call_read_tool"
    ],
    "assignedSkills": [
      "contract_intelligence"
    ],
    "requiredInputs": [
      "brief_architect",
      "contract_intelligence"
    ],
    "produces": [
      "artifact_plan.v1"
    ],
    "riskLevel": "write",
    // T8 (Wave 3, 2026-08-13, run_1786557897658_elj34j): artifact_plan used to depend on article_body,
    // which meant the media it plans could only be verified AFTER the body that would reference it was
    // already written — a text-only body always shipped from that run, media or not, because there was
    // never a verified reference to bind by the time article_body ran. Depending on brief_architect
    // (mediaSlots, the desired-media declaration) and contract_intelligence (the artifact protocol, id
    // convention, and media path rules) instead makes artifact_plan run BEFORE article_body, so a
    // verified reference exists to hand article_body before it builds the body that would carry it.
    "dependsOn": [
      "brief_architect",
      "contract_intelligence"
    ],
    "status": "active",
    "position": {
      "x": 1120,
      "y": 500
    },
    "updatedAt": "2026-07-31T09:36:58.473Z",
    "metadata": {
      "approvalRequired": true,
      "canonicalRules": [
        "The client's contract declares the artifact protocol, id convention and media path rules",
        "A pattern-valid key is never proof of materialization",
        "Request ids must satisfy the client's convention before any artifact is written",
        "No legacy artifact fallback systems",
        "create_agent_artifact_job (client site bridge, via project.call_tool) generates and verifies a brand-styled artifact in one call — that call's response is the verification evidence, not a separate lookup"
      ]
    },
    "modelConfig": {
      "toolCallLimit": 8,
      "timeout": 180000,
      "budgetUsd": 0.5,
      "maxOutputTokens": 3000
    }
  },
  {
    "id": "article_body",
    "name": "Article Body Builder",
    "kind": "builder",
    "description": "Build the client's content object in the client's own shape, using the contract fetched at runtime by contract_intelligence. The client contract is the only source of truth; no workspace-local content schema is authoritative.",
    "prompt": "Objective: Build the target client's content object in the CLIENT'S OWN SHAPE, using the contract that contract_intelligence fetched at runtime. Emit it as the body field of this node's output envelope.\nSource of truth: the client's fetched contract is the ONLY authoritative content schema. Never build to a workspace-local article schema, never build from memory of a previous client, and never treat a workspace validator's verdict as authoritative. If contract_intelligence did not supply a contract with contractSource provenance, that is a blocker — do not proceed on assumption.\nInputs expected: review_aggregator (the approved editorial content), draft_writer (the complete drafted prose — build the body FROM this draft as amended by review_aggregator's revision instructions, never by re-writing the article from notes), contract_intelligence (the client contract), narrative_movement (the reader-journey arc: section movement, stakes, transitions, resolution), angle_strategy (the chosen angle, promise, and tension) — the upstream editorial reasoning your per-node private annotations are built from — and artifact_plan (media_slots already materialized and verified for this run, with each slot's artifactReference and publicPath), delivered directly in this node's input. artifact_plan has already run and already generated and verified whatever media brief_architect's mediaSlots asked for; you bind its output, you do not plan or generate media yourself. clientProjectId also arrives directly in this node's input from the conductor and must agree with contract_intelligence's clientProjectId; if they disagree, that is a blocker. Carry clientProjectId, clientObjectType and contractSource straight through from contract_intelligence into your output.\nBody construction policy: shape body exactly to the contract's body schema — its required fields, its field names, its id patterns, its enums, and its strictness. If the contract's schema is strict (additionalProperties false), emit no field it does not declare, including workspace-only fields such as a schema version marker. Root the client's fields where the contract roots them. Where the contract offers a richer representation than plain text (for example a structured rich-text grammar), prefer it only if the contract declares it and you can satisfy its grammar; otherwise use the simplest representation the contract accepts and note the choice.\nPrivate annotation policy: where the contract's body schema declares per-node private annotation fields (for example a private block with closed strategy/intent enums and a free-text notes field), populate them on EVERY node you emit — an absent private annotation is a defect, not a default. Choose each enum value ONLY from the enum the contract itself declares — never invent, pluralize, or approximate a value — mapping each node's role in the piece from narrative_movement's arc and angle_strategy's angle/promise plus review_aggregator's build instructions, and put the one-sentence reasoning for the choice in the contract's free-text private notes field. If narrative_movement or angle_strategy outputs are absent or skipped (for example a late-stage entry run), derive the annotation from the approved content itself and record that as an assumption. Private annotation is never reader-visible — the contract's renderer emits public fields only — so annotate every node rather than leaving private fields absent. If the contract declares no private annotation fields for this object type, note that instead; never add undeclared fields.\nMedia policy: read the media convention from the contract rather than assuming one. Distinguish the fields that accept a RAW artifact reference from the fields that are RENDERED, and put the right form in each: rendered fields take the client's public serving path, raw reference fields take the artifact key. If the contract states that raw keys are rejected in rendered fields, honor that — a raw key in a rendered field is a build-breaking error, not a cosmetic one. Only reference artifacts that were materialized for the CURRENT request and verified by the artifact tool; pattern-valid keys are not proof. Never use remote URLs, data URIs, repo paths, hand-authored keys, or references copied from another request or another slug. Respect the client's media budget and preferred format when the contract or storage grant declares them. Honor any placement or rendering metadata the contract requires for reader-visible media — omitting it can silently drop the media from the published page.\nVerified media binding policy: artifact_plan already ran, already generated the media brief_architect's mediaSlots asked for, and already verified each reference against the client's artifact protocol — its media_slots array is the ONLY source of media for this build. For every slot with status has_trusted_artifact, bind its publicPath into the contract's rendered image field in the contract's own shape — exactly { src: publicPath, alt } where the contract's schema calls it that, or the equivalent rendered-field name the contract declares — and bind its raw artifactReference (never the publicPath) into the contract's raw reference field, and mirror the same bound reference into this node's own media-bearing fields (artifactReferences, mediaPathConvention) so downstream nodes need not re-derive it. NEVER bind a slot artifact_plan marked needs_generation or blocked, NEVER bind a reference this node did not receive from artifact_plan (no re-fetching, no re-generating, no re-verifying — that is artifact_plan's job and it already did it), and NEVER place a raw artifact key in a rendered field: an unverified reference or a raw key in a rendered field must never reach a rendered field, full stop — if artifact_plan left a slot unresolved, leave that slot's rendered field absent and record the gap as a blocker or assumption instead of guessing.\nClient validation policy: before completing, validate through the CLIENT's own validator via project.call_read_tool, read-only, and record the outcome in clientValidation {tool, valid, issues}. project.call_read_tool needs NO approval and is the correct surface for validation; do not use project.call_tool for reads, and do not report yourself blocked because project.call_tool is unavailable — that tool is deliberately approval-gated for writes only. If the client's validator requires an existing object record that does not yet exist, do NOT attempt to create one — this node is write-prohibited. Record clientValidation {attempted: true, tool, valid: false, deferred: \"requires_existing_object\"} quoting the client's own refusal in issues, and treat that as a NORMAL outcome, not a blocker: the authoritative validation runs in the publish executor after object_create and before any patch. Do not claim validity, and do not spend further calls re-attempting once the client has reported the object does not exist. If the client cannot be reached or its read-only validator is denied by the project's own policy, set clientValidation.attempted false, add a blocker, and do not claim validity.\nReader-safety policy: reader-visible strings must never leak strategy labels, prompts, scoring, internal notes, or workflow vocabulary. Put internal annotation only in the private/internal fields the contract designates. Follow the contract's id rules, including any prohibition on ids that reveal intent.\nCompletion criteria: body satisfies the client's contract as fetched; contract-declared private annotation fields are populated on every emitted node (or the contract's silence on them is noted); every media reference is verified and in the correct form for its field; clientValidation records a real result from the client, or a deferral because the validator requires an object that does not yet exist; assumptions and blockers are explicit.\nBlocker criteria: no contract or no contractSource provenance; the client is unreachable or unconfigured; clientProjectId is missing from this node's input or disagrees with contract_intelligence's; required contract fields cannot be satisfied from the approved content; taxonomy terms do not resolve and the contract blocks unknown terms; media is missing, unverified, or cannot be expressed in the form the contract demands; or the contract declares a constraint this workspace cannot meet.\nTool policy: use only allowedTools; reach the client through project.call_read_tool for every read-only contract and validation operation; project.call_tool is approval-gated and reserved for writes — never create, patch, publish, or release from this node.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; never persist secrets, storage grants, raw authorization headers, or tokens.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "clientProjectId",
        "clientObjectType",
        "contractSource",
        "body"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "client_object.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "clientProjectId": {
          "type": "string",
          "minLength": 1
        },
        "clientObjectType": {
          "type": "string",
          "minLength": 1
        },
        "contractSource": {
          "type": "object",
          "additionalProperties": true
        },
        "body": {
          "type": "object",
          "minProperties": 1,
          "additionalProperties": true
        },
        "clientValidation": {
          "type": "object",
          "additionalProperties": true
        },
        "artifactReferences": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "mediaPathConvention": {
          "type": "string"
        },
        "assumptions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "clientProjectId",
        "clientObjectType",
        "contractSource",
        "body"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "client_object.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "clientProjectId": {
          "type": "string",
          "minLength": 1
        },
        "clientObjectType": {
          "type": "string",
          "minLength": 1
        },
        "contractSource": {
          "type": "object",
          "additionalProperties": true
        },
        "body": {
          "type": "object",
          "minProperties": 1,
          "additionalProperties": true
        },
        "clientValidation": {
          "type": "object",
          "additionalProperties": true
        },
        "artifactReferences": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "mediaPathConvention": {
          "type": "string"
        },
        "assumptions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.save_output",
      "stage.list_outputs",
      "project.call_tool",
      "project.call_read_tool"
    ],
    "assignedSkills": [
      "contract_intelligence"
    ],
    "requiredInputs": [
      "review_aggregator",
      "draft_writer",
      "contract_intelligence",
      "narrative_movement",
      "angle_strategy",
      "artifact_plan"
    ],
    "produces": [
      "client_object.v1"
    ],
    "riskLevel": "write",
    // T8 (Wave 3, 2026-08-13, run_1786557897658_elj34j): artifact_plan added as a dependency, and moved
    // ahead of this node in the tail's canonical order (publishingTail.ts), so the media this node binds
    // already exists and is verified BEFORE this node runs. Before this change, artifact_plan ran after
    // article_body and could only plan against a body that had already shipped without media — the
    // published run this fix is named for carried no media for exactly that reason.
    "dependsOn": [
      "review_aggregator",
      "draft_writer",
      "contract_intelligence",
      "narrative_movement",
      "angle_strategy",
      "artifact_plan"
    ],
    "status": "active",
    "position": {
      "x": 1120,
      "y": 700
    },
    "updatedAt": "2026-07-31T09:36:58.473Z",
    "metadata": {
      "approvalRequired": false,
      "externalStageMapping": "final_article",
      "canonicalRules": [
        "The client's fetched contract is the only authoritative content schema",
        "body must be emitted in the client's own object shape, not a workspace shape",
        "Renderable media fields carry the client's public path; raw artifact keys only in the client's designated reference fields",
        "Workspace-local article schemas are advisory and must never be used to validate",
        "Media comes from artifact_plan's already-verified media_slots only — never re-planned, re-generated, or re-verified here, and never an unverified reference in a rendered field"
      ]
    },
    "modelConfig": {
      "maxTurns": 6,
      "toolCallLimit": 3,
      "timeout": 300000,
      "budgetUsd": 0.75,
      "maxOutputTokens": 10000
    }
  },
  {
    "id": "publish_payload",
    "name": "Publish Payload Builder",
    "kind": "adapter",
    "description": "Assemble a dry-run publish candidate in the client's own object shape, carrying verified artifact references and the client's own validation verdict. Never publish, release, or trigger builds.",
    "prompt": "Objective: Assemble a DRY-RUN publish candidate for the target client from the client-shaped body produced by article_body. Do not publish, release, patch, or trigger builds.\nSource of truth: the client's fetched contract governs the candidate's shape, its id conventions, its media path rules, and its publish gates. Carry clientProjectId, clientObjectType and contractSource through from upstream. Never validate against a workspace-local content schema and never treat a workspace verdict as sufficient evidence.\nInputs expected: article_body (the client-shaped body plus its clientValidation result) and artifact_plan (media slots with verification evidence).\nOutput required: produce dry_run_publish_payload.v1 with clientObject set to the candidate in the client's own shape, dryRun true, the verified artifactReferences set, artifactProtocol named as the client's contract names it, artifactHandling.legacyFallbacksUsed false, the client's validation verdict, validation assumptions, and explicit blockers. Suggest a requested id only when the client's id convention lets you derive one safely; otherwise leave it out and say why.\nArtifact readiness policy: media may be treated as publish-ready ONLY when there is verification evidence that each reference was materialized by the client's artifact protocol for the CURRENT request. A pattern-valid key is not proof. If artifact_plan marks any slot as needing generation or blocked, or verification evidence is absent, keep the reference as untrusted metadata and raise a blocker. Never silently upgrade unverified media to trusted media, and never substitute a remote URL, repo path, data URI, hand-authored key, or a reference belonging to another request or slug.\nMedia form policy: place each reference in the form the contract demands for its field — public serving path for rendered fields, raw artifact key only in the client's designated reference fields. Deliver a document artifact as the contract's document media type or as an action CTA, never as an image; a hero or featured image must be an image. If the contract states that raw keys break rendering, treat a raw key in a rendered field as a blocker, not a warning.\nClient validation policy: obtain a validation verdict from the CLIENT's own validator through project.call_read_tool, read-only, and record it in clientValidation {tool, valid, issues}. project.call_read_tool needs NO approval and is the correct surface for validation; do not use project.call_tool for reads, and do not report yourself blocked because project.call_tool is unavailable — that tool is deliberately approval-gated for writes only. If upstream already validated, re-confirm rather than inheriting the claim when the body changed. If the client is unreachable or its read-only validator is denied by the project's own policy, record clientValidation.attempted false and raise a blocker; do not assert validity.\nApproval/resume policy: if artifact generation or verification timed out upstream, preserve the blocker with requestId, media slot id, required capability, and the pending action. Do not replace it with a synthetic pointer.\nCompletion criteria: a publisher could create or update the client object from clientObject without guessing; every media reference is verified and correctly formed; the client's own validator has spoken; blockers are explicit.\nBlocker criteria: missing or unprovenanced contract; required contract fields unsatisfied; ids violating the client's convention; unverified, missing, or wrongly formed media; taxonomy that does not resolve where the contract blocks unknown terms; client unreachable; or any requested publishing side effect.\nTool policy: read-only client calls only, through project.call_read_tool. project.call_tool is approval-gated and reserved for writes — no publish, release, build, create, or patch calls from this node. Do not create or upload artifacts from this node.\nMemory policy: save only this node's structured dry-run output; never persist secrets, raw authorization headers, storage grants, scoped upload tokens, or blob credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "clientProjectId",
        "clientObjectType",
        "contractSource",
        "dryRun",
        "clientObject"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "dry_run_publish_payload.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "clientProjectId": {
          "type": "string",
          "minLength": 1
        },
        "clientObjectType": {
          "type": "string",
          "minLength": 1
        },
        "contractSource": {
          "type": "object",
          "additionalProperties": true
        },
        "dryRun": {
          "const": true
        },
        "clientObject": {
          "type": "object",
          "minProperties": 1,
          "additionalProperties": true
        },
        "requestId": {
          "type": "string",
          "minLength": 1
        },
        "clientValidation": {
          "type": "object",
          "additionalProperties": true
        },
        "artifactProtocol": {
          "type": "string",
          "minLength": 1
        },
        "artifactReferences": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "artifactHandling": {
          "type": "object",
          "required": [
            "legacyFallbacksUsed"
          ],
          "additionalProperties": true,
          "properties": {
            "legacyFallbacksUsed": {
              "const": false
            },
            "notes": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        },
        "validationAssumptions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "clientProjectId",
        "clientObjectType",
        "contractSource",
        "dryRun",
        "clientObject"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "dry_run_publish_payload.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "clientProjectId": {
          "type": "string",
          "minLength": 1
        },
        "clientObjectType": {
          "type": "string",
          "minLength": 1
        },
        "contractSource": {
          "type": "object",
          "additionalProperties": true
        },
        "dryRun": {
          "const": true
        },
        "clientObject": {
          "type": "object",
          "minProperties": 1,
          "additionalProperties": true
        },
        "requestId": {
          "type": "string",
          "minLength": 1
        },
        "clientValidation": {
          "type": "object",
          "additionalProperties": true
        },
        "artifactProtocol": {
          "type": "string",
          "minLength": 1
        },
        "artifactReferences": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "artifactHandling": {
          "type": "object",
          "required": [
            "legacyFallbacksUsed"
          ],
          "additionalProperties": true,
          "properties": {
            "legacyFallbacksUsed": {
              "const": false
            },
            "notes": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        },
        "validationAssumptions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "stage.get_output",
      "stage.save_output",
      "project.call_tool",
      "project.call_read_tool"
    ],
    "assignedSkills": [
      "contract_intelligence"
    ],
    "requiredInputs": [
      "article_body",
      "artifact_plan"
    ],
    "produces": [
      "dry_run_publish_payload.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "article_body",
      "artifact_plan"
    ],
    "status": "active",
    "position": {
      "x": 0,
      "y": 540
    },
    "updatedAt": "2026-07-31T09:36:58.473Z",
    "metadata": {
      "approvalRequired": false,
      "publishPayloadDeterministic": true,
      "canonicalRules": [
        "Consumes the client-shaped body from article_body",
        "Produces a dry-run candidate only, never a publish",
        "Client validation evidence is required; a workspace verdict is not sufficient",
        "Artifact references must be verified for the current request"
      ]
    },
    "modelConfig": {
      "maxTurns": 5,
      "toolCallLimit": 3,
      "timeout": 180000,
      "budgetUsd": 0.5,
      "maxOutputTokens": 10000
    }
  },
  {
    "id": "publication_controller",
    "name": "Publication Controller",
    "kind": "controller",
    "description": "Prepare an auditable publication decision record for future explicit approval; do not publish yet; validate the target project's artifact policy before any future publishing; do not call publishing tools in this workspace.",
    "prompt": "Objective: Prepare an auditable publication decision record for explicit approval. This node is a decision gate only; it must not publish, release, trigger builds, upload artifacts, or mutate external systems.\nSource of truth: the target client's fetched contract governs what a valid object, a valid artifact reference, and a valid publish action are. Read those rules from the contract carried through publish_payload rather than assuming any client's conventions. If the payload lacks contractSource provenance, treat the decision as no_go.\nInputs expected: publish_payload.\nOutput required: produce publication_decision.v1 with a go/no-go recommendation, the required approval facts, artifact readiness, blockers, and the exact next action a future publish executor would take.\nContent path policy: the only valid content is the client-shaped object the contract declares, carried as clientObject. Refuse any payload built from Markdown, legacy article bodies, prose blobs, repo files, or any representation the client's contract does not declare.\nArtifact protocol policy: the artifact protocol named by the client's contract is the only valid transfer path. Refuse legacy fallbacks: repo asset paths, remote URLs, data URIs, direct-save or import-from-URL fallbacks, references copied from another request or slug, and hand-authored keys.\nArtifact readiness policy: an artifact reference is trusted only when publish_payload or artifact_plan carries verification evidence that the artifact was materialized by the client's protocol for the SAME request id. A syntactically valid key is not enough. Confirm each reference sits in the form its target field requires — public serving path for rendered fields, raw reference only where the contract designates. If materialization was unverified, the request id was never confirmed against the client's convention, approval timed out, taxonomy is unresolved, or provenance is unclear, recommend no_go / blocked_for_publish_execution.\nClient verdict policy: require a validation verdict produced by the CLIENT's own validator, not by a workspace-local checker. A workspace verdict is not evidence. Absent or stale client validation is a blocker.\nApproval policy: require explicit approval before any publish executor may run. Approval must identify the exact object and request, the publication action, the artifact set with keys and digests, and the intended release/build behavior. Where the client's contract pins an approval to a specific action or revision, honor those pin rules — a mismatched or stale pin is a blocker, not a warning. Missing or partial approval is a blocker.\nCompletion criteria: the decision is auditable; the content path matches the client's contract; artifacts are either verified or explicitly blocked; taxonomy readiness is explicit; the client's own validator has spoken; and no publish, release, or build side effect was performed.\nBlocker criteria: missing publish_payload; missing contract provenance; content outside the client's declared shape; missing or unverified artifact references; a request id that does not satisfy the client's convention; unresolved taxonomy without explicit acceptance where the contract blocks unknown terms; disabled publish policy; unavailable publish executor; missing, stale, or mismatched approval; or any requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; never call publish, release, build, upload, import, or mutation tools.\nMemory policy: save only this node's structured decision output; never persist secrets, raw authorization headers, storage grants, scoped upload tokens, or blob credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "decision"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "publication_decision.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "decision": {
          "type": "string",
          "enum": [
            "go",
            "no_go",
            "blocked"
          ],
          "description": "The single field the engine's P0 publish gate reads. Only an exact \"go\" authorizes a publish; absence, hedging, or any other value refuses by default (see src/agent/workspace/publishDecision.ts)."
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Must be empty or omitted when decision is \"go\"; must name each open blocker otherwise."
        },
        "nextAction": {
          "type": "string",
          "description": "The exact next step a future publish executor would take."
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "if": {
        "properties": {
          "decision": {
            "const": "go"
          }
        },
        "required": [
          "decision"
        ]
      },
      "then": {
        "properties": {
          "blockers": {
            "type": "array",
            "maxItems": 0
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "decision"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "publication_decision.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "decision": {
          "type": "string",
          "enum": [
            "go",
            "no_go",
            "blocked"
          ],
          "description": "The single field the engine's P0 publish gate reads. Only an exact \"go\" authorizes a publish; absence, hedging, or any other value refuses by default (see src/agent/workspace/publishDecision.ts)."
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Must be empty or omitted when decision is \"go\"; must name each open blocker otherwise."
        },
        "nextAction": {
          "type": "string",
          "description": "The exact next step a future publish executor would take."
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "if": {
        "properties": {
          "decision": {
            "const": "go"
          }
        },
        "required": [
          "decision"
        ]
      },
      "then": {
        "properties": {
          "blockers": {
            "type": "array",
            "maxItems": 0
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.save_output",
      "stage.list_outputs",
      "project.call_tool"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "publish_payload"
    ],
    "produces": [
      "publication_decision.v1"
    ],
    "riskLevel": "publish",
    "dependsOn": [
      "publish_payload"
    ],
    "status": "active",
    "position": {
      "x": 280,
      "y": 540
    },
    "updatedAt": "2026-07-31T09:36:58.473Z",
    "metadata": {
      "approvalRequired": true,
      "projectPolicyNotes": [
        "Do not publish yet",
        "Validate the target project's artifact-reference and raw-image-URL rules before future publishing"
      ]
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 120000,
      "budgetUsd": 0.25,
      "maxOutputTokens": 3000
    }
  },
  {
    "id": "publish_executor",
    "name": "Publish Executor",
    "kind": "publisher",
    "description": "Active execution node for publishing to any client under the standing go-live authorization (2026-07-31). Follows the publish sequence, lock discipline and pin rules the client's contract declares.",
    "prompt": "Objective: Execute a publish against the target client under the standing go-live authorization (operator decision, 2026-07-31). Publishing is enabled; no separate per-publish approval ceremony is required. An explicitly withheld approval in the decision record is still honoured as a block.\nSource of truth: the client's fetched contract declares the publish sequence, the lock and version discipline, the valid publication actions, the release/build behaviours, and the error codes. Read them from contractSource carried through publication_controller. Never execute a sequence remembered from another client or hardcoded here. Missing contract provenance is a hard block.\nInputs expected: publication_controller.\nOutput required: publish_execution.v1 with the exact action taken, the client object and request id, the artifact set, the publish result, the release/build status, and the verification performed.\nContent path policy: the only valid content is the client-shaped object the contract declares. Refuse Markdown, prose blobs, repo files, or any representation the contract does not declare.\nArtifact policy: every media reference must be a verified current-request artifact under the protocol the contract names, with matching key, digest, content type, size and timestamp. A pattern-valid key is not proof. Refuse repo paths, remote URLs, data URIs, copied references, hand-authored keys, and any unverified reference that merely looks well-formed. If verification is absent, stale, partial, timed out, or belongs to another request, block.\nRendered vs raw policy: put the client's public serving path in rendered fields and the raw artifact key only in the fields the contract designates for references. Where the contract warns that a raw key in a rendered field breaks the build, treat that as a hard block, never a warning.\nAuthorization policy: the operator's standing go-live authorization covers publish execution; execute unless the publication_controller decision record explicitly withholds authorization or recommends no_go. Where the contract pins parameters to a specific action or revision, use the pinned values exactly.\nSequence policy: follow the contract's declared workflow in order, including its checkout/validate/patch/publish/checkin discipline and its lock and expected-version rules. Dry-run validate before mutating. Surface the contract's own error codes rather than reinterpreting them: a lock conflict means re-acquire, a version conflict means re-read, never force.\nPublish vs release policy: treat publishing and going live as separate gates whenever the contract separates them. Where publish commits without deploying and a distinct release performs the build, trigger the release matching the requested release behaviour (default publish_now covers both) — a release may deploy every accumulated pending publish at once, so record what went out. After any release, confirm go-live is real: a production-confirmed deploy of the target commit, then page and media verification. A queued or ready-but-undeployed build is not live.\nCompletion criteria: content and artifacts are verified; the sequence followed the contract; the release matches the requested behaviour; the result and go-live confirmation are recorded.\nBlocker criteria: missing contract provenance; an explicitly withheld authorization or no_go decision; missing artifact verification; unresolved taxonomy where the contract blocks unknown terms; lock or version conflicts; runner idempotency doubt; unavailable publish or release tools; content outside the client's declared shape; or non-protocol artifact references.\nTool policy: reach the client only through explicitly allowed publish, release and verification tools, and never bypass project policy.\nMemory policy: never expose or persist secrets, raw authorization headers, storage grants, scoped upload tokens, or blob credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "artifact",
        "summary",
        "status",
        "clientProjectId",
        "clientObjectType",
        "contractSource",
        "approvalMatched",
        "publishPolicyChecked",
        "blockers"
      ],
      "if": {
        "required": [
          "status"
        ],
        "properties": {
          "status": {
            "const": "executed"
          }
        }
      },
      "then": {
        "required": [
          "result",
          "verification"
        ],
        "properties": {
          "approvalMatched": {
            "const": true
          },
          "verification": {
            "type": "object",
            "required": [
              "deployStatus",
              "productionConfirmed"
            ],
            "properties": {
              "deployStatus": {
                "const": "ready"
              },
              "productionConfirmed": {
                "const": true
              }
            }
          }
        }
      },
      "properties": {
        "artifact": {
          "const": "publish_execution.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "enum": [
            "blocked",
            "skipped",
            "executed"
          ]
        },
        "clientProjectId": {
          "type": "string",
          "minLength": 1
        },
        "clientObjectType": {
          "type": "string",
          "minLength": 1
        },
        "contractSource": {
          "type": "object",
          "additionalProperties": true
        },
        "artifactProtocol": {
          "type": "string",
          "minLength": 1
        },
        "approvalMatched": {
          "type": "boolean",
          "description": "True only when the operator's durable publish decision for this run (run.operatorPublishDecision, set via workflow.set_operator_publish_decision) is \"approved\". The engine verifies this claim deterministically; a status of \"executed\" requires it to be true and to match that record."
        },
        "publishPolicyChecked": {
          "type": "boolean"
        },
        "approvedAction": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "clientObjectId": {
              "type": "string",
              "minLength": 1
            },
            "requestId": {
              "type": "string",
              "minLength": 1
            },
            "publicationAction": {
              "type": "string",
              "minLength": 1
            },
            "releaseBuildBehavior": {
              "type": "string",
              "minLength": 1
            },
            "artifactSet": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": true
              }
            }
          }
        },
        "clientValidation": {
          "type": "object",
          "additionalProperties": true
        },
        "result": {
          "type": "object",
          "additionalProperties": true
        },
        "verification": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "deployAware": {
              "type": "boolean"
            },
            "requiredChecks": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "goLiveConfirmed": {
              "type": "boolean"
            },
            "deployStatus": {
              "type": "string",
              "description": "Client deploy status for the target commit; \"ready\" is the only value that counts toward go-live evidence."
            },
            "productionConfirmed": {
              "type": "boolean",
              "description": "True only when the production site was confirmed to serve the target commit. Required (with deployStatus \"ready\") for status \"executed\"."
            }
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "additionalProperties": true,
      "properties": {
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        },
        "stageOutputs": {
          "type": "object"
        }
      },
      "type": "object"
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "artifact",
        "summary",
        "status",
        "clientProjectId",
        "clientObjectType",
        "contractSource",
        "approvalMatched",
        "publishPolicyChecked",
        "blockers"
      ],
      "if": {
        "required": [
          "status"
        ],
        "properties": {
          "status": {
            "const": "executed"
          }
        }
      },
      "then": {
        "required": [
          "result",
          "verification"
        ],
        "properties": {
          "approvalMatched": {
            "const": true
          },
          "verification": {
            "type": "object",
            "required": [
              "deployStatus",
              "productionConfirmed"
            ],
            "properties": {
              "deployStatus": {
                "const": "ready"
              },
              "productionConfirmed": {
                "const": true
              }
            }
          }
        }
      },
      "properties": {
        "artifact": {
          "const": "publish_execution.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "enum": [
            "blocked",
            "skipped",
            "executed"
          ]
        },
        "clientProjectId": {
          "type": "string",
          "minLength": 1
        },
        "clientObjectType": {
          "type": "string",
          "minLength": 1
        },
        "contractSource": {
          "type": "object",
          "additionalProperties": true
        },
        "artifactProtocol": {
          "type": "string",
          "minLength": 1
        },
        "approvalMatched": {
          "type": "boolean",
          "description": "True only when the operator's durable publish decision for this run (run.operatorPublishDecision, set via workflow.set_operator_publish_decision) is \"approved\". The engine verifies this claim deterministically; a status of \"executed\" requires it to be true and to match that record."
        },
        "publishPolicyChecked": {
          "type": "boolean"
        },
        "approvedAction": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "clientObjectId": {
              "type": "string",
              "minLength": 1
            },
            "requestId": {
              "type": "string",
              "minLength": 1
            },
            "publicationAction": {
              "type": "string",
              "minLength": 1
            },
            "releaseBuildBehavior": {
              "type": "string",
              "minLength": 1
            },
            "artifactSet": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": true
              }
            }
          }
        },
        "clientValidation": {
          "type": "object",
          "additionalProperties": true
        },
        "result": {
          "type": "object",
          "additionalProperties": true
        },
        "verification": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "deployAware": {
              "type": "boolean"
            },
            "requiredChecks": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "goLiveConfirmed": {
              "type": "boolean"
            },
            "deployStatus": {
              "type": "string",
              "description": "Client deploy status for the target commit; \"ready\" is the only value that counts toward go-live evidence."
            },
            "productionConfirmed": {
              "type": "boolean",
              "description": "True only when the production site was confirmed to serve the target commit. Required (with deployStatus \"ready\") for status \"executed\"."
            }
          }
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.save_output",
      "stage.list_outputs",
      "project.call_tool"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "publication_controller"
    ],
    "produces": [
      "publish_execution.v1"
    ],
    "riskLevel": "publish",
    "dependsOn": [
      "publication_controller"
    ],
    "status": "active",
    "position": {
      "x": 560,
      "y": 1600
    },
    "updatedAt": "2026-07-31T09:36:58.473Z",
    "metadata": {
      "activationRequired": false,
      "approvalRequired": false,
      "canonicalRules": [
        "The client's contract declares the publish sequence, lock discipline and approval pin rules",
        "Publish and release are separate gates",
        "Only verified current-request artifacts may be published",
        "No legacy fallback systems"
      ],
      "goLive": {
        "enabledAt": "2026-07-31",
        "authorizedBy": "Wolf (operator)",
        "note": "All ceremony barriers removed by explicit operator decision; contract/artifact correctness policies retained."
      }
    },
    "modelConfig": {
      "maxTurns": 4,
      "toolCallLimit": 3,
      "timeout": 180000,
      "budgetUsd": 0.5,
      "maxOutputTokens": 4000
    }
  },
  {
    "id": "learning_recorder",
    "name": "Learning Recorder",
    "kind": "learning",
    "description": "Record structured workflow observations, including project artifact/rendering failures, and improvement candidates without mutating prompts or schemas automatically.",
    "prompt": "Objective: Record structured workflow observations, including project artifact/rendering failures, and improvement candidates without mutating prompts or schemas automatically.\nInputs expected: publication_controller and publish_executor when the run reached them — publish_execution.v1 carries the executor/publish outcome (blocks, lock conflicts, failed releases, unconfirmed go-lives) this node exists to observe, and a publish_executor refused at its own gate still leaves an observable blocked decision record. When publish_executor never executed (refused upstream, or publishing happened outside node execution via workflow.publish_run), its input slot is simply absent — record what the run's terminal state shows instead of treating the absence as a blocker. On early termination (blocked or failed) this node fires directly with the run's terminal state.\nOutput required: produce learning_observations.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; stage.list_outputs returns bounded summaries (id, stage, size, preview) — record observations from those summaries and the run's terminal state, and do not try to read every stage in full. Do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "learning_observations.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "stageOutputs": {
          "type": "object"
        },
        "contentSource": {
          "type": "object"
        },
        "instructions": {
          "type": "string"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "artifact": {
          "const": "learning_observations.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "allowedTools": [
      "stage.list_outputs",
      "learning.record_observation"
    ],
    "assignedSkills": [],
    "requiredInputs": [
      "publication_controller",
      "publish_executor"
    ],
    "produces": [
      "learning_observations.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "publication_controller",
      "publish_executor"
    ],
    "status": "active",
    "position": {
      "x": 560,
      "y": 540
    },
    "updatedAt": "2026-07-31T09:36:58.473Z",
    "metadata": {
      "approvalRequired": false,
      "recordFailureTypes": [
        "artifact_reference_missing",
        "raw_image_artifact_public_url",
        "image_rendering_placement_missing"
      ]
    },
    "modelConfig": {
      "maxTurns": 5,
      "toolCallLimit": 4,
      "timeout": 300000,
      "budgetUsd": 0.5,
      "maxOutputTokens": 3000
    }
  }
] satisfies WorkspaceNode[];

export function listWorkspaceNodes(): WorkspaceNode[] {
  return publishingConductorNodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn], allowedTools: [...node.allowedTools], requiredInputs: [...node.requiredInputs], produces: [...node.produces], position: { ...node.position }, metadata: node.metadata ? { ...node.metadata } : undefined }));
}

const canonicalNodeById = new Map(publishingConductorNodes.map((node, index) => [node.id, { index, position: node.position }]));

type SortableWorkspaceNode = { id: string; position?: { x?: number; y?: number } | null };

// Effective grid position for ordering. Prefer the node's own position; if it is missing but the
// node is a canonical Publishing Conductor node, borrow the canonical position so stored data that
// predates positions still renders in order.
const effectivePosition = (node: SortableWorkspaceNode): { x: number; y: number } | null => {
  const own = node.position;
  if (own && Number.isFinite(own.x) && Number.isFinite(own.y)) return { x: own.x as number, y: own.y as number };
  const canonical = canonicalNodeById.get(node.id);
  return canonical ? { ...canonical.position } : null;
};

// Returns nodes in canonical conductor order without mutating the input. Ordering keys, in priority:
// canonical Publishing Conductor index, then grid position (top-to-bottom by y, then left-to-right by x)
// for nodes that have no canonical index, then original insertion order (stable). Prompt/schema edits,
// storage insertion order, updatedAt, and canvas drags never affect the result.
//
// R-22 — canonical index used to rank BELOW grid position, and the two only agreed because the canonical
// positions in this file were a tidy generated grid whose reading order happened to match the dependency
// order. Re-seeding from the live workspace imported the real canvas, where they do not agree at all:
// input_triage has been dragged to {x:-391, y:148}, below and left of the top row, so a position-first sort
// listed topic_opportunity — which DEPENDS on input_triage — ahead of it. Position is canvas cosmetics;
// the conductor's order is its dependency order, and dragging a box must not be able to rewrite it.
export function sortWorkspaceNodes<T extends SortableWorkspaceNode>(nodes: T[]): T[] {
  return nodes
    .map((node, index) => ({ node, index, position: effectivePosition(node), canonical: canonicalNodeById.get(node.id)?.index }))
    .sort((a, b) => {
      if (a.canonical !== undefined && b.canonical !== undefined) {
        if (a.canonical !== b.canonical) return a.canonical - b.canonical;
      } else if (a.canonical !== undefined || b.canonical !== undefined) {
        // A conductor node always precedes an authored one; the conductor is the spine of the graph.
        return a.canonical !== undefined ? -1 : 1;
      } else if (a.position && b.position) {
        // Authored nodes have no canonical index, so their layout is the only order available.
        if (a.position.y !== b.position.y) return a.position.y - b.position.y;
        if (a.position.x !== b.position.x) return a.position.x - b.position.x;
      } else if (a.position || b.position) {
        return a.position ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.node);
}

export function getWorkspaceNode(id: string): WorkspaceNode | undefined {
  return listWorkspaceNodes().find((node) => node.id === id);
}

// `sequenceNodes` is the node list a conductor RUN would actually execute for the workflow being
// validated. It defaults to the canonical Publishing Conductor sequence — the only workflow today —
// so every existing caller is unchanged. composeWorkflowNodes (§2.23, publishingTail.ts) passes the
// composed array itself, so a future second workflow is validated against its own sequence instead of
// being falsely flagged for depending on nodes the conductor sequence does not contain.
export function validateWorkspaceGraph(nodes: WorkspaceNode[] = publishingConductorNodes, sequenceNodes: WorkspaceNode[] = listWorkspaceNodes()): WorkspaceGraphValidation {
  const issues: string[] = [];
  const validRiskLevels = new Set(["read", "write", "publish", "admin"]);
  const validStatuses = new Set(["draft", "active", "deprecated"]);
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) issues.push(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (!validRiskLevels.has(node.riskLevel)) issues.push(`Invalid riskLevel for ${node.id}: ${node.riskLevel}`);
    if (!validStatuses.has(node.status)) issues.push(`Invalid status for ${node.id}: ${node.status}`);
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) issues.push(`Missing dependency for ${node.id}: ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id: string, path: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) { issues.push(`Cycle detected: ${[...path, id].join(" -> ")}`); return; }
    visiting.add(id);
    const node = byId.get(id);
    node?.dependsOn.forEach((dependency) => { if (byId.has(dependency)) visit(dependency, [...path, id]); });
    visiting.delete(id);
    visited.add(id);
  };
  nodes.forEach((node) => visit(node.id, []));
  // R-21 (T-2 F-7): a declared dependency that is not in the CONDUCTOR SEQUENCE can never be
  // satisfied in a run. resolveConductorNodes maps over the canonical Publishing Conductor list, so a
  // node absent from that list is silently ignored at execution time even if it exists in the
  // validated (store) graph — exactly how article_body could declare contract_intelligence in both
  // dependsOn and requiredInputs while the sequence omitted it and validation still said "valid".
  // Checked here, per sequence node: every dependsOn entry must itself be in the sequence, and every
  // requiredInputs artifact type must be produced by some sequence node. Authored (non-conductor)
  // nodes are exempt — they are not run by the conductor, so the sequence cannot starve them.
  const sequenceIds = new Set(sequenceNodes.map((sequenceNode) => sequenceNode.id));
  const sequenceProduces = new Set(sequenceNodes.flatMap((sequenceNode) => sequenceNode.produces));
  for (const node of nodes) {
    if (!sequenceIds.has(node.id)) continue;
    for (const dependency of node.dependsOn) {
      if (!sequenceIds.has(dependency)) issues.push(`Dependency not in conductor sequence for ${node.id}: ${dependency} — a conductor run never executes it, so ${node.id} can never become runnable`);
    }
    // A requiredInputs entry names either an upstream NODE ID or a produced ARTIFACT TYPE (the
    // canonical set uses both conventions); satisfiable means some sequence node has that id or
    // produces that artifact.
    for (const requiredInput of node.requiredInputs ?? []) {
      if (!sequenceIds.has(requiredInput) && !sequenceProduces.has(requiredInput)) issues.push(`Required input not satisfiable by the conductor sequence for ${node.id}: ${requiredInput} — no sequence node has this id or produces this artifact`);
    }
  }
  const articleBody = nodes.find((node) => node.id === "article_body");
  if (!articleBody) issues.push("Missing article_body node");
  if (articleBody && !articleBody.produces.includes("client_object.v1")) issues.push("article_body must produce client_object.v1");
  const publishPayload = nodes.find((node) => node.id === "publish_payload");
  if (publishPayload && !publishPayload.dependsOn.includes("article_body")) issues.push("publish_payload must depend on article_body");
  const publicationController = nodes.find((node) => node.id === "publication_controller");
  if (publicationController && !publicationController.dependsOn.includes("publish_payload")) issues.push("publication_controller must depend on publish_payload");
  return issues.length ? { valid: false, issues } : { valid: true, issues: [] };
}
