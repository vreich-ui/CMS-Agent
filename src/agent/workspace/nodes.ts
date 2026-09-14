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
    "prompt": "Objective: Clarify the publishing request, identify missing inputs, and establish the working content_source.v1 envelope.\nInputs expected: user request and any supplied content_source.v1 envelope; the run envelope may also declare trafficSource and awarenessStage.\nOutput required: produce content_source.v1 with concise rationale, assumptions, and unresolved questions, plus two required fields that placement_resolver depends on downstream: trafficSource and awarenessStage. Determine trafficSource and awarenessStage from the run envelope (its trafficSource/awarenessStage fields) when present; when absent, infer them from the source content and request context and state the basis for the inference in your rationale or notes. Never omit trafficSource or awarenessStage from the output — placement_resolver blocks the run outright if either is missing.\nCompletion criteria: required inputs are addressed, output matches the node schemas (including trafficSource and awarenessStage), dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, a requested side effect outside this node's policy, or an inability to determine trafficSource or awarenessStage from either the envelope or the source content.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "trafficSource",
        "awarenessStage"
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
        "trafficSource": {
          "type": "string",
          "minLength": 1
        },
        "awarenessStage": {
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
        },
        "trafficSource": {
          "type": "string",
          "minLength": 1
        },
        "awarenessStage": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "trafficSource",
        "awarenessStage"
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
        "trafficSource": {
          "type": "string",
          "minLength": 1
        },
        "awarenessStage": {
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
    "updatedAt": "2026-08-11T16:58:47.266Z",
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
    "updatedAt": "2026-09-14T10:11:51.590Z",
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
    "prompt": "Objective: Decide whether the request should become an article, page section, content update, product/resource support asset, or no-build recommendation for the target client.\nInputs expected: input_triage, placement_resolver (the resolved aggression target for this placement), plus clientProjectId (the run's registered client) delivered in this node's input.\nOutput required: produce topic_opportunity.v1 with recommended content route, reader value, business value, SEO/search intent notes when relevant, evidence depth needed, and cost path.\nAggression policy: placement_resolver names the target claim_strength/urgency/emotional_agitation/cta_density for this placement, computed from traffic source and awareness stage. Route recommendations should be consistent with that target — do not recommend a route that would require exceeding it.\nCost policy: choose the smallest workflow that can satisfy the request safely. Recommend deep research only for current, comparative, regulatory, source-sensitive, or claim-heavy work; a client whose domain needs a stricter evidence bar (health, finance, legal) declares it in its own record. Recommend skipping redundant strategy passes when the request is simple.\nNext-step policy: prefer content that moves a reader toward a useful next step: related reading, newsletter, routine decision, product/resource consideration, or trust-building.\nClient policy: this node serves any registered client. clientProjectId names the target; the client's voice, audience, and commercial direction come from the client's own record and the run's inputs, never from this prompt. Treat a missing or unresolvable client identity as a blocker rather than assuming a client.\nCompletion criteria: the route, audience value, evidence need, and blockers are explicit.\nBlocker criteria: unclear target, missing or unresolvable target client, unsafe request, no viable reader value, missing critical input, or requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.\n\nRouting responsibility (2026-09-09): route and no-build recommendations from this node are advisory inputs to the brief. This node does not change the conductor graph or stop a run. State the recommended route and rationale without claiming it was executed, and honor an explicit operator-requested build. Missing client identity or unsafe unsupported claims must still be reported explicitly for the responsible downstream checks.",
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
    "updatedAt": "2026-09-14T10:09:57.998Z",
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
    "prompt": "Objective: Decide what this piece is monetizing before the brief exists: select one offer from the monetizer project's live data, or decide explicitly that no offer fits, and say why.\nInputs expected: topic_opportunity (the recommended route and audience/business value), plus clientProjectId (the run's registered client) delivered in this node's input.\nOffer policy: reach the monetizer project read-only through project.call_read_tool to list and inspect candidate offers. Prefer offers matching the topic's commercial intent and the client's audience; an unmatched topic gets selectedOffer null with the gap named in offerRationale rather than a forced fit. Never invent an offer, a payout, or a merchant that the monetizer's own data does not carry.\nEV floor policy (cluster level): commercialIntent alone is not a pass/fail gate — every piece must clear an explicit expected-value floor, reported in evFloor. Compute expectedValue = expectedCommission x assumedConversionRate x expectedMonthlyTraffic. The floor passes at this article's own level (floorPassed=true) when expectedValue clears estimatedRunCost plus margin (margin.kind=multiplier applied to estimatedRunCost, or margin.kind=absolute added to it — state which and why). Evaluate the floor at CLUSTER level, not only per-article:\n- Clears on its own: clusterRole=\"money_page\", floorPassed=true, supportingFor=null, verdict=\"pass\".\n- Does not clear on its own but is a declared supporting asset of a money-page article that itself clears the floor: clusterRole=\"supporting_asset\", supportingFor=<that money page's id>, floorPassed=false, verdict=\"pass_via_cluster\" — name the money page and its own passing math in rationale. Do not claim pass_via_cluster without a real, checkable supportingFor id.\n- Does not clear on its own and has no such declared relationship: clusterRole=\"unattached\", verdict=\"block\" — say so plainly in offerRationale/commercialIntent; do not force an offer or a favorable intent label to dodge the floor.\nRun-cost policy: NEVER author estimatedRunCost. This node's input carries runCostEstimate — the MEASURED p50 of this workflow's prior run totals, derived by the conductor from the node timing ledger before your turn started, with this run's own partial spend excluded. Copy runCostEstimate.estimatedRunCostUsd into evFloor.estimatedRunCost verbatim, and set evFloor.estimatedRunCostBasis to runCostEstimate.basis. Do not round it, adjust it, add a distribution allowance to it, or substitute a safer-looking number for it. When basis is \"no_history\" the figure is 0 and the floor is therefore 0 — that is correct and deliberate, an unmeasured floor blocks nothing; say so in rationale rather than inventing a figure to fill the gap. If runCostEstimate is missing from your input entirely, set estimatedRunCost to 0, estimatedRunCostBasis to \"no_history\", and name the missing prefetch in rationale — a zero you can explain is worth more than a number you made up. A run that authored estimatedRunCost 800 against a measured $3.86, then demanded $1,000 of expected value before any article could clear the floor, is why this policy exists.\nTraffic policy: NEVER author expectedMonthlyTraffic or assumedConversionRate. This node's input carries trafficEstimate — this property's MEASURED sessions and purchase rate over the last 90 days, aggregated by the conductor from the tracking sink's engagement rows. Copy trafficEstimate.expectedMonthlyTraffic into evFloor.expectedMonthlyTraffic verbatim, and set evFloor.volumeBasis from trafficEstimate.basis (\"tracking_engagement\" stays as it is; \"insufficient_data\" becomes \"stated_assumption\"). For assumedConversionRate: use trafficEstimate.observedConversionRate when it is non-null; when it is null you may state an assumption, but say so in rationale and never label the estimate monetizer_data on it. A null observedConversionRate is NOT a measured zero. When basis is \"insufficient_data\" the traffic figure is 0 and the floor's expected value is 0 — say so in rationale; that is an unmeasured property, not a worthless one, and it blocks nothing. If trafficEstimate is missing from your input entirely, set expectedMonthlyTraffic to 0, volumeBasis to \"stated_assumption\", and name the missing prefetch in rationale. The defective run asserted 400 monthly visits with nothing whatsoever behind the number.\nEstimate discipline: every number in evFloor must name its basis via estimateBasis. Use \"monetizer_data\" only when EVERY figure came from live data this run — the cost side from runCostEstimate with basis \"workflow_history\", the revenue side pulled from a live monetizer query via project.call_read_tool, AND the volume side from trafficEstimate with basis \"tracking_engagement\"; otherwise use \"stated_assumption\" (or \"mixed\" when combining) and spell out the assumption and its source in rationale. Never fabricate false precision — a made-up conversion rate to three decimal places is worse than a round, labeled guess. estimateBasis is load-bearing, not documentation: a verdict of \"block\" carrying estimateBasis \"monetizer_data\" HALTS THE RUN at brief_architect, before the brief and everything after it is bought, while the same block on \"stated_assumption\" or \"mixed\" is advisory and the run proceeds. So claiming a live basis you do not have takes a real article offline; under-claiming only costs a few dollars. A live payout multiplied by an invented traffic figure is NOT monetizer_data — it is \"mixed\", and the run proceeds. While the monetizer project MCP connection is down or unreachable, treat all revenue-side evFloor inputs as estimates and label them as such throughout (estimateBasis, rationale, and notes) rather than presenting them as measured data — \"mixed\" is the honest label when the cost side is measured and the revenue side is not. Fail fast on a dead connection: if the monetizer connection is unconfigured/unreachable, or the FIRST project.call_read_tool attempt against it fails with a validation, permission, or not-permitted error, do not retry and do not try alternate monetizer operations — proceed immediately to emitting the full output with stated assumptions, estimateBasis=\"stated_assumption\" or \"mixed\", and the failed connection named plainly in rationale. Burning the tool budget probing a dead connection and emitting nothing is a worse failure than a clearly labeled estimate.\nOutput required: produce monetization_strategy.v1 with selectedOffer (the chosen offer's identifying fields as the monetizer returns them, or null), offerRationale (why this offer, or why none), commercialIntent (the piece's commercial posture, e.g. transactional, commercial, supporting, none), and evFloor (the structured EV assessment defined above — always populated, even for a null selectedOffer or a block verdict).\nCompletion criteria: the brief architect can aim the brief at a named offer or a named no-offer decision without re-doing this selection; assumptions and blockers are explicit; the EV floor verdict is defensible from the numbers and basis given, and every figure in it is either copied from a named source or labeled an assumption.\nBlocker criteria: missing topic_opportunity, missing or unresolvable target client, or the monetizer project being unreachable when an offer decision materially depends on live offer data — record the outage rather than guessing.\nTool policy: use only allowedTools; reads go through project.call_read_tool, which needs no approval; project.call_tool is approval-gated and reserved for writes, which this node never performs — do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "selectedOffer",
        "offerRationale",
        "commercialIntent",
        "evFloor"
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
          "additionalProperties": true
        },
        "offerRationale": {
          "type": "string",
          "minLength": 1
        },
        "commercialIntent": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "evFloor": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "expectedCommission",
            "currency",
            "assumedConversionRate",
            "expectedMonthlyTraffic",
            "estimatedRunCost",
            "margin",
            "expectedValue",
            "floorPassed",
            "clusterRole",
            "supportingFor",
            "verdict",
            "rationale",
            "estimateBasis"
          ],
          "properties": {
            "expectedCommission": {
              "type": "number",
              "minimum": 0,
              "description": "Expected commission per conversion for the selected offer, in `currency`. The EV commission input."
            },
            "currency": {
              "type": "string",
              "minLength": 1,
              "description": "ISO currency code applying to expectedCommission, estimatedRunCost, margin.value, and expectedValue."
            },
            "assumedConversionRate": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "description": "Conversion rate (visit -> paid conversion) as a 0-1 fraction. Use trafficEstimate.observedConversionRate when it is non-null; when it is null this is a STATED ASSUMPTION and volumeBasis/estimateBasis must say so."
            },
            "expectedMonthlyTraffic": {
              "type": "number",
              "minimum": 0,
              "description": "Expected monthly traffic to this article/offer. COPIED VERBATIM from this node's input trafficEstimate.expectedMonthlyTraffic — the property's measured sessions over the last 90 days, normalized to 30 — never authored here. The defective run asserted 400 with nothing behind it."
            },
            "estimatedRunCost": {
              "type": "number",
              "minimum": 0,
              "description": "Run cost this piece's EV must clear. COPIED VERBATIM from this node's input runCostEstimate.estimatedRunCostUsd — the measured p50 of this workflow's prior run totals — never authored, rounded or adjusted here. 0 is a legitimate value when there is no history: an unmeasured floor blocks nothing. A run that authored 800 against a measured $3.86 is why this field is no longer the node's to invent."
            },
            "estimatedRunCostBasis": {
              "type": "string",
              "enum": [
                "workflow_history",
                "no_history",
                "accrued_run_cost",
                "model_authored"
              ],
              "description": "Where estimatedRunCost came from. Copy runCostEstimate.basis (workflow_history | no_history). accrued_run_cost is the monetize.ev_floor fallback. model_authored must never be emitted — it exists only so an audit can name the defect if it ever recurs. Distinct from estimateBasis, which describes the estimate as a WHOLE."
            },
            "volumeBasis": {
              "type": "string",
              "enum": [
                "tracking_engagement",
                "stated_assumption"
              ],
              "description": "Where expectedMonthlyTraffic came from. Copy trafficEstimate.basis, mapping insufficient_data -> stated_assumption. Its own axis because a payout and a traffic figure come from two different systems: estimateBasis can only reach monetizer_data when BOTH are measured, so a live payout multiplied by an invented traffic figure can never halt a run."
            },
            "margin": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "kind",
                "value"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "multiplier",
                    "absolute"
                  ]
                },
                "value": {
                  "type": "number"
                }
              },
              "description": "Required margin above run cost: kind=multiplier applies value as a multiplier on estimatedRunCost; kind=absolute adds value (in currency) to estimatedRunCost."
            },
            "expectedValue": {
              "type": "number",
              "description": "Computed EV = expectedCommission * assumedConversionRate * expectedMonthlyTraffic, at this article's own level."
            },
            "floorPassed": {
              "type": "boolean",
              "description": "True when this article's own expectedValue clears estimatedRunCost plus margin. False does not by itself mean block -- see clusterRole/verdict."
            },
            "clusterRole": {
              "type": "string",
              "enum": [
                "money_page",
                "supporting_asset",
                "unattached"
              ],
              "description": "money_page: this article's own EV clears the floor. supporting_asset: sub-floor but declared as supporting a money page that clears the floor. unattached: sub-floor with no such declared relationship."
            },
            "supportingFor": {
              "type": [
                "string",
                "null"
              ],
              "description": "The money-page/cluster id this article supports. Required non-null when clusterRole=supporting_asset; must be null for money_page and unattached."
            },
            "verdict": {
              "type": "string",
              "enum": [
                "pass",
                "pass_via_cluster",
                "block"
              ],
              "description": "pass: floorPassed true (money_page). pass_via_cluster: sub-floor but a valid supporting_asset of a passing money page. block: sub-floor and unattached. LOAD-BEARING: verdict=block together with estimateBasis=monetizer_data halts the run at brief_architect (the ev_floor_blocked predicate); on any other estimateBasis a block is advisory and the run proceeds."
            },
            "rationale": {
              "type": "string",
              "minLength": 1,
              "description": "Explains the verdict: the arithmetic, the money page named when pass_via_cluster, or why nothing was found when block. When estimatedRunCostBasis is no_history or volumeBasis is stated_assumption, say so here — a $0 or assumed floor is a stated fact, not a silent one."
            },
            "estimateBasis": {
              "type": "string",
              "enum": [
                "monetizer_data",
                "stated_assumption",
                "mixed"
              ],
              "description": "The basis of the estimate AS A WHOLE. monetizer_data ONLY when every figure came from live data this run: the cost side from runCostEstimate with basis workflow_history, the revenue side from a live monetizer query via project.call_read_tool, AND the volume side from trafficEstimate with basis tracking_engagement. stated_assumption when they are named assumptions; mixed when combined. This label decides whether a block stops the run — claiming monetizer_data on an invented traffic figure takes a real article offline. Never fabricate false precision."
            }
          },
          "if": {
            "properties": {
              "clusterRole": {
                "const": "supporting_asset"
              }
            }
          },
          "then": {
            "properties": {
              "supportingFor": {
                "type": "string",
                "minLength": 1
              }
            }
          },
          "else": {
            "properties": {
              "supportingFor": {
                "type": "null"
              }
            }
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
        },
        "runCostEstimate": {
          "type": "object",
          "additionalProperties": true,
          "description": "run_cost_estimate.v1, prefetched by the conductor (costPrefetch.ts) before this node's agent loop starts: the MEASURED p50 of this workflow's prior run totals, summed from the node timing ledger's recorded costUsd, with this run's own partial spend excluded. This IS the run-cost figure — the node never authors one.",
          "properties": {
            "artifact": {
              "const": "run_cost_estimate.v1"
            },
            "estimatedRunCostUsd": {
              "type": "number",
              "minimum": 0,
              "description": "Copy verbatim into evFloor.estimatedRunCost. 0 when basis is no_history, which is correct: an unmeasured floor blocks nothing."
            },
            "basis": {
              "type": "string",
              "enum": [
                "workflow_history",
                "no_history"
              ],
              "description": "workflow_history when derived from two or more prior runs; no_history otherwise. Copy into evFloor.estimatedRunCostBasis."
            },
            "sampleRuns": {
              "type": "number",
              "minimum": 0
            },
            "sampleRecords": {
              "type": "number",
              "minimum": 0
            },
            "observedRunCostsUsd": {
              "type": "array",
              "items": {
                "type": "number"
              }
            },
            "rationale": {
              "type": "string"
            }
          }
        },
        "trafficEstimate": {
          "type": "object",
          "additionalProperties": true,
          "description": "traffic_estimate.v1, prefetched by the conductor (trafficPrefetch.ts) before this node's agent loop starts: this property's MEASURED sessions and purchase rate over the last 90 days, aggregated from the tracking sink's engagement rows the scheduled ingest job already wrote to the feedback ledger. These ARE expectedMonthlyTraffic and assumedConversionRate — the node never authors either.",
          "properties": {
            "artifact": {
              "const": "traffic_estimate.v1"
            },
            "expectedMonthlyTraffic": {
              "type": "number",
              "minimum": 0,
              "description": "Measured sessions normalized to 30 days. Copy verbatim into evFloor.expectedMonthlyTraffic. 0 when basis is insufficient_data."
            },
            "observedConversionRate": {
              "type": [
                "number",
                "null"
              ],
              "description": "Measured session-weighted purchase rate, or NULL when no record reported one. Null is not zero: an unmeasured rate is a stated assumption, never a measured 0."
            },
            "basis": {
              "type": "string",
              "enum": [
                "tracking_engagement",
                "insufficient_data"
              ],
              "description": "tracking_engagement when at least 50 sessions were measured in the window; insufficient_data otherwise. Copy into evFloor.volumeBasis, mapping insufficient_data -> stated_assumption."
            },
            "windowDays": {
              "type": "number"
            },
            "sessions": {
              "type": "number"
            },
            "pageviews": {
              "type": [
                "number",
                "null"
              ]
            },
            "sampleRecords": {
              "type": "number"
            },
            "rationale": {
              "type": "string"
            }
          }
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
        "commercialIntent",
        "evFloor"
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
          "additionalProperties": true
        },
        "offerRationale": {
          "type": "string",
          "minLength": 1
        },
        "commercialIntent": {
          "type": "string",
          "minLength": 1
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "evFloor": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "expectedCommission",
            "currency",
            "assumedConversionRate",
            "expectedMonthlyTraffic",
            "estimatedRunCost",
            "margin",
            "expectedValue",
            "floorPassed",
            "clusterRole",
            "supportingFor",
            "verdict",
            "rationale",
            "estimateBasis"
          ],
          "properties": {
            "expectedCommission": {
              "type": "number",
              "minimum": 0,
              "description": "Expected commission per conversion for the selected offer, in `currency`. The EV commission input."
            },
            "currency": {
              "type": "string",
              "minLength": 1,
              "description": "ISO currency code applying to expectedCommission, estimatedRunCost, margin.value, and expectedValue."
            },
            "assumedConversionRate": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "description": "Conversion rate (visit -> paid conversion) as a 0-1 fraction. Use trafficEstimate.observedConversionRate when it is non-null; when it is null this is a STATED ASSUMPTION and volumeBasis/estimateBasis must say so."
            },
            "expectedMonthlyTraffic": {
              "type": "number",
              "minimum": 0,
              "description": "Expected monthly traffic to this article/offer. COPIED VERBATIM from this node's input trafficEstimate.expectedMonthlyTraffic — the property's measured sessions over the last 90 days, normalized to 30 — never authored here. The defective run asserted 400 with nothing behind it."
            },
            "estimatedRunCost": {
              "type": "number",
              "minimum": 0,
              "description": "Run cost this piece's EV must clear. COPIED VERBATIM from this node's input runCostEstimate.estimatedRunCostUsd — the measured p50 of this workflow's prior run totals — never authored, rounded or adjusted here. 0 is a legitimate value when there is no history: an unmeasured floor blocks nothing. A run that authored 800 against a measured $3.86 is why this field is no longer the node's to invent."
            },
            "estimatedRunCostBasis": {
              "type": "string",
              "enum": [
                "workflow_history",
                "no_history",
                "accrued_run_cost",
                "model_authored"
              ],
              "description": "Where estimatedRunCost came from. Copy runCostEstimate.basis (workflow_history | no_history). accrued_run_cost is the monetize.ev_floor fallback. model_authored must never be emitted — it exists only so an audit can name the defect if it ever recurs. Distinct from estimateBasis, which describes the estimate as a WHOLE."
            },
            "volumeBasis": {
              "type": "string",
              "enum": [
                "tracking_engagement",
                "stated_assumption"
              ],
              "description": "Where expectedMonthlyTraffic came from. Copy trafficEstimate.basis, mapping insufficient_data -> stated_assumption. Its own axis because a payout and a traffic figure come from two different systems: estimateBasis can only reach monetizer_data when BOTH are measured, so a live payout multiplied by an invented traffic figure can never halt a run."
            },
            "margin": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "kind",
                "value"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "multiplier",
                    "absolute"
                  ]
                },
                "value": {
                  "type": "number"
                }
              },
              "description": "Required margin above run cost: kind=multiplier applies value as a multiplier on estimatedRunCost; kind=absolute adds value (in currency) to estimatedRunCost."
            },
            "expectedValue": {
              "type": "number",
              "description": "Computed EV = expectedCommission * assumedConversionRate * expectedMonthlyTraffic, at this article's own level."
            },
            "floorPassed": {
              "type": "boolean",
              "description": "True when this article's own expectedValue clears estimatedRunCost plus margin. False does not by itself mean block -- see clusterRole/verdict."
            },
            "clusterRole": {
              "type": "string",
              "enum": [
                "money_page",
                "supporting_asset",
                "unattached"
              ],
              "description": "money_page: this article's own EV clears the floor. supporting_asset: sub-floor but declared as supporting a money page that clears the floor. unattached: sub-floor with no such declared relationship."
            },
            "supportingFor": {
              "type": [
                "string",
                "null"
              ],
              "description": "The money-page/cluster id this article supports. Required non-null when clusterRole=supporting_asset; must be null for money_page and unattached."
            },
            "verdict": {
              "type": "string",
              "enum": [
                "pass",
                "pass_via_cluster",
                "block"
              ],
              "description": "pass: floorPassed true (money_page). pass_via_cluster: sub-floor but a valid supporting_asset of a passing money page. block: sub-floor and unattached. LOAD-BEARING: verdict=block together with estimateBasis=monetizer_data halts the run at brief_architect (the ev_floor_blocked predicate); on any other estimateBasis a block is advisory and the run proceeds."
            },
            "rationale": {
              "type": "string",
              "minLength": 1,
              "description": "Explains the verdict: the arithmetic, the money page named when pass_via_cluster, or why nothing was found when block. When estimatedRunCostBasis is no_history or volumeBasis is stated_assumption, say so here — a $0 or assumed floor is a stated fact, not a silent one."
            },
            "estimateBasis": {
              "type": "string",
              "enum": [
                "monetizer_data",
                "stated_assumption",
                "mixed"
              ],
              "description": "The basis of the estimate AS A WHOLE. monetizer_data ONLY when every figure came from live data this run: the cost side from runCostEstimate with basis workflow_history, the revenue side from a live monetizer query via project.call_read_tool, AND the volume side from trafficEstimate with basis tracking_engagement. stated_assumption when they are named assumptions; mixed when combined. This label decides whether a block stops the run — claiming monetizer_data on an invented traffic figure takes a real article offline. Never fabricate false precision."
            }
          },
          "if": {
            "properties": {
              "clusterRole": {
                "const": "supporting_asset"
              }
            }
          },
          "then": {
            "properties": {
              "supportingFor": {
                "type": "string",
                "minLength": 1
              }
            }
          },
          "else": {
            "properties": {
              "supportingFor": {
                "type": "null"
              }
            }
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
    "updatedAt": "2026-09-14T10:09:36.382Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 8,
      "toolCallLimit": 3,
      "timeout": 120000,
      "budgetUsd": 0.3,
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
      "topic_opportunity",
      "monetization_strategy"
    ],
    "produces": [
      "reader_insight.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "topic_opportunity",
      "monetization_strategy"
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
    "prompt": "Objective: Gather only the evidence needed to support the article's material claims, reader decisions, and the trust standard the target client's content must meet.\nInputs expected: reader_insight, plus clientProjectId (the run's registered client) delivered in this node's input.\nOutput required: produce research_brief.v1 with sourced facts, practical implications, claim risk notes, open questions, and source references.\nCost policy: do not browse by default. Use web.search/web.fetch only for claims that are current, comparative, regulatory, or otherwise source-sensitive; a client whose domain needs a stricter evidence bar declares it in its own record. Prefer primary, authoritative, or source-owner pages when available. Stop once reliable evidence covers the decision the article must help the reader make. Extract what you need from each fetched page as soon as you read it — quote the finding with its source — instead of re-fetching or carrying whole pages forward; every retained page is re-sent on each of your subsequent turns.\nEvidence policy: separate sourced facts, interpretation, uncertainty, and unsupported claims. Flag claims that should be softened or removed.\nCompletion criteria: required inputs are addressed, sources are concise and relevant, output matches schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unavailable evidence for important claims, unsupported certainty on high-stakes claims, contradictory instructions, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.\n\nDTC handoff contract (2026-09-09):\nAlways emit blockers and advisories as arrays, including [] when empty. Put every unresolved blocker in the top-level blockers array as a non-empty string; a refusal written only in summary, notes, or an unrecognized status field does not reach the publication controller. Keep editorial preferences in advisories. Missing evidence is not permission to invent it. Emit one JSON object in this node's schema; keep existing useful fields and keep all strategy/evidence annotations out of reader-visible copy.\nReturn evidenceStatus, sources, and findings. Sources carry sourceId, reference (the actual URL or a specific supplied document/input reference), sourceType, and relevance. Findings carry stable claimId, claim, status supported/unverified, sourceIds referencing those sources, and limitations. Never invent a citation or claim that an unread page was checked. Use supported only when the material claims have evidence; partial when useful evidence exists with named gaps; unavailable when required evidence cannot be obtained, with a blocker; not_needed only when no material external claim needs checking, explained in notes. A supplied statement is attributed to its supplier, not promoted to independently verified evidence. Consumers must be able to distinguish sourced findings from assumptions without parsing prose notes.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "blockers",
        "advisories",
        "evidenceStatus",
        "sources",
        "findings"
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
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "advisories": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "evidenceStatus": {
          "enum": [
            "supported",
            "partial",
            "unavailable",
            "not_needed"
          ]
        },
        "sources": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sourceId": {
                "type": "string",
                "minLength": 1
              },
              "reference": {
                "type": "string",
                "minLength": 1
              },
              "sourceType": {
                "enum": [
                  "primary",
                  "secondary",
                  "supplied"
                ]
              },
              "relevance": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "sourceId",
              "reference",
              "sourceType",
              "relevance"
            ],
            "additionalProperties": true
          }
        },
        "findings": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "claimId": {
                "type": "string",
                "minLength": 1
              },
              "claim": {
                "type": "string",
                "minLength": 1
              },
              "status": {
                "enum": [
                  "supported",
                  "unverified"
                ]
              },
              "sourceIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "limitations": {
                "type": "string"
              }
            },
            "required": [
              "claimId",
              "claim",
              "status",
              "sourceIds",
              "limitations"
            ],
            "additionalProperties": true
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
        "blockers",
        "advisories",
        "evidenceStatus",
        "sources",
        "findings"
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
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "advisories": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "evidenceStatus": {
          "enum": [
            "supported",
            "partial",
            "unavailable",
            "not_needed"
          ]
        },
        "sources": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sourceId": {
                "type": "string",
                "minLength": 1
              },
              "reference": {
                "type": "string",
                "minLength": 1
              },
              "sourceType": {
                "enum": [
                  "primary",
                  "secondary",
                  "supplied"
                ]
              },
              "relevance": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "sourceId",
              "reference",
              "sourceType",
              "relevance"
            ],
            "additionalProperties": true
          }
        },
        "findings": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "claimId": {
                "type": "string",
                "minLength": 1
              },
              "claim": {
                "type": "string",
                "minLength": 1
              },
              "status": {
                "enum": [
                  "supported",
                  "unverified"
                ]
              },
              "sourceIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "limitations": {
                "type": "string"
              }
            },
            "required": [
              "claimId",
              "claim",
              "status",
              "sourceIds",
              "limitations"
            ],
            "additionalProperties": true
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
    "updatedAt": "2026-09-14T10:10:04.203Z",
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
    "prompt": "Objective: Design the reader journey as a direct-response sequence — the path from the reader's present state to the one action this piece exists to produce.\nInputs expected: objection_mapping (the objections this reader actually holds), plus whatever upstream context is delivered in this node's input — topic, audience, the selected offer or the explicit no-offer decision, and the run's resolved aggression vector when present.\nMovement policy: this is a Magnetic Marketing property, so design the arc as an explicit ordered sequence and name every beat, with the section or sections that carry it: (1) ENTRY — the reader's own present problem in the reader's own language, recognised before anything is claimed; (2) AGITATION — the real, concrete cost of leaving it alone, at the level the resolved emotional_agitation dial allows and never above it; (3) MECHANISM — the specific reason the problem persists and why the usual answers miss it, which is what earns the right to be believed; (4) PROOF — the evidence, demonstration, comparison or case that makes the mechanism credible; (5) RESOLUTION — what concretely changes once the mechanism is applied; (6) THE ASK — the single next step, placed where the reader is most persuaded rather than wherever the article happens to end. A beat may span sections and a section may carry two beats, but no beat may be absent without you naming why in assumptions.\nTransition policy: every transition exists to answer the objection the previous beat just raised. Take those objections from objection_mapping rather than inventing them, and say for each transition which objection it retires. A transition that merely moves the topic along is a gap, not a bridge.\nStakes policy: the stakes are the reader's, never the brand's. State what this reader loses by doing nothing, in terms they would recognise from their own week. Never manufacture a stake the evidence does not support, and never dress a generic risk as a personal one.\nAggression policy: when the input carries a resolved aggression vector, it bounds the arc's intensity — emotional_agitation caps how hard the agitation beat may press, urgency caps how much time pressure the resolution and ask may carry, cta_density shapes whether the ask appears once at the end or recurs. Treat the dials as ceilings, never as quotas: never manufacture pressure to reach a number. When no resolved vector is delivered, design the arc at a conservative intensity and record that as an assumption.\nTrust-first policy: aggression scales with funnel stage. A cold, unaware reader is owed the mechanism and the proof before anything is asked of them; a warm, product-aware reader came to transact and does not need to be re-educated. Say which of those this arc is built for.\nOutput required: produce narrative_movement.v1 with the ordered beats (each naming its purpose, the sections carrying it, what the reader is thinking there, and what would make them leave), the transitions and the objection each retires, the stakes, the resolution, the placement of the ask, plus concise rationale, assumptions, and unresolved questions.\nCompletion criteria: every beat is present or its absence is justified; every transition names the objection it answers; the intensity of the arc sits inside the resolved vector; the ask has a named placement; blockers are explicit.\nBlocker criteria: missing objection_mapping, unsafe or contradictory instructions, unavailable evidence for a claim the arc depends on, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "assignedSkills": [
      "magnetic_marketing"
    ],
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
    "updatedAt": "2026-09-07T08:36:02.564Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 90000,
      "budgetUsd": 0.6,
      "maxOutputTokens": 5000
    }
  },
  {
    "id": "angle_strategy",
    "name": "Angle Strategist",
    "kind": "strategy",
    "description": "Select the strongest angle, promise, tension, differentiation, and external five-stage angle mapping.",
    "prompt": "Objective: Select the single strongest angle — the big idea, the promise, the tension, the reason to believe, and the differentiation that make this piece the one worth reading — and map it across the five awareness stages.\nInputs expected: narrative_movement (the designed arc), plus whatever upstream context is delivered in this node's input — audience, the selected offer or the explicit no-offer decision, and the run's resolved aggression vector and awareness stage when present.\nAngle policy: this is a direct-response property, so a usable angle is ONE specific promise made to ONE specific reader with a reason to believe attached. Generate several candidates, then test each against all five of: WHO exactly — a person in a situation, never a demographic; the PROMISE — what concretely changes for them, and by when; the REASON WHY — the mechanism that makes the promise credible, because a promise without one is only a claim; the ENEMY — the belief, habit, shortcut or conventional answer this piece argues against, since direct response needs something to push off; and DIFFERENTIATION — why this property and not the ten other pages saying the near-same thing. Select one and say plainly why the runners-up lost.\nRejection test: reject any angle that a competitor could publish with nothing but a logo swap. That is the definition of a wasted piece, and saying so here is cheaper than discovering it after the draft.\nHeadline test: state the chosen angle as a headline the target reader would stop for, and a deck beneath it. If the angle cannot survive being written as a headline, it is a topic, not an angle — go back and choose again.\nFive-stage mapping: map the chosen angle across unaware / problem_aware / solution_aware / product_aware / most_aware, saying what the promise and the entry point become at each stage. The run's placement resolver already fixed THIS piece's stage; the mapping exists so a later piece in the same cluster can pick up an adjacent one without re-deriving the idea.\nClaim discipline: the promise is bounded by the resolved claim_strength dial and by the evidence upstream actually produced. Never state certainty the research does not support, never imply professional advice the property is not qualified to give, and never reach for a stronger promise to make a weak angle work — an angle that needs an unsupportable claim is the wrong angle.\nOutput required: produce angle_strategy.v1 with the selected angle (who / promise / reason why / enemy / differentiation), the rejected candidates and why, the headline and deck, the tension the piece sustains, the five-stage mapping, plus concise rationale, assumptions, and unresolved questions.\nCompletion criteria: exactly one angle is selected and all five tests are answered for it; the headline and deck exist; the five-stage mapping is complete; the promise sits inside the resolved claim_strength and the available evidence; blockers are explicit.\nBlocker criteria: missing narrative_movement, unsafe or contradictory instructions, no candidate angle that survives the tests on the available evidence, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "assignedSkills": [
      "magnetic_marketing"
    ],
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
    "updatedAt": "2026-09-07T08:35:55.061Z",
    "metadata": {
      "externalStageMapping": "angle",
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 90000,
      "budgetUsd": 0.6,
      "maxOutputTokens": 5000
    }
  },
  {
    "id": "brief_architect",
    "name": "Brief Architect",
    "kind": "planning",
    "description": "Convert strategy into an executable article brief with structure, claims, proof points, and acceptance criteria.",
    "prompt": "Objective: Convert upstream strategy and evidence into one executable article/content brief for the target client.\nInputs expected: topic_opportunity, monetization_strategy (the selected offer — or explicit no-offer decision — this brief must be aimed at; a hard input, never re-decided here), reader_insight, research, objection_mapping, narrative_movement, and angle_strategy — all delivered directly in this node's input as dependency outputs — plus clientProjectId (the run's registered client). Everything this brief needs is already in your input; do not fetch stage outputs or hunt for additional context.\nOutput required: produce article_brief.v1 with title/slug direction, reader promise, article structure, claim/proof map, reader next step, SEO/meta notes, tone guardrails, acceptance criteria, and what to skip — plus mediaSlots, a structured array with one entry {slotId, purpose, desiredKind, renderMode, placement, style?} per media need. mediaSlots policy: slots come from exactly three sources, and nothing else — (1) every media need the run's envelope explicitly states; (2) every slot the article structure demonstrably needs, where the prose describes a mechanism, a system, an ordered process, a comparison, a place, or a specimen the reader would otherwise have to imagine; and (3) the cadence floor below. Never invent a slot outside those three to make the brief feel complete. desiredKind is a CLOSED enum — 'image' or 'pdf', nothing else: artifact_plan drops a slot whose kind it cannot read, so a third spelling is a silently missing artifact. When the envelope EXPLICITLY requests no media at all, emit mediaSlots as an EMPTY ARRAY, not an absent field and not null: artifact_plan's zero-media skip predicate reads this exact array before doing any other work, so an honest empty array is what tells it, cheaply and structurally, that there is nothing to plan. Never omit mediaSlots and never emit null in its place — either would read as 'unknown', which runs artifact_plan needlessly, or worse, silently reads a stale answer from another carrier.\nMedia cadence policy: a reader-facing article carries AT LEAST ONE image per THREE paragraphs of body prose. Count the body paragraphs your own article structure plans — hero and deck excluded — and emit at least ceil(bodyParagraphs / 3) image slots, distributed so no run of three consecutive paragraphs is unillustrated. Emit MORE than the floor wherever the content earns it: a mechanism, an ordered sequence, a comparison, a before/after, a named place, and a document the reader would actually handle each earn a slot of their own. Record the paragraph count, the computed floor, and the number of slots emitted in the brief's assumptions so a reviewer can check the arithmetic. The envelope may RAISE this floor; only an explicit no-media instruction lowers it, and silence from the envelope is never such an instruction. Shipping an article with no images because nobody thought to ask for any is the exact failure this floor exists to end.\nRender mode policy: every image slot declares a renderMode — the KIND of picture that passage needs — chosen from: mood_photographic (people, atmosphere, emotional register), portrait (a specific or archetypal person), place_architecture (a building, interior, landscape or setting the prose names), product_macro (the thing itself, close), diagram_schematic (how a system or mechanism is actually wired), process_sequence (ordered steps), chart_data (a quantity, comparison or trend), conceptual_illustration (an abstraction the prose argues about), document_specimen (a label, form, report or artifact the reader would really see). Choose the mode from what the PASSAGE needs, never from what the house look happens to render well: a section explaining how a system works earns diagram_schematic even on a site whose brand imagery is warm portrait photography, and a mood photograph of a person may be followed immediately by a palace, then a schematic, then a chart. Uniformity of look across one article is not a goal; fitness of each image to its own passage is. renderMode is a top-level field on the slot, never a style word inside a prompt.\nImage style policy: the site's brandImagery and the client's editorial voice are a STYLE DEFAULT, not a constraint on subject or medium. They say how this publication renders a photograph; they do not say every slot must be a photograph. Where a slot's renderMode is something the house look cannot serve — diagram_schematic, process_sequence, chart_data, document_specimen, and often conceptual_illustration — you MUST attach a per-slot style that departs from it. Departing is the expected behaviour here, not an exception to be justified. THE MECHANISM: set that slot's `style.instructions` — free text, carried end to end and handed to the image resolver as its note — describing MEDIUM, TREATMENT and CONSTRAINTS only (for diagram_schematic, for example: 'technical line schematic, flat vector, labelled callouts, no photographic texture, publication palette only, no people'). The SUBJECT never goes here; it belongs in artifact_plan's `prompt`. Use `style.override` only when you actually know the platform's structured brandImagery shape for the thing you want to change; when you do not, `instructions` is the correct channel. This node's input may also carry a run-level `imageStyle` ({visualStandardId?, override?, instructions?}) — the instruction to draw every image against a different visual standard. Carry it forward, unedited, as the `style` of each mediaSlots entry it applies to; a slot that needs its own departure keeps its own style and does not inherit. When neither applies and the house look fits the mode, omit `style` entirely — an empty object is not the same statement as an absent one. WHERE A NAMED STANDARD COMES FROM when the envelope asks for a look this site has no standard for — a campaign, a series, a one-off set: the `visual_identity` mini-workflow run in mode 'template' writes one and names it `vis_<site>_<slug>`, and THAT id is what belongs in `imageStyle.visualStandardId`. contract_intelligence carries the site's existing named templates in `visualStandard.templates` ({id, label, whenToUse}) — prefer one of those when its whenToUse fits, and reserve a new template for a look none of them describes. Never mint one yourself and never invent a `vis_` id: an id that names no object resolves to nothing and the run silently falls back to the house look. Free-text `instructions` needs no id and is the right tool for a one-slot departure. A site whose `visualStandard.overridePolicy` is 'lock' ignores every style anyway and reports it — carry the style regardless and let the platform report it; that is a stated outcome, never a refusal here.\nCost policy: collapse duplicate strategy into this brief. Do not ask downstream agents to rediscover the angle. Include only sections, claims, and review needs that materially improve the article.\nNext-step policy: this is a direct-response property. Every piece is written to move the reader one measurable step down the funnel, and this brief must name that step concretely — not 'consider the product' but the specific action, where it sits in the piece, and what the reader gets for taking it. The brief's `resolved` aggression vector sets the INTENSITY of the ask, never whether one exists: at low cta_density it is a single quiet offer near the end, at high cta_density it recurs and it closes. Education is the vehicle, not the destination — an article that informs and asks for nothing has failed even when it reads well. Urgency and scarcity are implied and earned, never manufactured, never literal, and never beyond the resolved urgency dial.\nClient policy: clientProjectId names the target client. Voice, styling, and audience direction belong to the client's own record, never to this prompt. Take tone guardrails ONLY from what is present in this node's input (the run's initial instructions and the delivered upstream outputs); when a client voice record exists the conductor delivers it in your input as editorialVoice (fetched live from voice_<project>, or its seeded fallback when the live record is unavailable — editorialVoiceSource names which), and its tone/cadence/lexicon/cta_policy/frameworks are this brief's tone guardrails. Voice governs LANGUAGE; it does not cap the commercial intent the resolved vector already authorized, and the two are married, not opposed. If no voice direction is present, record that gap as an assumption, set neutral reader-first guardrails, and continue — do not spend tool calls searching other stages for a voice record that was not delivered. Treat a missing or unresolvable client identity as a blocker rather than assuming a client.\nContract policy: note likely target object type, expected content-object fields, taxonomy needs, and whether contract_intelligence must inspect anything beyond the client's default object type.\nCompletion criteria: the draft writer can write without guessing; research and factual risks are visible; the named next step is concrete; the media cadence floor is computed, recorded, and met; every image slot carries a renderMode and, where the mode demands it, its own style; blockers are explicit.\nBlocker criteria: missing strategy, missing or unresolvable target client, missing evidence for required claims, unsupported certainty on high-stakes claims, unclear audience/action, or requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
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
              "purpose",
              "desiredKind"
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
                "enum": [
                  "image",
                  "pdf"
                ],
                "description": "CLOSED enum. artifact_plan and artifact_materializer both read this to route the slot; a third spelling is a silently dropped artifact."
              },
              "placement": {
                "type": "string"
              },
              "style": {
                "type": "object",
                "additionalProperties": false,
                "description": "R4's override channel for this slot: which visual standard (or one-off override) the image model should resolve brand from. Never style words in `prompt`.",
                "properties": {
                  "visualStandardId": {
                    "type": "string",
                    "minLength": 1,
                    "description": "A visual_standard object id (vis_<site> for the house standard, vis_<site>_<slug> for a named template)."
                  },
                  "override": {
                    "type": "object",
                    "additionalProperties": true,
                    "description": "A partial brandImagery block applied on top of whatever the visualStandardId/site resolves to. Platform-owned shape; not duplicated here."
                  },
                  "instructions": {
                    "type": "string",
                    "description": "Free-text note for the resolver. Forwarded to the artifact bridge as `note`."
                  },
                  "note": {
                    "type": "string",
                    "description": "REVIEW: the bridge's own spelling of `instructions` (BRIEF 3.4/R4). readSlotStyle in artifactMaterialization.ts accepts BOTH and normalizes to `note` before the create call, but this object is additionalProperties:false — so without this property a slot written in the bridge's own vocabulary fails the node's output schema outright. Declared so the schema permits exactly what the TypeScript reads."
                  }
                }
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
        },
        "imageStyle": {
          "type": "object",
          "additionalProperties": false,
          "description": "BRIEF 3.8: the RUN-level image style. brief_architect copies it onto each mediaSlots entry it applies to; a slot may carry its own `style` instead.",
          "properties": {
            "visualStandardId": {
              "type": "string",
              "minLength": 1,
              "description": "A visual_standard object id (vis_<site> for the house standard, vis_<site>_<slug> for a named template)."
            },
            "override": {
              "type": "object",
              "additionalProperties": true,
              "description": "A partial brandImagery block applied on top of whatever the visualStandardId/site resolves to. Platform-owned shape; not duplicated here."
            },
            "instructions": {
              "type": "string",
              "description": "Free-text note for the resolver. Forwarded to the artifact bridge as `note`."
            },
            "note": {
              "type": "string",
              "description": "REVIEW: R4 names this channel's free-text field `note` and BRIEF 3.8 names it `instructions`; both spellings therefore reach this input from real callers, and this object is additionalProperties:false, so declaring only one turns the other into an input_validation_failed on the whole run. artifactMaterialization.ts already reads either and normalizes to `note` at the bridge."
            }
          }
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
              "purpose",
              "desiredKind"
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
                "enum": [
                  "image",
                  "pdf"
                ],
                "description": "CLOSED enum. artifact_plan and artifact_materializer both read this to route the slot; a third spelling is a silently dropped artifact."
              },
              "placement": {
                "type": "string"
              },
              "style": {
                "type": "object",
                "additionalProperties": false,
                "description": "R4's override channel for this slot: which visual standard (or one-off override) the image model should resolve brand from. Never style words in `prompt`.",
                "properties": {
                  "visualStandardId": {
                    "type": "string",
                    "minLength": 1,
                    "description": "A visual_standard object id (vis_<site> for the house standard, vis_<site>_<slug> for a named template)."
                  },
                  "override": {
                    "type": "object",
                    "additionalProperties": true,
                    "description": "A partial brandImagery block applied on top of whatever the visualStandardId/site resolves to. Platform-owned shape; not duplicated here."
                  },
                  "instructions": {
                    "type": "string",
                    "description": "Free-text note for the resolver. Forwarded to the artifact bridge as `note`."
                  },
                  "note": {
                    "type": "string",
                    "description": "REVIEW: the bridge's own spelling of `instructions` (BRIEF 3.4/R4). readSlotStyle in artifactMaterialization.ts accepts BOTH and normalizes to `note` before the create call, but this object is additionalProperties:false — so without this property a slot written in the bridge's own vocabulary fails the node's output schema outright. Declared so the schema permits exactly what the TypeScript reads."
                  }
                }
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
      "editorial_craft",
      "magnetic_marketing"
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
    "updatedAt": "2026-09-14T10:10:09.793Z",
    "metadata": {
      "approvalRequired": false,
      "voicePrefetch": true
    },
    "modelConfig": {
      "maxTurns": 4,
      "toolCallLimit": 2,
      "timeout": 180000,
      "budgetUsd": 0.8,
      "maxOutputTokens": 12000
    }
  },
  {
    "id": "draft_writer",
    "name": "Full Draft Writer",
    "kind": "drafting",
    "description": "Write a complete draft from the approved brief while preserving canonical structured artifacts over Markdown.",
    "prompt": "Objective: Write the complete reader-facing draft from article_brief.v1 in the target client's editorial voice.\nInputs expected: brief_architect, plus clientProjectId (the run's registered client) delivered in this node's input.\nVoice policy: the client's voice and styling direction come from the client's own record and the brief's tone guardrails, never from this prompt. If no client voice direction is supplied, write calm, precise, practical, evidence-led, reader-first prose and record the gap as an assumption. Never write in a client voice the input does not declare.\nOutput required: produce draft.v1 with proposed title, deck/description, slug candidate, section-by-section draft, source/claim notes, suggested CTA/next step, and unresolved questions.\nAggression policy: the brief carries resolved claim_strength/urgency/emotional_agitation/cta_density — the componentwise minimum of the placement target and the client contract's aggression ceiling. At draft time that vector is still provisional (the brief's `resolvedBasis` says so: the contract ceiling is extracted and applied by contract_intelligence, which runs after you and blocks if the brief exceeds it), so treat the brief's `resolved` dials as the levels to write to — do not exceed them, and do not undershoot cta_density so far the piece cannot monetize. `resolved` is a ceiling on intensity, never a licence: the Style policy below still governs, so never manufacture urgency, agitation, or certainty the evidence does not support merely to reach a dial. If the brief carries no `resolved` vector, write to the placement target delivered in your input and record `aggression_vector_assumed` in `notes` — do not block.\nStyle policy: calm, precise, practical, evidence-led, and reader-first. Avoid hype, fear tactics, fake urgency, invented sources, and overclaiming; never state certainty the evidence does not support, and never imply professional advice (medical, legal, financial) the content is not qualified to give — a client whose domain needs stricter caution declares it in its own record. Use concrete decisions, tradeoffs, and reassurance.\nStructure policy: write in a form that can be converted into the client's content-object nodes. Keep headings and paragraphs clean. Do not expose private strategy labels in reader-visible copy.\nCost policy: do not re-research; use the brief and research outputs. Mark evidence gaps instead of inventing support.\nCompletion criteria: the draft can be reviewed without major missing sections; claims are tied to research or flagged; the draft sits within the brief's resolved aggression levels; blockers are explicit.\nBlocker criteria: missing brief, missing or unresolvable target client, missing evidence for required claims, unsupported certainty on high-stakes claims, unclear audience/action, or requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.\n\nDTC handoff contract (2026-09-09):\nAlways emit blockers and advisories as arrays, including [] when empty. Put every unresolved blocker in the top-level blockers array as a non-empty string; a refusal written only in summary, notes, or an unrecognized status field does not reach the publication controller. Keep editorial preferences in advisories. Missing evidence is not permission to invent it. Emit one JSON object in this node's schema; keep existing useful fields and keep all strategy/evidence annotations out of reader-visible copy.\nReturn draftStatus, proposedTitle, draftSections, sourceClaimNotes, and nextStep. Each draftSections entry contains sectionId, heading, and the COMPLETE readerVisibleCopy, not an outline or directions for another writer. Preserve supplied claim IDs and evidence references in sourceClaimNotes; if the brief omits evidence, flag that gap rather than inventing references. nextStep names the one primary action, its supplied/verified destination (null when unknown), and its rationale. A deliberate no-action request must be named and explained rather than replaced with an invented offer. Do not invent a URL or add competing asks. draftStatus ready requires actual section copy and no unresolved blockers; use blocked with named blockers for a source-awaiting shell. Never put placeholders, production notes, or source gaps into readerVisibleCopy as if ready for publication. Client voice and the assigned magnetic_marketing/editorial_craft skills continue to govern the writing.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "blockers",
        "advisories",
        "draftStatus",
        "proposedTitle",
        "draftSections",
        "sourceClaimNotes",
        "nextStep"
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
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "advisories": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "draftStatus": {
          "enum": [
            "ready",
            "blocked"
          ]
        },
        "proposedTitle": {
          "type": "string",
          "minLength": 1
        },
        "draftSections": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sectionId": {
                "type": "string",
                "minLength": 1
              },
              "heading": {
                "type": "string",
                "minLength": 1
              },
              "readerVisibleCopy": {
                "type": "string"
              }
            },
            "required": [
              "sectionId",
              "heading",
              "readerVisibleCopy"
            ],
            "additionalProperties": true
          }
        },
        "sourceClaimNotes": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "claimId": {
                "type": "string",
                "minLength": 1
              },
              "claim": {
                "type": "string",
                "minLength": 1
              },
              "evidenceReferences": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "handling": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "claimId",
              "claim",
              "evidenceReferences",
              "handling"
            ],
            "additionalProperties": true
          }
        },
        "nextStep": {
          "type": "object",
          "properties": {
            "action": {
              "type": "string",
              "minLength": 1
            },
            "destination": {
              "type": [
                "string",
                "null"
              ]
            },
            "rationale": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "action",
            "destination",
            "rationale"
          ],
          "additionalProperties": true
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
        "blockers",
        "advisories",
        "draftStatus",
        "proposedTitle",
        "draftSections",
        "sourceClaimNotes",
        "nextStep"
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
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "advisories": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "draftStatus": {
          "enum": [
            "ready",
            "blocked"
          ]
        },
        "proposedTitle": {
          "type": "string",
          "minLength": 1
        },
        "draftSections": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sectionId": {
                "type": "string",
                "minLength": 1
              },
              "heading": {
                "type": "string",
                "minLength": 1
              },
              "readerVisibleCopy": {
                "type": "string"
              }
            },
            "required": [
              "sectionId",
              "heading",
              "readerVisibleCopy"
            ],
            "additionalProperties": true
          }
        },
        "sourceClaimNotes": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "claimId": {
                "type": "string",
                "minLength": 1
              },
              "claim": {
                "type": "string",
                "minLength": 1
              },
              "evidenceReferences": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "handling": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "claimId",
              "claim",
              "evidenceReferences",
              "handling"
            ],
            "additionalProperties": true
          }
        },
        "nextStep": {
          "type": "object",
          "properties": {
            "action": {
              "type": "string",
              "minLength": 1
            },
            "destination": {
              "type": [
                "string",
                "null"
              ]
            },
            "rationale": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "action",
            "destination",
            "rationale"
          ],
          "additionalProperties": true
        }
      }
    },
    "allowedTools": [
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [
      "editorial_craft",
      "magnetic_marketing"
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
    "updatedAt": "2026-09-14T10:42:55.014Z",
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
    "prompt": "Objective: Check the draft for claim safety, citation sufficiency, hedging, reader trust, and the evidence standards the target client's content must meet.\nInputs expected: draft_writer and research.\nOutput required: produce trust_factual_review.v1 with claims to keep, soften, support, remove, or re-source; citation gaps; compliance risk; and concise revision instructions.\nCost policy: use existing research first. Fetch only source URLs already cited or clearly necessary to resolve a material uncertainty. Do not run broad new research unless the draft contains an important unsupported claim.\nEvidence policy: distinguish sourced facts, interpretation, and uncertainty. Flag unsupported claims and overconfident language on high-stakes points; a client whose domain needs a stricter evidence bar declares it in its own record. Prefer softer practical phrasing when evidence is limited.\nCompletion criteria: factual risks are prioritized, actionable, and tied to the draft; blockers are explicit.\nBlocker criteria: missing draft, missing research for material claims, unavailable source evidence, unsupported certainty on high-stakes claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.\n\nDTC handoff contract (2026-09-09):\nAlways emit blockers and advisories as arrays, including [] when empty. Put every unresolved blocker in the top-level blockers array as a non-empty string; a refusal written only in summary, notes, or an unrecognized status field does not reach the publication controller. Keep editorial preferences in advisories. Missing evidence is not permission to invent it. Emit one JSON object in this node's schema; keep existing useful fields and keep all strategy/evidence annotations out of reader-visible copy.\nReturn verdict, coverageNote, and claimReviews. Preserve the research/draft claim IDs; identify an additional material claim explicitly when the draft introduced one. For every material claim state the claim, keep/soften/remove/unverified decision, actual evidenceReferences, reason, and exact proposed revision (or null). coverageNote identifies the draft reviewed and any limits; an empty claimReviews array is valid only when that draft contains no material factual claims, with the reason stated. Do not describe an unavailable draft or missing evidence as a passed review. verdict pass requires no unresolved factual/reader-safety blockers; revise means material claim changes are required; blocked means essential review evidence is unavailable. Both revise and blocked require top-level blockers. Prefix these blocker strings with 'trust_factual: ' so their origin is explicit in downstream handoffs. Cosmetic or optional wording improvements belong in advisories. Never treat a proposed correction as already applied or reverified.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "blockers",
        "advisories",
        "verdict",
        "coverageNote",
        "claimReviews"
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
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "advisories": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "verdict": {
          "enum": [
            "pass",
            "revise",
            "blocked"
          ]
        },
        "coverageNote": {
          "type": "string",
          "minLength": 1
        },
        "claimReviews": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "claimId": {
                "type": "string",
                "minLength": 1
              },
              "claim": {
                "type": "string",
                "minLength": 1
              },
              "decision": {
                "enum": [
                  "keep",
                  "soften",
                  "remove",
                  "unverified"
                ]
              },
              "evidenceReferences": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "reason": {
                "type": "string",
                "minLength": 1
              },
              "revision": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "claimId",
              "claim",
              "decision",
              "evidenceReferences",
              "reason",
              "revision"
            ],
            "additionalProperties": true
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
        "blockers",
        "advisories",
        "verdict",
        "coverageNote",
        "claimReviews"
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
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "advisories": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "verdict": {
          "enum": [
            "pass",
            "revise",
            "blocked"
          ]
        },
        "coverageNote": {
          "type": "string",
          "minLength": 1
        },
        "claimReviews": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "claimId": {
                "type": "string",
                "minLength": 1
              },
              "claim": {
                "type": "string",
                "minLength": 1
              },
              "decision": {
                "enum": [
                  "keep",
                  "soften",
                  "remove",
                  "unverified"
                ]
              },
              "evidenceReferences": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "reason": {
                "type": "string",
                "minLength": 1
              },
              "revision": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "claimId",
              "claim",
              "decision",
              "evidenceReferences",
              "reason",
              "revision"
            ],
            "additionalProperties": true
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
    "updatedAt": "2026-09-14T10:10:21.203Z",
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
    "prompt": "Objective: Judge the draft's emotional resonance with the intended audience, using the audience definition and objection landscape actually established for this piece rather than guessing at who the reader is.\nInputs expected: draft_writer, input_triage, reader_insight, objection_mapping.\nAudience grounding policy: reader_insight defines who this piece is for and what they care about; objection_mapping names what will make them skeptical or resistant. Judge resonance against THIS audience and THESE objections, not a generic reader.\nCompletion criteria: the resonance verdict is grounded in reader_insight's audience definition and accounts for objection_mapping's named resistance points; specific passages are cited.\nBlocker criteria: missing draft_writer, reader_insight, or objection_mapping input; unsafe or contradictory instructions.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-08-10T17:26:00.111Z",
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
    "prompt": "Objective: Simulate a reader's path through the draft — drop-off points, friction, and conversion readiness — grounded in who this reader actually is and what they're weighing.\nInputs expected: draft_writer, reader_insight, objection_mapping, angle_strategy.\nSimulation grounding policy: reader_insight defines the reader and their starting state; objection_mapping names the resistance they'll hit; angle_strategy names the persuasive throughline the draft is attempting. Simulate against these, not a generic reader profile.\nCompletion criteria: drop-off points and conversion readiness are tied to specific passages and to reader_insight/objection_mapping/angle_strategy's stated terms.\nBlocker criteria: missing draft_writer, reader_insight, objection_mapping, or angle_strategy input; unsafe or contradictory instructions.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-08-29T14:55:33.928Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 120000,
      "budgetUsd": 1,
      "maxOutputTokens": 12000
    }
  },
  {
    "id": "review_aggregator",
    "name": "Review Aggregator",
    "kind": "review",
    "description": "Combine parallel reviews into prioritized revisions, unresolved conflicts, and final build instructions.",
    "prompt": "Objective: Combine parallel reviews into prioritized revisions, unresolved conflicts, and final build instructions.\nInputs expected: human_texture, trust_factual, emotional_resonance, reader_simulation.\nOutput required: produce review_aggregation.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.\n\nDTC handoff contract (2026-09-09):\nAlways emit blockers and advisories as arrays, including [] when empty. Put every unresolved blocker in the top-level blockers array as a non-empty string; a refusal written only in summary, notes, or an unrecognized status field does not reach the publication controller. Keep editorial preferences in advisories. Missing evidence is not permission to invent it. Emit one JSON object in this node's schema; keep existing useful fields and keep all strategy/evidence annotations out of reader-visible copy.\nReturn reviewStatus, revisions, unresolvedConflicts, and buildInstructions. Revisions identify the actual sourceNodeId, exact passage/section target, concrete instruction, and factual/editorial priority. Consolidate duplicate suggestions and explain incompatible suggestions in unresolvedConflicts instead of ordering mutually exclusive edits. Preserve factual-review blocker strings verbatim, including their source prefix, in blockers; never demote them or claim they were fixed merely because you proposed a revision. If a legacy factual-review output states an unresolved material refusal only in summary/notes, carry that refusal into blockers with the trust_factual prefix. reviewStatus blocked requires these unresolved blockers; ready has none. Keep other reviewers' taste judgments advisory. Consume the conductor's skippedDependencies ledger: an explicitly skipped reviewer is not missing or completed, and must never be invented. buildInstructions direct faithful conversion of the actual draft after the specified edits, not a fresh rewrite from summaries.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary",
        "blockers",
        "advisories",
        "reviewStatus",
        "revisions",
        "unresolvedConflicts",
        "buildInstructions"
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
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "advisories": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "reviewStatus": {
          "enum": [
            "ready",
            "blocked"
          ]
        },
        "revisions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sourceNodeId": {
                "type": "string",
                "minLength": 1
              },
              "target": {
                "type": "string",
                "minLength": 1
              },
              "instruction": {
                "type": "string",
                "minLength": 1
              },
              "priority": {
                "enum": [
                  "factual",
                  "editorial"
                ]
              }
            },
            "required": [
              "sourceNodeId",
              "target",
              "instruction",
              "priority"
            ],
            "additionalProperties": true
          }
        },
        "unresolvedConflicts": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "buildInstructions": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
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
        "blockers",
        "advisories",
        "reviewStatus",
        "revisions",
        "unresolvedConflicts",
        "buildInstructions"
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
        },
        "blockers": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "advisories": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "reviewStatus": {
          "enum": [
            "ready",
            "blocked"
          ]
        },
        "revisions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sourceNodeId": {
                "type": "string",
                "minLength": 1
              },
              "target": {
                "type": "string",
                "minLength": 1
              },
              "instruction": {
                "type": "string",
                "minLength": 1
              },
              "priority": {
                "enum": [
                  "factual",
                  "editorial"
                ]
              }
            },
            "required": [
              "sourceNodeId",
              "target",
              "instruction",
              "priority"
            ],
            "additionalProperties": true
          }
        },
        "unresolvedConflicts": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "buildInstructions": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
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
    "updatedAt": "2026-09-13T13:06:26.632Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 120000,
      "budgetUsd": 0.45,
      "maxOutputTokens": 6000
    }
  },
  {
    "id": "contract_intelligence",
    "name": "Contract Intelligence Agent",
    "kind": "research",
    "description": "Fetch the target client's live object contract at runtime and reduce it to the rules downstream nodes must obey. The client contract is the single source of truth; never author content rules from memory or from a workspace-local copy.",
    "prompt": "Objective: Turn the target client's ALREADY-FETCHED, ALREADY-REDUCED object contract into contract_intelligence.v1, the rules every downstream node must obey. The client's contract is the single source of truth for content shape, ids, media paths, taxonomy, and publishing gates. Never author these rules from memory, from a workspace-local schema, or from another client's contract.\nInputs expected: brief_architect (its article_brief.v1 output), plus clientProjectId (the run's registered client — the conductor delivers it in every node's input; never guess it and never substitute a remembered client) and `prefetchedContract` supplied directly in your input — the conductor calls the client's contract surface deterministically, in code, BEFORE you run, and reduces it (dropping prose, examples, and error catalogues) precisely so you never have to fetch or carry the raw multi-KB contract yourself across your own turns. `prefetchedContract` carries: clientObjectType, bodySchema (the real JSON Schema, kept whole — it is structural, not prose), idConventions, mediaConvention, taxonomy, constraints (with severity and enforcedLive), publishPolicy, workflowSequence, validationSurface (patch/write operations with their required fields), contractSource {tool, fetchedAtISO}, `aggressionCeiling` — the four-dial aggression ceiling, at the TOP LEVEL of prefetchedContract, which is where the deterministic reduction puts it whatever nesting the client's own contract used — and an `unmapped` bucket for anything the deterministic reduction did not recognize but preserved anyway. Your input may ALSO carry `resolvedAggression` {resolved, ceiling, target}: the conductor's own componentwise min(ceiling, target), computed at brief_architect's dispatch from this same contract.\nIf `prefetchedContract` is present: this is a validation and pass-through step, not a discovery one. Sanity-check it, write a concise summary, carry its fields into your own output verbatim (mapping field names as needed — see Output required), and surface anything in `unmapped` worth downstream attention. Do not call project.call_read_tool to re-fetch the primary contract — it has already been fetched this run. Reach for project.call_read_tool ONLY for something genuinely missing from the prefetch (e.g. a registry/taxonomy lookup the client's contract pointed at but did not inline, or the client's own contract tool for a DIFFERENT object type than what was prefetched) — it needs no approval and only reaches read operations (object_contract, registry_get, object_inventory, object_get, object_list, object_validate, ping); reserve project.call_tool for a genuine write, which this node does not perform.\nIf `prefetchError` is present instead (the deterministic fetch failed — unreachable client, policy block, unsupported object type): treat it exactly as the unreachable-client blocker criterion below; do not attempt to fetch the contract yourself as a substitute unless prefetchedContract is entirely absent from your input (an older run/deployment that never wired the prefetch), in which case fall back to the discovery policy your allowedTools describe.\nOutput required: produce contract_intelligence.v1 carrying, at minimum: clientProjectId (from your own input's clientProjectId — the run's registered client), clientObjectType, bodySchema (from prefetchedContract.bodySchema, or your own reduction of a fetched contract, verbatim — never the full raw contract re-derived, so the large fetched payload does not compound across turns nor get carried whole into every downstream node's input), the id conventions (object id and node/child id patterns, from prefetchedContract.idConventions), the media/artifact path convention (raw artifact reference field vs public serving path, and which fields accept which, from prefetchedContract.mediaConvention), the taxonomy source and whether unknown terms block (from prefetchedContract.taxonomy), the enumerated structural constraints with their severity and whether each is enforced live (from prefetchedContract.constraints), the publish policy including whether approval is required and any pinning rules (from prefetchedContract.publishPolicy), any aggression ceiling the contract carries (claim_strength, urgency, emotional_agitation, cta_density, each 0-1) emitted as `ceiling` — read every dial from the contract itself wherever the client declares it, and never invent, round, relax, or default a dial — and contractSource {tool, fetchedAtISO} (from prefetchedContract.contractSource, or your own fetch's).\nWhere to read `ceiling` from, in order: `input.resolvedAggression.ceiling` first, then `prefetchedContract.aggressionCeiling` — both carry the same four dials and the conductor has already extracted them from this run's contract, so COPY the object VERBATIM rather than re-deriving it. Only if BOTH are absent from your input should you go looking in the contract's own `constraints`, `publishPolicy`, or `unmapped` bucket. A clean result (empty or absent `blockers`) MUST carry this `ceiling` object with all four dials; omitting it is the single most common way this artifact fails its own schema.\nGeneralization policy: this node must work for ANY client the workflow encounters, not one named client. Do not hardcode a client's field names, path prefixes, or object types into your reasoning; read them from prefetchedContract (or the contract you fetched) and pass them forward as data. Where a client's contract is silent, say so explicitly as an assumption rather than filling the gap from another client's conventions.\nAggression policy: the applied aggression vector is min(ceiling, target) componentwise, and you are the first node in this run that can see the ceiling — brief_architect runs BEFORE you, so the `resolved` vector it emits on article_brief.v1 is provisional: the placement target alone, unclamped. Extract `ceiling` as described above, then compare the brief's `resolved` dials against it. If any dial of resolved exceeds the corresponding ceiling dial, emit a blocker naming each offending dial with both values (resolved vs ceiling) so the brief and draft are corrected rather than silently published over the client's limit; record the clamped vector min(ceiling, resolved) in your notes so downstream nodes have the authoritative levels. A contract that carries no discoverable aggression ceiling, or one that declares only some of the four dials, is a BLOCKER — per the standing decision an absent ceiling is never defaulted to 1, to the placement target, to the brief's resolved vector, or to another client's ceiling. Report every blocker as a string in your output's `blockers` array; that array is how this artifact expresses a blocked result. Omit `ceiling` from your output ONLY in that blocked case (naming the missing or partial ceiling in `blockers`) — an output with an empty or absent `blockers` array is a clean result and must carry all four ceiling dials read from the contract. Never emit a placeholder, guessed, or all-1.0 ceiling to satisfy the schema.\nCompletion criteria: a downstream node can construct and validate a client object using only your output plus the client's own validator, without guessing and without consulting any workspace-local schema.\nBlocker criteria: the client project is unreachable or unconfigured, clientProjectId is missing from your input, its contract tools are unavailable or denied by policy, the requested object type is unsupported, the contract cannot be fetched read-only, the contract carries no discoverable aggression ceiling (or declares fewer than all four dials) — an absent ceiling is a blocker, never a default, the brief's resolved aggression vector exceeds the contract ceiling on any dial, or the contract declares constraints this workspace cannot satisfy.\nTool policy: use only allowedTools; reach the client only through project.call_read_tool and only with its permitted read-only contract, registry, inventory, and validation operations, and only for what prefetchedContract does not already supply; project.call_tool is approval-gated and reserved for writes only; this node performs no writes and must never publish, create, patch, or otherwise mutate the client.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; never persist secrets, storage grants, raw authorization headers, or tokens.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
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
        },
        "visualStandard": {
          "type": "object",
          "additionalProperties": true,
          "description": "BRIEF 3.7. The site's house visual standard, its assignable templates, and the brand_imagery_override_policy guardrail. Prefetched deterministically (sitePrefetch.ts); absent when that prefetch degraded. FIX (chat-recovery): houseStatus states whether the house standard exists at all, and derivedHouseId carries the id one would take — so absence is a stated fact rather than a missing houseId a node reads as a lookup to perform.",
          "properties": {
            "houseId": {
              "type": "string",
              "description": "The site's house visual_standard id. Present if and only if houseStatus is 'present' — read houseStatus, never this field's absence."
            },
            "houseStatus": {
              "enum": [
                "present",
                "none",
                "unknown"
              ],
              "description": "FIX (chat-recovery). Whether this site HAS a house visual standard, stated positively. 'present' = houseId is the real id. 'none' = object_list(visual_standard) answered and named no house entry, so the site genuinely has none yet — the normal state of a site whose house look has never been written, never an error and never something to probe for. 'unknown' = that list did not complete, so nothing here is evidence either way (a named site_prefetch_degraded warning says which read failed). Always set when visualStandard is present."
            },
            "derivedHouseId": {
              "type": "string",
              "description": "FIX (chat-recovery). The id vis_<site> a house standard for this site occupies or WOULD occupy, derived in code (visualStandardIds.ts) by the same rule visual_standard_materializer writes with, so no node ever assembles one. Travels in all three houseStatus states and is NOT evidence that the object exists."
            },
            "templates": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": true,
                "required": [
                  "id",
                  "label"
                ],
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "label": {
                    "type": "string"
                  },
                  "whenToUse": {
                    "type": "string"
                  }
                }
              }
            },
            "overridePolicy": {
              "enum": [
                "allow",
                "lock"
              ]
            }
          }
        },
        "pdfTemplates": {
          "type": "array",
          "description": "BRIEF 3.7. The site's PUBLISHED PDF templates. artifact_plan picks templateId from here (isDefault first) and fills renderData against renderDataSchema; artifact_materializer derives an article template's render data deterministically.",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "templateId",
              "isDefault"
            ],
            "properties": {
              "templateId": {
                "type": "string"
              },
              "kind": {
                "type": "string"
              },
              "label": {
                "type": "string"
              },
              "renderDataSchema": {
                "type": "object",
                "additionalProperties": true
              },
              "isDefault": {
                "type": "boolean"
              }
            }
          }
        },
        "imagePolicyContexts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "BRIEF 3.7. The keys of the site's image-model policy byUsageContext. artifact_plan chooses requirements.image.usageContext ONLY from this list; artifact_materializer blocks a slot outside it with usage_context_not_in_policy."
        },
        "brandPalette": {
          "type": "object",
          "additionalProperties": true,
          "description": "FIX-D. The site's own brandTokens ({colors, fonts}), carried under this name because the node runners' credential redactor replaces the value of any key matching /token/i. Same values, same platform field (site.brandTokens) underneath.",
          "properties": {
            "colors": {
              "type": "object",
              "additionalProperties": true
            },
            "fonts": {
              "type": "object",
              "additionalProperties": true
            }
          }
        },
        "logo": {
          "type": "object",
          "additionalProperties": true,
          "description": "FIX-D. The site's mark, bounded to where it is and what it is called.",
          "properties": {
            "url": {
              "type": "string"
            },
            "alt": {
              "type": "string"
            }
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
        },
        "visualStandard": {
          "type": "object",
          "additionalProperties": true,
          "description": "BRIEF 3.7. The site's house visual standard, its assignable templates, and the brand_imagery_override_policy guardrail. Prefetched deterministically (sitePrefetch.ts); absent when that prefetch degraded. FIX (chat-recovery): houseStatus states whether the house standard exists at all, and derivedHouseId carries the id one would take — so absence is a stated fact rather than a missing houseId a node reads as a lookup to perform.",
          "properties": {
            "houseId": {
              "type": "string",
              "description": "The site's house visual_standard id. Present if and only if houseStatus is 'present' — read houseStatus, never this field's absence."
            },
            "houseStatus": {
              "enum": [
                "present",
                "none",
                "unknown"
              ],
              "description": "FIX (chat-recovery). Whether this site HAS a house visual standard, stated positively. 'present' = houseId is the real id. 'none' = object_list(visual_standard) answered and named no house entry, so the site genuinely has none yet — the normal state of a site whose house look has never been written, never an error and never something to probe for. 'unknown' = that list did not complete, so nothing here is evidence either way (a named site_prefetch_degraded warning says which read failed). Always set when visualStandard is present."
            },
            "derivedHouseId": {
              "type": "string",
              "description": "FIX (chat-recovery). The id vis_<site> a house standard for this site occupies or WOULD occupy, derived in code (visualStandardIds.ts) by the same rule visual_standard_materializer writes with, so no node ever assembles one. Travels in all three houseStatus states and is NOT evidence that the object exists."
            },
            "templates": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": true,
                "required": [
                  "id",
                  "label"
                ],
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "label": {
                    "type": "string"
                  },
                  "whenToUse": {
                    "type": "string"
                  }
                }
              }
            },
            "overridePolicy": {
              "enum": [
                "allow",
                "lock"
              ]
            }
          }
        },
        "pdfTemplates": {
          "type": "array",
          "description": "BRIEF 3.7. The site's PUBLISHED PDF templates. artifact_plan picks templateId from here (isDefault first) and fills renderData against renderDataSchema; artifact_materializer derives an article template's render data deterministically.",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "templateId",
              "isDefault"
            ],
            "properties": {
              "templateId": {
                "type": "string"
              },
              "kind": {
                "type": "string"
              },
              "label": {
                "type": "string"
              },
              "renderDataSchema": {
                "type": "object",
                "additionalProperties": true
              },
              "isDefault": {
                "type": "boolean"
              }
            }
          }
        },
        "imagePolicyContexts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "BRIEF 3.7. The keys of the site's image-model policy byUsageContext. artifact_plan chooses requirements.image.usageContext ONLY from this list; artifact_materializer blocks a slot outside it with usage_context_not_in_policy."
        },
        "brandPalette": {
          "type": "object",
          "additionalProperties": true,
          "description": "FIX-D. The site's own brandTokens ({colors, fonts}), carried under this name because the node runners' credential redactor replaces the value of any key matching /token/i. Same values, same platform field (site.brandTokens) underneath.",
          "properties": {
            "colors": {
              "type": "object",
              "additionalProperties": true
            },
            "fonts": {
              "type": "object",
              "additionalProperties": true
            }
          }
        },
        "logo": {
          "type": "object",
          "additionalProperties": true,
          "description": "FIX-D. The site's mark, bounded to where it is and what it is called.",
          "properties": {
            "url": {
              "type": "string"
            },
            "alt": {
              "type": "string"
            }
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
    "updatedAt": "2026-09-14T14:15:38.039Z",
    "metadata": {
      "approvalRequired": false,
      "contractPrefetch": true,
      "contractIntelligenceDeterministic": true
    },
    "modelConfig": {
      "maxTurns": 6,
      "toolCallLimit": 3,
      "timeout": 180000,
      "budgetUsd": 0.9,
      "maxOutputTokens": "[REDACTED]",
      "retryCount": 1
    }
  },
  {
    "id": "artifact_plan",
    "name": "Artifact Planning Agent",
    "kind": "adapter",
    "description": "Plan every media/artifact slot brief_architect declared, in ONE tool-less model turn, as an executable materialization_spec.v1. It generates nothing: artifact_materializer executes the spec deterministically.",
    "prompt": "Objective: Emit ONE materialization_spec.v1 — the executable instruction set for every media/artifact slot brief_architect declared. You PLAN. You do not generate, adopt, poll, verify, or call anything: artifact_materializer, the deterministic node immediately after you, executes exactly what you emit.\nTurn budget: you have ONE turn and ZERO tools. allowedTools is empty by design. Everything you need is already in this node's input; there is nothing to fetch and nothing to confirm. Emit the spec and stop.\nInputs expected: brief_architect (mediaSlots — one entry {slotId, purpose, desiredKind, renderMode, placement, style?} per slot the envelope asked for, plus the run-level imageStyle when one was set), contract_intelligence (the artifact protocol, the request-id convention, the media path rules, the media budget, and — carried under these exact names — `pdfTemplates` [{templateId, kind, label, renderDataSchema, isDefault}], `imagePolicyContexts` [the site's image-model policy keys] and `visualStandard` {houseId, templates[], overridePolicy}), and draft_writer (the written prose a PDF slot's renderData is filled FROM). clientProjectId, clientObjectType, contractSource and the run's requestId arrive in your input as runContext.\nSlot fidelity: emit one slot per entry in brief_architect's mediaSlots, carrying that entry's EXACT slotId. The slotId is the key the materializer's adopt call uses to find an artifact a previous run already made, so renaming a slot silently orphans it and buys a duplicate. Never invent a slot brief_architect did not declare, and never drop one it did — a slot you cannot specify goes in blockers, named.\nZero-media shortcut: when brief_architect's mediaSlots is an empty array, emit the spec immediately with slots as an EMPTY ARRAY. A zero-media spec may omit artifactProtocol entirely — there was no protocol to consult, and inventing a protocol string for an empty spec is exactly the fabrication this node forbids elsewhere.\nRequest id policy: carry the requestId the run already holds (runContext.requestId) when it has one, and otherwise derive it from the CLIENT's declared id convention and record that convention in requestIdConvention. Never invent a convention. You are not the authority on this id and you do not need to be: on a client whose object id IS the request id, artifact_materializer binds every artifact to the id of the content_item that actually owns them (the shell created immediately before it dispatches) and overrides yours. Emit your best derivation and move on; do not spend the turn agonising over it, and never report a slot blocked for an id you could not confirm.\nImage slot policy: emit prompt as the image SUBJECT ONLY — what is in the frame, nothing else. Never write style, medium, lighting, mood, palette, seed or lora into it. The site's brandImagery contract supplies all of those server-side and silently overrides anything you send, so style words in your prompt are at best ignored and at worst fight the brand; the slot's `style` object below is the ONLY channel that reaches the resolver. Choose requirements.image.usageContext ONLY from contract_intelligence's `imagePolicyContexts` — those are the site's actual image-model policy keys, and a context outside that list is silently coerced to article_body, producing a differently sized and differently priced image than the one you asked for. When no context in the list fits the slot, omit usageContext entirely rather than inventing one; when `imagePolicyContexts` is absent from your input, omit it too — you have nothing to choose from.\nRender mode policy: brief_architect's `renderMode` names the KIND of picture the passage needs (mood_photographic, portrait, place_architecture, product_macro, diagram_schematic, process_sequence, chart_data, conceptual_illustration, document_specimen). It is not a style word and it never goes into `prompt`. Carry it through on the slot unchanged, and make sure the slot reaches the materializer with a `style` that actually expresses it — see Style policy. Let the mode shape the SUBJECT you write: a diagram_schematic slot's prompt names the components and their relationships, a chart_data slot's names the quantities and their comparison, a document_specimen slot's names the document and its visible fields. A photographic subject line on a schematic slot wastes the image whatever the style says.\nStyle policy: brief_architect may attach a `style` object ({visualStandardId?, override?, instructions?/note?}) to a media slot, and the run may carry an `imageStyle` of the same shape for every slot. COPY it through to the spec slot verbatim — do not merge it, do not summarise it, and above all do not translate it into words in `prompt`. `style` is the sanctioned override channel; the platform resolves it (override > visualStandardId > site.brandImagery > derived), free-text `instructions` reaches the bridge as its `note`, and a site whose owner locked overrides has it ignored there and reported, never refused. A slot with no style of its own inherits the run's imageStyle; a slot with its own style keeps it and does NOT inherit. THE ONE THING YOU MAY AUTHOR: a slot whose renderMode the house look cannot serve — diagram_schematic, process_sequence, chart_data, document_specimen, and often conceptual_illustration — must not reach the materializer with no style at all. When brief_architect declared one, copy it. When it declared such a renderMode but NO style, write that slot's `style.instructions` yourself, describing MEDIUM, TREATMENT and CONSTRAINTS only (for example, for diagram_schematic: 'technical line schematic, flat vector, labelled callouts, no photographic texture, publication palette only, no people'), and name what you authored in notes. The house brandImagery is a style DEFAULT, not a constraint on medium — a schematic rendered as brand mood photography is a wasted image, and closing that gap here is planning, not generation. Never invent a `vis_` id, and never author style for a slot whose renderMode the house look serves perfectly well.\nRequirements shape — this is a hard wire format, not a preference. requirements is the artifact bridge's own object: {maxBytes, image: {outputFormat, size, usageContext}}. An image's output format is requirements.image.outputFormat (for example \"webp\") and its dimensions are requirements.image.size (for example \"1536x1024\"). There is NO top-level requirements.format for an image: that key is the PDF PAGE SIZE and its only legal values are \"A4\" and \"Letter\", so putting an image format there is rejected with HTTP 400 \"Invalid enum value. Expected 'A4' | 'Letter'\" and the slot is blocked without a single pixel generated. maxBytes is top-level. Let renderMode inform the shape you ask for — a diagram or chart usually wants a wider frame than a portrait — but only ever through requirements.image.size, never through a key you invented. When in doubt, omit a constraint rather than inventing one: an absent requirement is a default, a misspelled one is a failed slot.\nPDF slot policy: choose templateId from contract_intelligence's `pdfTemplates` — the entry with isDefault true for the slot's kind first, otherwise the one whose declared kind the slot asks for. Fill renderData with every field that template's renderDataSchema declares, valid against it, with real content from draft_writer rather than placeholder text. For a template whose kind is 'article' you may emit renderData EMPTY OR PARTIAL and say so in notes: artifact_materializer fills title, deck, sections, pullQuotes, sources and the coverImage deterministically from draft_writer's prose and the run's own header image, at zero model cost, and anything you do write wins per key over what it derives. If `pdfTemplates` is absent or carries no usable template, mark that slot in blockers as no_pdf_template and OMIT it from slots. Never author, version, or publish a template — runs only ever use published ones.\nFabrication policy: a slot you cannot fully specify does not go in slots. It goes in blockers, named, with the reason. A half-specified slot would be handed to the materializer, refused there, and reported as a failure that was really a planning gap.\nMedia budget policy: honor the client's declared image budget and preferred format by expressing them in each slot's requirements, in the shape above. Do not plan an artifact the budget forbids. When the budget cannot cover every slot brief_architect declared, keep the slots the article's argument depends on — the mechanism, the comparison, the proof — over decorative mood slots, and name what you dropped and why in blockers rather than silently thinning the set.\nCompletion criteria: every slot you emit is executable with no further judgement — an image slot has a subject prompt, a renderMode, and a style wherever its mode requires one; a PDF slot has a templateId and schema-valid renderData; and both carry the slotId brief_architect named so the materializer's adopt call can find any artifact a previous run already made.\nMemory policy: save only this node's structured output; never persist storage grants, tokens, raw authorization headers, or scoped upload credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "artifact",
        "summary",
        "clientProjectId",
        "clientObjectType",
        "requestId",
        "slots"
      ],
      "if": {
        "required": [
          "slots"
        ],
        "properties": {
          "slots": {
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
          "const": "materialization_spec.v1"
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
        "slots": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "slotId",
              "purpose",
              "desiredKind"
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
                "enum": [
                  "image",
                  "pdf"
                ]
              },
              "placement": {
                "type": "string"
              },
              "prompt": {
                "type": "string"
              },
              "styleRefs": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "requirements": {
                "type": "object",
                "additionalProperties": true
              },
              "templateId": {
                "type": "string"
              },
              "renderData": {
                "type": "object",
                "additionalProperties": true
              },
              "assets": {
                "type": "object",
                "additionalProperties": true
              },
              "filename": {
                "type": "string"
              },
              "style": {
                "type": "object",
                "additionalProperties": false,
                "description": "R4's override channel for this slot: which visual standard (or one-off override) the image model should resolve brand from. Never style words in `prompt`.",
                "properties": {
                  "visualStandardId": {
                    "type": "string",
                    "minLength": 1,
                    "description": "A visual_standard object id (vis_<site> for the house standard, vis_<site>_<slug> for a named template)."
                  },
                  "override": {
                    "type": "object",
                    "additionalProperties": true,
                    "description": "A partial brandImagery block applied on top of whatever the visualStandardId/site resolves to. Platform-owned shape; not duplicated here."
                  },
                  "instructions": {
                    "type": "string",
                    "description": "Free-text note for the resolver. Forwarded to the artifact bridge as `note`."
                  },
                  "note": {
                    "type": "string",
                    "description": "REVIEW: the bridge's own spelling of `instructions` (BRIEF 3.4/R4). readSlotStyle in artifactMaterialization.ts accepts BOTH and normalizes to `note` before the create call, but this object is additionalProperties:false — so without this property a slot written in the bridge's own vocabulary fails the node's output schema outright. Declared so the schema permits exactly what the TypeScript reads."
                  }
                }
              }
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
        "clientProjectId",
        "clientObjectType",
        "requestId",
        "slots"
      ],
      "if": {
        "required": [
          "slots"
        ],
        "properties": {
          "slots": {
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
          "const": "materialization_spec.v1"
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
        "slots": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "slotId",
              "purpose",
              "desiredKind"
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
                "enum": [
                  "image",
                  "pdf"
                ]
              },
              "placement": {
                "type": "string"
              },
              "prompt": {
                "type": "string"
              },
              "styleRefs": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "requirements": {
                "type": "object",
                "additionalProperties": true
              },
              "templateId": {
                "type": "string"
              },
              "renderData": {
                "type": "object",
                "additionalProperties": true
              },
              "assets": {
                "type": "object",
                "additionalProperties": true
              },
              "filename": {
                "type": "string"
              },
              "style": {
                "type": "object",
                "additionalProperties": false,
                "description": "R4's override channel for this slot: which visual standard (or one-off override) the image model should resolve brand from. Never style words in `prompt`.",
                "properties": {
                  "visualStandardId": {
                    "type": "string",
                    "minLength": 1,
                    "description": "A visual_standard object id (vis_<site> for the house standard, vis_<site>_<slug> for a named template)."
                  },
                  "override": {
                    "type": "object",
                    "additionalProperties": true,
                    "description": "A partial brandImagery block applied on top of whatever the visualStandardId/site resolves to. Platform-owned shape; not duplicated here."
                  },
                  "instructions": {
                    "type": "string",
                    "description": "Free-text note for the resolver. Forwarded to the artifact bridge as `note`."
                  },
                  "note": {
                    "type": "string",
                    "description": "REVIEW: the bridge's own spelling of `instructions` (BRIEF 3.4/R4). readSlotStyle in artifactMaterialization.ts accepts BOTH and normalizes to `note` before the create call, but this object is additionalProperties:false — so without this property a slot written in the bridge's own vocabulary fails the node's output schema outright. Declared so the schema permits exactly what the TypeScript reads."
                  }
                }
              }
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
    "allowedTools": [],
    "assignedSkills": [],
    "requiredInputs": [
      "brief_architect",
      "contract_intelligence",
      "draft_writer"
    ],
    "produces": [
      "materialization_spec.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "brief_architect",
      "contract_intelligence",
      "draft_writer"
    ],
    "status": "active",
    "position": {
      "x": 1120,
      "y": 500
    },
    "updatedAt": "2026-09-07T07:49:12.845Z",
    "metadata": {
      "approvalRequired": false,
      "canonicalRules": [
        "This node plans; it never generates, adopts, polls or verifies an artifact",
        "One turn, zero tools: allowedTools is empty by design",
        "A slot that cannot be fully specified is a blocker, never a half-specified slot",
        "Runs only ever USE published PDF templates; a run never authors one",
        "An image prompt is the subject only — brandImagery supplies style, palette, seed and lora server-side",
        "usageContext comes only from imagePolicyContexts; templateId only from pdfTemplates",
        "style is copied through, never dissolved into prompt words"
      ]
    },
    "modelConfig": {
      "maxTurns": 1,
      "toolCallLimit": 0,
      "timeout": 120000,
      "budgetUsd": 2,
      "maxOutputTokens": 4000
    }
  },
  {
    "id": "artifact_materializer",
    "name": "Artifact Materializer",
    "kind": "executor",
    "description": "Deterministic execution of artifact_plan's materialization_spec.v1: adopt, create, poll and verify every media slot through the client's artifact bridge, with no model turn, and emit the unchanged artifact_plan.v1 envelope article_body binds.",
    "prompt": "Objective: Materialize every slot artifact_plan's materialization_spec.v1 declared, and emit artifact_plan.v1 binding each one to a verified artifact.\nThis node is DETERMINISTIC. The engine (artifactMaterialization.ts) runs it with no model turn at all; this prompt is the mock-run fallback and the written statement of the contract that engine keeps.\nInputs expected: artifact_plan (materialization_spec.v1) and contract_intelligence, delivered directly in this node's input.\nOutput required: artifact_plan.v1 — media_slots with one entry per planned slot, artifactReferences carrying both forms of every verified artifact, and blockers naming every slot that failed and why.\nMaterialization policy — adopt first, generate second, poll to a terminal state: create_agent_artifact_job is ASYNCHRONOUS. It returns a JOB, not an artifact, and a response whose job is still running is not verification evidence. Per slot, in this order. (1) ADOPT. Call get_agent_artifact_by_slot for this slot's exact slotId under this request id and the client's site object id. If it returns a materialized artifact, that IS this slot's canonical artifact: record its key, digest, content type, size and public path in the slot's verification field, mark the slot has_trusted_artifact, and CREATE NOTHING. This is what makes a re-run safe, and it is not optional — a duplicate job leaves an orphaned artifact on the client. (2) GENERATE, only when adoption found nothing. Call create_agent_artifact_job with the slot's declared kind, prompt or template_id + data, and requirements, and record the job id it returns before anything polls it. (3) POLL. Call get_agent_artifact_job_status with THAT job id — never a fresh create — until the job reports a terminal state.\nPending policy: a job that is still RUNNING is neither a failure nor a blocked slot, and it is never reported as a finished plan. The node RE-QUEUES and polls again on the next dispatch, so an image that takes a minute is simply awaited. Reserve status blocked for a job that terminally FAILED, a job held for operator approval, a refused create, or a slot the plan could not specify — never for a job that is merely still working.\nEvidence policy: a slot is has_trusted_artifact only on an adoption response or a terminal-success job status carrying BOTH the raw artifact reference and the public path. A pattern-valid key is never proof of materialization.\nFailure policy: a job that terminally failed, or a create the bridge refused, is a BLOCKED SLOT carrying the bridge's own error verbatim — renderer errors included, unparaphrased. A missing request id, a missing site scope, an unusable spec or an unreachable client blocks the NODE, because none of those can be true of one slot only.\nTool policy: use only allowedTools. project.call_read_tool serves a FIXED server-side allowlist of client read verbs (object_contract, registry_get, object_inventory, object_get, object_list, object_validate, ping) and needs no approval — use it for contract and registry lookups. The artifact bridge's own verbs are NOT on that allowlist: create_agent_artifact_job, get_agent_artifact_job_status and get_agent_artifact_by_slot all go through project.call_tool, including the two that only read. Never route an artifact status or slot lookup through project.call_read_tool — it is refused before any transport with read_tool_operation_not_permitted, and that refusal is a routing mistake on your side, never evidence about the artifact. Do not publish, release, or mutate the client from this node beyond the single draft create the owning-object precondition permits.\nMemory policy: save only this node's structured output; never persist storage grants, tokens, raw authorization headers, or scoped upload credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
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
    "assignedSkills": [],
    "requiredInputs": [
      "artifact_plan",
      "contract_intelligence",
      "brief_architect"
    ],
    "produces": [
      "artifact_plan.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "artifact_plan",
      "contract_intelligence",
      "brief_architect"
    ],
    "status": "active",
    "position": {
      "x": 1120,
      "y": 640
    },
    "updatedAt": "2026-08-31T00:00:00.000Z",
    "metadata": {
      "approvalRequired": true,
      "artifactMaterializerDeterministic": true,
      "maxPollDispatches": 40,
      "canonicalRules": [
        "Deterministic: no model turn, and no usage recorded (the R-20 $0 rule)",
        "A slot whose artifact already exists is adopted, never regenerated",
        "A job id is persisted before anything polls it, so no key ever gets a second job",
        "Only an adoption response or a terminal-success job status is verification evidence",
        "A renderer or bridge error reaches the operator verbatim, never paraphrased"
      ]
    },
    "modelConfig": {
      "maxTurns": 8,
      "toolCallLimit": 6,
      "timeout": 120000,
      "budgetUsd": 0.25,
      "maxOutputTokens": 3000
    }
  },
  {
    "id": "article_body",
    "name": "Article Body Builder",
    "kind": "builder",
    "description": "Build the client's content object in the client's own shape, using the contract fetched at runtime by contract_intelligence. The client contract is the only source of truth; no workspace-local content schema is authoritative.",
    "prompt": "Objective: Build the target client's content object in the CLIENT'S OWN SHAPE, using the contract that contract_intelligence fetched at runtime. Emit it as the body field of this node's output envelope.\nSource of truth: the client's fetched contract is the ONLY authoritative content schema. Never build to a workspace-local article schema, never build from memory of a previous client, and never treat a workspace validator's verdict as authoritative. If contract_intelligence did not supply a contract with contractSource provenance, that is a blocker — do not proceed on assumption.\nInputs expected: review_aggregator (the approved editorial content), draft_writer (the complete drafted prose — build the body FROM this draft as amended by review_aggregator's revision instructions, never by re-writing the article from notes), contract_intelligence (the client contract), narrative_movement (the reader-journey arc: section movement, stakes, transitions, resolution), angle_strategy (the chosen angle, promise, and tension) — the upstream editorial reasoning your per-node private annotations are built from — and artifact_materializer (media_slots already materialized and verified for this run, with each slot's artifactReference and publicPath), delivered directly in this node's input. artifact_materializer has already run and already generated and verified whatever media brief_architect's mediaSlots asked for; you bind its output, you do not plan or generate media yourself. clientProjectId also arrives directly in this node's input from the conductor and must agree with contract_intelligence's clientProjectId; if they disagree, that is a blocker. Carry clientProjectId, clientObjectType and contractSource straight through from contract_intelligence into your output.\nBody construction policy: shape body exactly to the contract's body schema — its required fields, its field names, its id patterns, its enums, and its strictness. If the contract's schema is strict (additionalProperties false), emit no field it does not declare, including workspace-only fields such as a schema version marker. Root the client's fields where the contract roots them. Where the contract offers a richer representation than plain text (for example a structured rich-text grammar), prefer it only if the contract declares it and you can satisfy its grammar; otherwise use the simplest representation the contract accepts and note the choice.\nPrivate annotation policy: where the contract's body schema declares per-node private annotation fields (for example a private block with closed strategy/intent enums and a free-text notes field), populate them on EVERY node you emit — an absent private annotation is a defect, not a default. Choose each enum value ONLY from the enum the contract itself declares — never invent, pluralize, or approximate a value — mapping each node's role in the piece from narrative_movement's arc and angle_strategy's angle/promise plus review_aggregator's build instructions, and put the one-sentence reasoning for the choice in the contract's free-text private notes field. If narrative_movement or angle_strategy outputs are absent or skipped (for example a late-stage entry run), derive the annotation from the approved content itself and record that as an assumption. Private annotation is never reader-visible — the contract's renderer emits public fields only — so annotate every node rather than leaving private fields absent. If the contract declares no private annotation fields for this object type, note that instead; never add undeclared fields.\nMedia policy: read the media convention from the contract rather than assuming one. Distinguish the fields that accept a RAW artifact reference from the fields that are RENDERED, and put the right form in each: rendered fields take the client's public serving path, raw reference fields take the artifact key. If the contract states that raw keys are rejected in rendered fields, honor that — a raw key in a rendered field is a build-breaking error, not a cosmetic one. Only reference artifacts that were materialized for the CURRENT request and verified by the artifact tool; pattern-valid keys are not proof. Never use remote URLs, data URIs, repo paths, hand-authored keys, or references copied from another request or another slug. Respect the client's media budget and preferred format when the contract or storage grant declares them. Honor any placement or rendering metadata the contract requires for reader-visible media — omitting it can silently drop the media from the published page.\nVerified media binding policy: artifact_materializer already ran, already generated the media brief_architect's mediaSlots asked for, and already verified each reference against the client's artifact protocol — its media_slots array is the ONLY source of media for this build. For every slot with status has_trusted_artifact, bind its publicPath into the contract's rendered image field in the contract's own shape — exactly { src: publicPath, alt } where the contract's schema calls it that, or the equivalent rendered-field name the contract declares — and bind its raw artifactReference (never the publicPath) into the contract's raw reference field, and mirror the same bound reference into this node's own media-bearing fields (artifactReferences, mediaPathConvention) so downstream nodes need not re-derive it. NEVER bind a slot artifact_materializer marked needs_generation or blocked, NEVER bind a reference this node did not receive from artifact_materializer (no re-fetching, no re-generating, no re-verifying — that is artifact_materializer's job and it already did it), and NEVER place a raw artifact key in a rendered field: an unverified reference or a raw key in a rendered field must never reach a rendered field, full stop — if artifact_materializer left a slot unresolved, leave that slot's rendered field absent and record the gap as a blocker or assumption instead of guessing.\nClient validation policy: before completing, validate through the CLIENT's own validator via project.call_read_tool, read-only, and record the outcome in clientValidation {tool, valid, issues}. project.call_read_tool needs NO approval and is the correct surface for validation; do not use project.call_tool for reads, and do not report yourself blocked because project.call_tool is unavailable — that tool is deliberately approval-gated for writes only. If the client's validator requires an existing object record that does not yet exist, do NOT attempt to create one — this node is write-prohibited. Record clientValidation {attempted: true, tool, valid: false, deferred: \"requires_existing_object\"} quoting the client's own refusal in issues, and treat that as a NORMAL outcome, not a blocker: the authoritative validation runs in the publish executor after object_create and before any patch. Do not claim validity, and do not spend further calls re-attempting once the client has reported the object does not exist. If the client cannot be reached or its read-only validator is denied by the project's own policy, set clientValidation.attempted false, add a blocker, and do not claim validity.\nReader-safety policy: reader-visible strings must never leak strategy labels, prompts, scoring, internal notes, or workflow vocabulary. Put internal annotation only in the private/internal fields the contract designates. Follow the contract's id rules, including any prohibition on ids that reveal intent.\nCompletion criteria: body satisfies the client's contract as fetched; contract-declared private annotation fields are populated on every emitted node (or the contract's silence on them is noted); every media reference is verified and in the correct form for its field; clientValidation records a real result from the client, or a deferral because the validator requires an object that does not yet exist; assumptions and blockers are explicit.\nBlocker criteria — a CLOSED list. blockers[] carries these and nothing else: no contract or no contractSource provenance; the client is unreachable or unconfigured; clientProjectId is missing from this node's input or disagrees with contract_intelligence's; required contract fields cannot be satisfied from the approved content; taxonomy terms you were given were resolved against the client's registry and did not resolve AND the contract blocks unknown terms; media is missing, unverified, or cannot be expressed in the form the contract demands; or the contract declares a constraint this workspace cannot meet. Every entry on that list is a structural fact about whether the OBJECT YOU JUST BUILT is valid and renderable. A blocker from this node hard-blocks publication and is never waivable, so nothing else belongs in the field.\nNever a blocker, however strongly you feel it — each of these is owned by a different gate that has already run or will run after you, and writing it into blockers[] freezes a transient run condition into the artifact permanently: (a) the run's operator publish decision, approval state, review state, or any publication gate's status — publication_controller and the operator own these and re-evaluate them at publish time, so an article that says 'do not publish while the decision is withheld' can never publish even after the operator approves, which is a deadlock you would be creating; (b) whether a factual or regulatory claim has been independently source-verified — trust_factual owns reader safety and has already run; (c) whether taxonomy ought to be re-validated as a precaution, when the terms you were given resolved or none were required — the publish-readiness checklist owns taxonomy; (d) any recommendation, caveat, precaution, editorial reservation, or 'should be confirmed before publication' note about the writing. Put every one of those in assumptions or notes, where they are recorded and read by the operator but do not gate. The test, applied to each candidate: is the object I built invalid or unrenderable without this? If it still validates and still renders, it is a note, not a blocker.\nTool policy: use only allowedTools; reach the client through project.call_read_tool for every read-only contract and validation operation; project.call_tool is approval-gated and reserved for writes — never create, patch, publish, or release from this node.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; never persist secrets, storage grants, raw authorization headers, or tokens.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
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
      "artifact_materializer"
    ],
    "produces": [
      "client_object.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "review_aggregator",
      "draft_writer",
      "contract_intelligence",
      "narrative_movement",
      "angle_strategy",
      "artifact_materializer"
    ],
    "status": "active",
    "position": {
      "x": 1120,
      "y": 700
    },
    "updatedAt": "2026-09-14T09:13:06.591Z",
    "metadata": {
      "approvalRequired": false,
      "externalStageMapping": "final_article",
      "canonicalRules": [
        "The client's fetched contract is the only authoritative content schema",
        "body must be emitted in the client's own object shape, not a workspace shape",
        "Renderable media fields carry the client's public path; raw artifact keys only in the client's designated reference fields",
        "Workspace-local article schemas are advisory and must never be used to validate",
        "Do not regenerate the article from a brief, outline, or summary when the actual drafted text is available in your input — a full rewrite from notes is the failure mode this input exists to prevent.",
        "Media comes from artifact_plan's already-verified media_slots only — never re-planned, re-generated, or re-verified here, and never an unverified reference in a rendered field"
      ]
    },
    "modelConfig": {
      "maxTurns": 9,
      "toolCallLimit": 8,
      "timeout": 300000,
      "budgetUsd": 1.125,
      "maxOutputTokens": "[REDACTED]"
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
      "artifact_materializer"
    ],
    "produces": [
      "dry_run_publish_payload.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "article_body",
      "artifact_materializer"
    ],
    "status": "active",
    "position": {
      "x": 0,
      "y": 540
    },
    "updatedAt": "2026-08-26T14:54:07.879Z",
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
      "maxTurns": 8,
      "toolCallLimit": 6,
      "timeout": 300000,
      "budgetUsd": 0.5,
      "maxOutputTokens": 10000
    }
  },
  {
    "id": "publication_controller",
    "name": "Publication Controller",
    "kind": "controller",
    "description": "Prepare an auditable publication decision record. Under the standing go-live authorization (2026-07-31) a decision defaults to go when correctness checks pass; no per-publish approval ceremony is required.",
    "prompt": "Objective: Prepare an auditable publication decision record. Under the standing go-live authorization (operator decision, 2026-07-31), a decision defaults to GO when the correctness checks below pass — no separate per-publish approval ceremony is required. This node itself must not publish, release, trigger builds, upload artifacts, or mutate external systems; execution belongs to publish_executor.\nSource of truth: the target client's fetched contract governs what a valid object, a valid artifact reference, and a valid publish action are. Read those rules from the contract carried through publish_payload rather than assuming any client's conventions. If the payload lacks contractSource provenance, treat the decision as no_go.\nInputs expected: publish_payload.\nOutput required: produce publication_decision.v1 with a go/no-go recommendation, the authorization facts, artifact readiness, blockers, and the exact next action the publish executor will take.\nContent path policy: the only valid content is the client-shaped object the contract declares, carried as clientObject. Refuse any payload built from Markdown, legacy article bodies, prose blobs, repo files, or any representation the client's contract does not declare.\nArtifact protocol policy: the artifact protocol named by the client's contract is the only valid transfer path. Refuse legacy fallbacks: repo asset paths, remote URLs, data URIs, direct-save or import-from-URL fallbacks, references copied from another request or slug, and hand-authored keys.\nArtifact readiness policy: an artifact reference is trusted only when publish_payload or artifact_plan carries verification evidence that the artifact was materialized by the client's protocol for the SAME request id. A syntactically valid key is not enough. Confirm each reference sits in the form its target field requires — public serving path for rendered fields, raw reference only where the contract designates. If materialization was unverified, the request id was never confirmed against the client's convention, taxonomy is unresolved, or provenance is unclear, recommend no_go / blocked_for_publish_execution.\nClient verdict policy: require a validation verdict produced by the CLIENT's own validator, not by a workspace-local checker. A workspace verdict is not evidence. Absent or stale client validation is a blocker. A verdict of valid:false from the client's own validator is a blocker in its own right — never recommend \"go\" over one, and never treat an engine revision attempt as having resolved it unless the client subsequently returned valid:true.\nAuthorization policy: the operator's standing go-live authorization covers publication; record it in the decision. Only an explicitly withheld authorization on the request blocks. State the publication action, the artifact set with keys and digests, and the release/build behaviour (default publish_now) so the executor acts on exact parameters. Decision vocabulary and its mapping to the executor's gate: your decision field is exactly one of \"go\", \"no_go\" or \"blocked\", and an exact \"go\" is necessary but NOT sufficient to publish — publish_executor additionally requires the run to hold resolved publish authority, which publishDecision.resolvePublishAuthority decides over three rows: an operatorPublishDecision of \"withheld\" refuses absolutely; an operatorPublishDecision of exactly \"approved\" authorizes; and with no operator decision recorded, authority comes from the run's snapshotted publishingPolicySnapshot.autonomyMode, where \"autonomous\" authorizes and anything else refuses. That resolution is not yours to make. Emit \"go\" as a correctness recommendation only; never set, simulate, imply or report operatorPublishDecision or the run's autonomy policy from this node, and never treat your own \"go\" as either an operator approval or a policy authorization.\nCompletion criteria: the decision is auditable; the content path matches the client's contract; artifacts are either verified or explicitly blocked; taxonomy readiness is explicit; the client's own validator has spoken and its verdict is reflected in the decision; and no publish, release, or build side effect was performed by THIS node.\nBlocker criteria: missing publish_payload; missing contract provenance; content outside the client's declared shape; missing or unverified artifact references; a client validator verdict of valid:false; a request id that does not satisfy the client's convention; unresolved taxonomy without explicit acceptance where the contract blocks unknown terms; explicitly withheld authorization; or any requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; never call publish, release, build, upload, import, or mutation tools from this node.\nMemory policy: save only this node's structured decision output; never persist secrets, raw authorization headers, storage grants, scoped upload tokens, or blob credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
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
    "updatedAt": "2026-09-07T15:25:47.111Z",
    "metadata": {
      "approvalRequired": false,
      "publicationControllerDeterministic": true,
      "goLive": {
        "enabledAt": "2026-07-31",
        "authorizedBy": "Wolf (operator)",
        "note": "Per-publish approval ceremony removed; correctness gates retained."
      },
      "projectPolicyNotes": [
        "Publishing is enabled under the standing go-live authorization",
        "Validate the target project's artifact-reference and raw-image-URL rules before publishing"
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
    "prompt": "Objective: Execute a publish against the target client under the standing go-live authorization (operator decision, 2026-07-31). Publishing is enabled but never unconditional: every publish requires BOTH an exact \"go\" decision from publication_controller AND resolved publish authority for this run (see Authorization policy). Anything else blocks.\nSource of truth: the client's fetched contract declares the publish sequence, the lock and version discipline, the valid publication actions, the release/build behaviours, and the error codes. Read them from contractSource carried through publication_controller. Never execute a sequence remembered from another client or hardcoded here. Missing contract provenance is a hard block.\nInputs expected: publication_controller.\nOutput required: publish_execution.v1 with the exact action taken, the client object and request id, the artifact set, the publish result, the release/build status, and the verification performed.\nContent path policy: the only valid content is the client-shaped object the contract declares. Refuse Markdown, prose blobs, repo files, or any representation the contract does not declare.\nArtifact policy: every media reference must be a verified current-request artifact under the protocol the contract names, with matching key, digest, content type, size and timestamp. A pattern-valid key is not proof. Refuse repo paths, remote URLs, data URIs, copied references, hand-authored keys, and any unverified reference that merely looks well-formed. If verification is absent, stale, partial, timed out, or belongs to another request, block.\nRendered vs raw policy: put the client's public serving path in rendered fields and the raw artifact key only in the fields the contract designates for references. Where the contract warns that a raw key in a rendered field breaks the build, treat that as a hard block, never a warning.\nAuthorization policy: two independent preconditions must BOTH hold before any publish, release, build or upload side effect, and neither may be inferred from the other. (1) Controller decision: publication_controller's decision field must read exactly \"go\". \"no_go\", \"blocked\", an absent decision, a hedged or qualified decision, or any other value refuses by default — there is no default-execute and no \"execute unless objected to\". (2) Publish authority: the run must hold resolved publish authority, decided by publishDecision.resolvePublishAuthority over exactly three rows, in this order. FIRST, and ahead of everything including an autonomous project: an operatorPublishDecision of \"withheld\" is an absolute refusal. SECOND: an operatorPublishDecision of exactly \"approved\" is sufficient authority in every mode (source operator_explicit). THIRD, when NO operator decision is recorded: authority comes from the run's own snapshotted publishing policy — publishingPolicySnapshot.autonomyMode of \"autonomous\" authorizes (source policy_autonomous), and an absent snapshot, an absent mode, or \"operator-gated\" refuses with operator_approval_absent. A project's autonomyMode is snapshotted onto the run at creation, so a policy change never retroactively authorizes a run that was created under the old policy. Read both values yourself from evidence available to this node: re-read publication_controller's decision record with stage.get_output / stage.list_outputs rather than trusting a summary, and read operatorPublishDecision and publishingPolicySnapshot from the run context carried into this node's input payload. The controlled tool registry exposes no run-context reader tool, so if neither an \"approved\" operatorPublishDecision nor an \"autonomous\" publishingPolicySnapshot.autonomyMode is present in the run context you are given, treat authority as absent and block — never assume it, never reconstruct it, and never treat operator silence as approval where the policy is not autonomous. approvalMatched means AUTHORITY RESOLVED, not \"a human signed off\": set it true only after both preconditions have been read that way, and name which row authorized it in operatorDecisionSource (operator_explicit or policy_autonomous) so a receipt reader can never mistake a policy default for an explicit operator sign-off. If either precondition cannot be read, approvalMatched is false and status is not \"executed\". On refusal, perform no side effect and emit status \"blocked\" with the exact reason named in blockers — the offending field and the value observed, for example \"publication_controller.decision = no_go (expected go)\", \"publication_controller.decision = blocked (expected go)\", \"publication_controller.decision absent (expected go)\", \"operatorPublishDecision = withheld (absolute refusal)\", or \"no operator approval and publishingPolicySnapshot.autonomyMode is not autonomous (operator_approval_absent)\". Where the contract pins parameters to a specific action or revision, use the pinned values exactly.\nSequence policy: follow the contract's declared workflow in order, including its checkout/validate/patch/publish/checkin discipline and its lock and expected-version rules. Dry-run validate before mutating. Surface the contract's own error codes rather than reinterpreting them: a lock conflict means re-acquire, a version conflict means re-read, never force.\nPublish vs release policy: treat publishing and going live as separate gates whenever the contract separates them. Where publish commits without deploying and a distinct release performs the build, trigger the release matching the requested release behaviour (default publish_now covers both) — a release may deploy every accumulated pending publish at once, so record what went out. After any release, confirm go-live is real: a production-confirmed deploy of the target commit, then page and media verification. A queued or ready-but-undeployed build is not live. Record that confirmation as verification.deployStatus and verification.productionConfirmed, taken from the client's own deploy-status evidence; status \"executed\" is only permitted when verification.deployStatus is \"ready\" and verification.productionConfirmed is true.\nCompletion criteria: content and artifacts are verified; the sequence followed the contract; the release matches the requested behaviour; both authorization preconditions were read and matched, with the authorizing row named in operatorDecisionSource; and the result and go-live confirmation (verification.deployStatus \"ready\", verification.productionConfirmed true) are recorded.\nBlocker criteria: missing contract provenance; any publication_controller decision other than an exact \"go\" (including no_go, blocked, absent or hedged); an operatorPublishDecision of \"withheld\"; no resolved publish authority (no \"approved\" operator decision and a publishingPolicySnapshot.autonomyMode that is absent or not \"autonomous\"); missing artifact verification; unresolved taxonomy where the contract blocks unknown terms; lock or version conflicts; runner idempotency doubt; unavailable publish or release tools; unobtainable deploy-status evidence; content outside the client's declared shape; or non-protocol artifact references.\nTool policy: reach the client only through the controlled project MCP grants and never bypass project policy. The controlled registry has no separate publish, release or verification tool ids — those are project MCP operations invoked through two grants. Read-only client evidence (object_contract, registry_get, object_inventory, object_get, object_list, object_validate, ping) goes through project.call_read_tool. Mutating and verification operations the read allowlist does not cover — object_publish, release_to_production, deploy_status — go through project.call_tool. Gather the deployStatus and productionConfirmed evidence yourself through these grants; never report verification you did not obtain from a tool result.\nMemory policy: never expose or persist secrets, raw authorization headers, storage grants, scoped upload tokens, or blob credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
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
            "published_pending_release",
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
          "description": "True only when the run holds RESOLVED PUBLISH AUTHORITY — which is not the same as \"a human signed off\". publishDecision.resolvePublishAuthority decides it over three rows, in order: an operatorPublishDecision of \"withheld\" refuses absolutely, ahead of everything including an autonomous project; an operatorPublishDecision of exactly \"approved\" authorizes in every mode (source operator_explicit); and when NO operator decision is recorded, the run's snapshotted publishingPolicySnapshot.autonomyMode of \"autonomous\" authorizes (source policy_autonomous), while an absent snapshot, an absent mode, or \"operator-gated\" refuses with operator_approval_absent. The engine verifies this claim deterministically (publishExecution.ts sets it from gate.operatorApproved); a status of \"executed\" requires it to be true and to match that record. Read operatorDecisionSource alongside it to see WHICH row authorized — a project-policy default must never be reported as an explicit operator sign-off."
        },
        "operatorDecisionSource": {
          "type": "string",
          "description": "Which authority row authorized this publish — operator_explicit (a recorded operator approval) or policy_autonomous (the project's autonomyMode). Recorded next to approvalMatched so a receipt reader can never take a policy default for a human sign-off."
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
            "published_pending_release",
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
          "description": "True only when the run holds RESOLVED PUBLISH AUTHORITY — which is not the same as \"a human signed off\". publishDecision.resolvePublishAuthority decides it over three rows, in order: an operatorPublishDecision of \"withheld\" refuses absolutely, ahead of everything including an autonomous project; an operatorPublishDecision of exactly \"approved\" authorizes in every mode (source operator_explicit); and when NO operator decision is recorded, the run's snapshotted publishingPolicySnapshot.autonomyMode of \"autonomous\" authorizes (source policy_autonomous), while an absent snapshot, an absent mode, or \"operator-gated\" refuses with operator_approval_absent. The engine verifies this claim deterministically (publishExecution.ts sets it from gate.operatorApproved); a status of \"executed\" requires it to be true and to match that record. Read operatorDecisionSource alongside it to see WHICH row authorized — a project-policy default must never be reported as an explicit operator sign-off."
        },
        "operatorDecisionSource": {
          "type": "string",
          "description": "Which authority row authorized this publish — operator_explicit (a recorded operator approval) or policy_autonomous (the project's autonomyMode). Recorded next to approvalMatched so a receipt reader can never take a policy default for a human sign-off."
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
      "project.call_tool",
      "project.call_read_tool"
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
    "updatedAt": "2026-09-08T16:11:43.114Z",
    "metadata": {
      "activationRequired": false,
      "approvalRequired": false,
      "publishExecutorDeterministic": "execute",
      "goLive": {
        "enabledAt": "2026-07-31",
        "authorizedBy": "Wolf (operator)",
        "note": "All ceremony barriers removed by explicit operator decision; contract/artifact correctness policies retained."
      },
      "canonicalRules": [
        "The client's contract declares the publish sequence, lock discipline and approval pin rules",
        "Publish and release are separate gates",
        "Only verified current-request artifacts may be published",
        "No legacy fallback systems"
      ]
    },
    "modelConfig": {
      "maxTurns": 8,
      "toolCallLimit": 4,
      "timeout": 180000,
      "budgetUsd": 0.5,
      "maxOutputTokens": 3000
    }
  },
  {
    "id": "release_executor",
    "name": "Release Executor",
    "kind": "releaser",
    "description": "Deterministic, idempotent release of what publish_executor committed: calls release_to_production at most once for this run, then confirms production is serving the deployed commit before this node ever claims \"executed\".",
    "prompt": "Objective: Release what publish_executor committed and confirm production is actually serving it. This node is a governed release step, not a publish step — it never creates, patches or publishes a client object.\nSource of truth: publish_executor's own publish_execution.v1 record on this run says what was committed (publishCommitted) and under what authority (publishAuthority). Read the release/build behaviour and any deploy-status contract from the target client's fetched contract; never guess a dialect.\nInputs expected: publish_executor.\nOutput required: produce release_execution.v1 with status skipped (nothing was published this run), executed (release_to_production succeeded AND deploy_status confirms deployStatus \"ready\" and productionConfirmed true), or blocked (a release call failed, was declined, or verification did not confirm within the allowed attempts).\nIdempotency policy: release_to_production is called AT MOST ONCE for this run's publish request id. If a prior attempt on this run already released, do not call it again under any circumstance — only re-poll deploy_status for an updated verification result.\nSkip policy: when publish_executor did not commit a publish, do nothing — call no client tool at all, and record status skipped with the reason. Asking production to rebuild for zero commits is not a safe default.\nVerification policy: an \"executed\" claim requires BOTH deployStatus \"ready\" and productionConfirmed true from the client's own deploy-status tool. A queued or ready-but-undeployed build is not live and must not be reported as executed.\nCompletion criteria: the release outcome is recorded exactly once per run; verification evidence (or its explicit absence) is recorded; nothing here silently retries a release that already happened.\nBlocker criteria: release_to_production call failure or explicit decline; deploy_status verification not confirmed within the allowed attempts; missing contract provenance for a client whose release behaviour is not the shared default.\nTool policy: reach the client only through the explicitly allowed release and deploy-status tools; never call object_create, object_patch, object_publish, trigger_netlify_build or deploy directly — a build is release_to_production's own decision, never something requested directly.\nMemory policy: never expose or persist secrets, raw authorization headers, storage grants, scoped upload tokens, or blob credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "artifact",
        "summary",
        "status",
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
          "const": "release_execution.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "enum": [
            "skipped",
            "executed",
            "blocked"
          ]
        },
        "reason": {
          "type": "string",
          "minLength": 1
        },
        "releaseId": {
          "type": "string",
          "minLength": 1
        },
        "deployedSha": {
          "type": "string",
          "minLength": 1
        },
        "approvalMatched": {
          "type": "boolean"
        },
        "publishAuthority": {
          "type": "object",
          "additionalProperties": true
        },
        "verification": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "deployStatus": {
              "type": "string",
              "description": "Client deploy status for the released commit; \"ready\" is the only value that counts toward go-live evidence."
            },
            "productionConfirmed": {
              "type": "boolean",
              "description": "True only when the production site was confirmed to serve the released commit. Required (with deployStatus \"ready\") for status \"executed\"."
            }
          }
        },
        "result": {
          "type": "object",
          "additionalProperties": true
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
          "const": "release_execution.v1"
        },
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "enum": [
            "skipped",
            "executed",
            "blocked"
          ]
        },
        "reason": {
          "type": "string",
          "minLength": 1
        },
        "releaseId": {
          "type": "string",
          "minLength": 1
        },
        "deployedSha": {
          "type": "string",
          "minLength": 1
        },
        "approvalMatched": {
          "type": "boolean"
        },
        "publishAuthority": {
          "type": "object",
          "additionalProperties": true
        },
        "verification": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "deployStatus": {
              "type": "string",
              "description": "Client deploy status for the released commit; \"ready\" is the only value that counts toward go-live evidence."
            },
            "productionConfirmed": {
              "type": "boolean",
              "description": "True only when the production site was confirmed to serve the released commit. Required (with deployStatus \"ready\") for status \"executed\"."
            }
          }
        },
        "result": {
          "type": "object",
          "additionalProperties": true
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
      "publish_executor"
    ],
    "produces": [
      "release_execution.v1"
    ],
    "riskLevel": "publish",
    "dependsOn": [
      "publish_executor"
    ],
    "status": "active",
    "position": {
      "x": 560,
      "y": 1060
    },
    "updatedAt": "2026-08-25T00:00:00.000Z",
    "metadata": {
      "activationRequired": false,
      "approvalRequired": false,
      "releaseExecutorDeterministic": true,
      "canonicalRules": [
        "release_to_production is reachable from exactly this node (Board decision B2, amended by ADR-2026-08-25-publish-autonomy §4)",
        "trigger_netlify_build and deploy are never reachable from any node, including this one",
        "release_to_production is called at most once per (runId, requestId)",
        "Nothing is released when publish_executor did not commit a publish"
      ]
    },
    "modelConfig": {
      "maxTurns": 3,
      "toolCallLimit": 2,
      "timeout": 120000,
      "budgetUsd": 0.25,
      "maxOutputTokens": 2000
    }
  },
  {
    "id": "learning_recorder",
    "name": "Learning Recorder",
    "kind": "learning",
    "description": "Record structured workflow observations, including project artifact/rendering failures, and improvement candidates without mutating prompts or schemas automatically.",
    "prompt": "Objective: Record structured workflow observations, including project artifact/rendering failures, and improvement candidates without mutating prompts or schemas automatically.\nInputs expected: publication_controller, publish_executor and release_executor when the run reached them — publish_execution.v1 carries the executor/publish outcome (blocks, lock conflicts, a published-pending-release commit) and release_execution.v1 carries the release/go-live outcome (skipped, executed, or blocked verification) this node exists to observe, and a node refused at its own gate still leaves an observable blocked decision record. When publish_executor or release_executor never executed (refused upstream, or publishing happened outside node execution via workflow.publish_run), the missing input slot is simply absent — record what the run's terminal state shows instead of treating the absence as a blocker. On early termination (blocked or failed) this node fires directly with the run's terminal state.\nOutput required: produce learning_observations.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; stage.list_outputs returns bounded summaries (id, stage, size, preview) — record observations from those summaries and the run's terminal state, and do not try to read every stage in full. Do not publish or mutate external systems.\nMemory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "publish_executor",
      "release_executor"
    ],
    "produces": [
      "learning_observations.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "publication_controller",
      "publish_executor",
      "release_executor"
    ],
    "status": "active",
    "position": {
      "x": 560,
      "y": 540
    },
    "updatedAt": "2026-09-14T10:09:51.036Z",
    "metadata": {
      "approvalRequired": false,
      "learningRecorderDeterministic": true,
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
      "budgetUsd": 0.3,
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
  // T15.6 (ADR-2026-08-25-publish-autonomy §6.1) — article_body is mandatory for the canonical
  // Publishing Conductor sequence (the default `nodes` above), but NOT for every graph this function
  // validates: composeWorkflowNodes can compose the publish segment alone (capture/clone style, no
  // copy-authoring nodes at all), and validating THAT graph must not fail for lacking a node the
  // segment selector deliberately left out. So these two checks are conditional on article_body's
  // actual PRESENCE in the graph being validated, rather than unconditionally required — a graph that
  // composed the authoring segment still gets both checks; one that did not simply has nothing to check.
  const articleBody = nodes.find((node) => node.id === "article_body");
  if (articleBody && !articleBody.produces.includes("client_object.v1")) issues.push("article_body must produce client_object.v1");
  const publishPayload = nodes.find((node) => node.id === "publish_payload");
  if (publishPayload && articleBody && !publishPayload.dependsOn.includes("article_body")) issues.push("publish_payload must depend on article_body");
  const publicationController = nodes.find((node) => node.id === "publication_controller");
  if (publicationController && !publicationController.dependsOn.includes("publish_payload")) issues.push("publication_controller must depend on publish_payload");
  return issues.length ? { valid: false, issues } : { valid: true, issues: [] };
}
