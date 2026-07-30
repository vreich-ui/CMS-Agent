import type { WorkspaceNode, WorkspaceGraphValidation } from "./nodeTypes.js";

export const publishingConductorNodes = [
  {
    "id": "input_triage",
    "name": "CMS Input Triage",
    "kind": "intake",
    "description": "Clarify the publishing request, identify missing inputs, and establish the working content_source.v1 envelope.",
    "prompt": "Objective: Clarify the publishing request, identify missing inputs, and establish the working content_source.v1 envelope.\nInputs expected: user request and any supplied content_source.v1 envelope.\nOutput required: produce content_source.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-07-27T07:30:39.528Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "topic_opportunity",
    "name": "Topic Opportunity Agent",
    "kind": "strategy",
    "description": "Assess topic viability, audience value, search/editorial opportunity, and recommended positioning.",
    "prompt": "Objective: Decide whether the request should become an article, page section, content update, product/resource support asset, or no-build recommendation for the target client.\nInputs expected: input_triage, plus clientProjectId (the run's registered client) delivered in this node's input.\nOutput required: produce topic_opportunity.v1 with recommended content route, reader value, business value, SEO/search intent notes when relevant, evidence depth needed, and cost path.\nCost policy: choose the smallest workflow that can satisfy the request safely. Recommend deep research only for scientific, medical-adjacent, current, comparative, regulatory, or claim-heavy work. Recommend skipping redundant strategy passes when the request is simple.\nNext-step policy: prefer content that moves a reader toward a useful next step: related reading, newsletter, routine decision, product/resource consideration, or trust-building.\nClient policy: this node serves any registered client. clientProjectId names the target; the client's voice, audience, and commercial direction come from the client's own record and the run's inputs, never from this prompt. Treat a missing or unresolvable client identity as a blocker rather than assuming a client.\nCompletion criteria: the route, audience value, evidence need, and blockers are explicit.\nBlocker criteria: unclear target, missing or unresolvable target client, unsafe request, no viable reader value, missing critical input, or requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "workspace.get_node",
      "stage.get_output",
      "stage.list_outputs"
    ],
    "assignedSkills": [
      "seo_review"
    ],
    "requiredInputs": [
      "input_triage"
    ],
    "produces": [
      "topic_opportunity.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "input_triage"
    ],
    "status": "active",
    "position": {
      "x": 280,
      "y": 0
    },
    "updatedAt": "2026-07-30T17:29:47.040Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "reader_insight",
    "name": "Reader Insight Agent",
    "kind": "strategy",
    "description": "Define reader needs, motivations, sophistication, pains, desired outcomes, and decision context.",
    "prompt": "Objective: Define reader needs, motivations, sophistication, pains, desired outcomes, and decision context.\nInputs expected: topic_opportunity.\nOutput required: produce reader_insight.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-07-27T07:30:31.995Z",
    "metadata": {
      "externalStageMapping": "reader_insight",
      "approvalRequired": false
    }
  },
  {
    "id": "research",
    "name": "Research Agent",
    "kind": "research",
    "description": "Gather source-backed claims, evidence, examples, constraints, and open questions for the article.",
    "prompt": "Objective: Gather only the evidence needed to support the article's material claims, reader decisions, and the trust standard the target client's content must meet.\nInputs expected: reader_insight, plus clientProjectId (the run's registered client) delivered in this node's input.\nOutput required: produce research_brief.v1 with sourced facts, practical implications, claim risk notes, open questions, and source references.\nCost policy: do not browse by default. Use web.search/web.fetch only for claims that are scientific, medical-adjacent, current, comparative, regulatory, or otherwise source-sensitive. Prefer primary scientific, clinical, regulatory, or manufacturer/source-owner pages when available. Stop once reliable evidence covers the decision the article must help the reader make.\nEvidence policy: separate sourced facts, interpretation, uncertainty, and unsupported claims. Flag claims that should be softened or removed.\nCompletion criteria: required inputs are addressed, sources are concise and relevant, output matches schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unavailable evidence for important claims, unsafe medical certainty, contradictory instructions, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-07-30T17:29:57.342Z",
    "metadata": {
      "externalStageMapping": "research",
      "approvalRequired": false
    },
    "modelConfig": {
      "toolCallLimit": 12,
      "timeout": 180000,
      "retryCount": 1
    }
  },
  {
    "id": "objection_mapping",
    "name": "Objection Mapping Agent",
    "kind": "strategy",
    "description": "Map reader objections, skepticism, points of confusion, and trust gaps to address in the narrative.",
    "prompt": "Objective: Map reader objections, skepticism, points of confusion, and trust gaps to address in the narrative.\nInputs expected: research.\nOutput required: produce objection_map.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-07-27T07:30:37.183Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "narrative_movement",
    "name": "Narrative Movement Agent",
    "kind": "strategy",
    "description": "Design the article's reader journey, section movement, stakes, transitions, and resolution arc.",
    "prompt": "Objective: Design the article's reader journey, section movement, stakes, transitions, and resolution arc.\nInputs expected: objection_mapping.\nOutput required: produce narrative_movement.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-07-27T07:30:41.916Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "angle_strategy",
    "name": "Angle Strategist",
    "kind": "strategy",
    "description": "Select the strongest angle, promise, tension, differentiation, and external five-stage angle mapping.",
    "prompt": "Objective: Select the strongest angle, promise, tension, differentiation, and external five-stage angle mapping.\nInputs expected: narrative_movement.\nOutput required: produce angle_strategy.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-07-27T07:30:44.162Z",
    "metadata": {
      "externalStageMapping": "angle",
      "approvalRequired": false
    }
  },
  {
    "id": "brief_architect",
    "name": "Brief Architect",
    "kind": "planning",
    "description": "Convert strategy into an executable article brief with structure, claims, proof points, and acceptance criteria.",
    "prompt": "Objective: Convert upstream strategy and evidence into one executable article/content brief for the target client.\nInputs expected: angle_strategy, plus prior topic, reader, research, objection, and narrative outputs through stageOutputs, plus clientProjectId (the run's registered client) delivered in this node's input.\nOutput required: produce article_brief.v1 with title/slug direction, reader promise, article structure, claim/proof map, reader next step, SEO/meta notes, tone guardrails, acceptance criteria, and what to skip.\nCost policy: collapse duplicate strategy into this brief. Do not ask downstream agents to rediscover the angle. Include only sections, claims, and review needs that materially improve the article.\nNext-step policy: make the content useful first and commercially aware second. Add a low-pressure next step only where it fits the reader journey.\nClient policy: clientProjectId names the target client. Voice, styling, and audience direction belong to the client's own record and the run's inputs, never to this prompt; the brief's tone guardrails must come from those sources. Treat a missing or unresolvable client identity as a blocker rather than assuming a client.\nContract policy: note likely target object type, expected content-object fields, taxonomy needs, and whether contract_intelligence must inspect anything beyond the client's default object type.\nCompletion criteria: the draft writer can write without guessing; research and factual risks are visible; blockers are explicit.\nBlocker criteria: missing strategy, missing or unresolvable target client, missing evidence for required claims, unsafe medical certainty, unclear audience/action, or requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
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
          "const": "article_brief.v1"
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
      "article_structuring",
      "dr_lurie_dtc_science_editorial"
    ],
    "requiredInputs": [
      "angle_strategy"
    ],
    "produces": [
      "article_brief.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "angle_strategy"
    ],
    "status": "active",
    "position": {
      "x": 560,
      "y": 180
    },
    "updatedAt": "2026-07-30T17:30:08.679Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "draft_writer",
    "name": "Full Draft Writer",
    "kind": "drafting",
    "description": "Write a complete draft from the approved brief while preserving canonical structured artifacts over Markdown.",
    "prompt": "Objective: Write the complete reader-facing draft from article_brief.v1 in the target client's editorial voice.\nInputs expected: brief_architect, plus clientProjectId (the run's registered client) delivered in this node's input.\nVoice policy: the client's voice and styling direction come from the client's own record and the brief's tone guardrails, never from this prompt. If no client voice direction is supplied, write calm, precise, practical, evidence-led, reader-first prose and record the gap as an assumption. Never write in a client voice the input does not declare.\nOutput required: produce draft.v1 with proposed title, deck/description, slug candidate, section-by-section draft, source/claim notes, suggested CTA/next step, and unresolved questions.\nStyle policy: calm, precise, practical, evidence-led, and reader-first. Avoid hype, fear tactics, diagnosis, fake urgency, and unsupported medical certainty. Use concrete routine decisions, tradeoffs, and reassurance.\nStructure policy: write in a form that can be converted into the client's content-object nodes. Keep headings and paragraphs clean. Do not expose private strategy labels in reader-visible copy.\nCost policy: do not re-research; use the brief and research outputs. Mark evidence gaps instead of inventing support.\nCompletion criteria: the draft can be reviewed without major missing sections; claims are tied to research or flagged; blockers are explicit.\nBlocker criteria: missing brief, missing or unresolvable target client, missing evidence for required claims, unsafe medical certainty, unclear audience/action, or requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "dr_lurie_dtc_science_editorial"
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
    "updatedAt": "2026-07-30T17:30:20.538Z",
    "metadata": {
      "externalStageMapping": "draft",
      "approvalRequired": false
    },
    "modelConfig": {
      "timeout": 300000,
      "retryCount": 1
    }
  },
  {
    "id": "human_texture",
    "name": "Human Texture Editor",
    "kind": "review",
    "description": "Improve specificity, rhythm, voice, examples, and lived-in human texture without changing factual meaning.",
    "prompt": "Objective: Improve specificity, rhythm, voice, examples, and lived-in human texture without changing factual meaning.\nInputs expected: draft_writer.\nOutput required: produce human_texture_review.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "dr_lurie_dtc_science_editorial"
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
    "updatedAt": "2026-07-27T07:30:58.359Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "trust_factual",
    "name": "Trust / Factual Editor",
    "kind": "review",
    "description": "Check claims, citations, hedging, trust signals, factual risk, and unsupported assertions.",
    "prompt": "Objective: Check the draft for claim safety, citation sufficiency, hedging, reader trust, and the evidence standards the target client's content must meet.\nInputs expected: draft_writer and research.\nOutput required: produce trust_factual_review.v1 with claims to keep, soften, support, remove, or re-source; citation gaps; medical/compliance risk; and concise revision instructions.\nCost policy: use existing research first. Fetch only source URLs already cited or clearly necessary to resolve a material uncertainty. Do not run broad new research unless the draft contains an important unsupported claim.\nEvidence policy: distinguish sourced facts, interpretation, and uncertainty. Flag unsupported claims and overconfident medical language. Prefer softer practical phrasing when evidence is limited.\nCompletion criteria: factual risks are prioritized, actionable, and tied to the draft; blockers are explicit.\nBlocker criteria: missing draft, missing research for material claims, unavailable source evidence, unsafe medical certainty, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-07-30T17:30:32.380Z",
    "metadata": {
      "approvalRequired": false
    },
    "modelConfig": {
      "toolCallLimit": 8,
      "timeout": 120000,
      "retryCount": 1
    }
  },
  {
    "id": "emotional_resonance",
    "name": "Emotional Resonance Evaluator",
    "kind": "review",
    "description": "Evaluate emotional clarity, stakes, empathy, reader momentum, and resonance with the intended audience.",
    "prompt": "Objective: Evaluate emotional clarity, stakes, empathy, reader momentum, and resonance with the intended audience.\nInputs expected: draft_writer.\nOutput required: produce emotional_resonance_review.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "dr_lurie_dtc_science_editorial"
    ],
    "requiredInputs": [
      "draft_writer",
      "input_triage"
    ],
    "produces": [
      "emotional_resonance_review.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "draft_writer",
      "input_triage"
    ],
    "status": "active",
    "position": {
      "x": 280,
      "y": 360
    },
    "updatedAt": "2026-07-27T07:31:03.530Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "reader_simulation",
    "name": "Reader Simulation",
    "kind": "review",
    "description": "Simulate likely reader reactions, drop-off points, questions, objections, and conversion readiness.",
    "prompt": "Objective: Simulate likely reader reactions, drop-off points, questions, objections, and conversion readiness.\nInputs expected: draft_writer.\nOutput required: produce reader_simulation.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "draft_writer"
    ],
    "produces": [
      "reader_simulation.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "draft_writer"
    ],
    "status": "active",
    "position": {
      "x": 560,
      "y": 360
    },
    "updatedAt": "2026-07-27T07:31:05.878Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "review_aggregator",
    "name": "Review Aggregator",
    "kind": "review",
    "description": "Combine parallel reviews into prioritized revisions, unresolved conflicts, and final build instructions.",
    "prompt": "Objective: Combine parallel reviews into prioritized revisions, unresolved conflicts, and final build instructions.\nInputs expected: human_texture, trust_factual, emotional_resonance, reader_simulation.\nOutput required: produce review_aggregation.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-07-27T07:31:08.168Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "contract_intelligence",
    "name": "Contract Intelligence Agent",
    "kind": "research",
    "description": "Fetch the target client's live object contract at runtime and reduce it to the rules downstream nodes must obey. The client contract is the single source of truth; never author content rules from memory or from a workspace-local copy.",
    "prompt": "Objective: Turn the target client's ALREADY-FETCHED, ALREADY-REDUCED object contract into contract_intelligence.v1, the rules every downstream node must obey. The client's contract is the single source of truth for content shape, ids, media paths, taxonomy, and publishing gates. Never author these rules from memory, from a workspace-local schema, or from another client's contract.\nInputs expected: article_brief, plus clientProjectId (the run's registered client — the conductor delivers it in every node's input; never guess it and never substitute a remembered client) and `prefetchedContract` supplied directly in your input — the conductor calls the client's contract surface deterministically, in code, BEFORE you run, and reduces it (dropping prose, examples, and error catalogues) precisely so you never have to fetch or carry the raw multi-KB contract yourself across your own turns. `prefetchedContract` carries: clientObjectType, bodySchema (the real JSON Schema, kept whole — it is structural, not prose), idConventions, mediaConvention, taxonomy, constraints (with severity and enforcedLive), publishPolicy, workflowSequence, validationSurface (patch/write operations with their required fields), contractSource {tool, fetchedAtISO}, and an `unmapped` bucket for anything the deterministic reduction did not recognize but preserved anyway.\nIf `prefetchedContract` is present: this is a validation and pass-through step, not a discovery one. Sanity-check it, write a concise summary, carry its fields into your own output verbatim (mapping field names as needed — see Output required), and surface anything in `unmapped` worth downstream attention. Do not call project.call_read_tool to re-fetch the primary contract — it has already been fetched this run. Reach for project.call_read_tool ONLY for something genuinely missing from the prefetch (e.g. a registry/taxonomy lookup the client's contract pointed at but did not inline, or the client's own contract tool for a DIFFERENT object type than what was prefetched) — it needs no approval and only reaches read operations (object_contract, registry_get, object_inventory, object_get, object_list, object_validate, ping); reserve project.call_tool for a genuine write, which this node does not perform.\nIf `prefetchError` is present instead (the deterministic fetch failed — unreachable client, policy block, unsupported object type): treat it exactly as the unreachable-client blocker criterion below; do not attempt to fetch the contract yourself as a substitute unless prefetchedContract is entirely absent from your input (an older run/deployment that never wired the prefetch), in which case fall back to the discovery policy your allowedTools describe.\nOutput required: produce contract_intelligence.v1 carrying, at minimum: clientProjectId (from your own input's clientProjectId — the run's registered client), clientObjectType, bodySchema (from prefetchedContract.bodySchema, or your own reduction of a fetched contract, verbatim — never the full raw contract re-derived, so the large fetched payload does not compound across turns nor get carried whole into every downstream node's input), the id conventions (object id and node/child id patterns, from prefetchedContract.idConventions), the media/artifact path convention (raw artifact reference field vs public serving path, and which fields accept which, from prefetchedContract.mediaConvention), the taxonomy source and whether unknown terms block (from prefetchedContract.taxonomy), the enumerated structural constraints with their severity and whether each is enforced live (from prefetchedContract.constraints), the publish policy including whether approval is required and any pinning rules (from prefetchedContract.publishPolicy), and contractSource {tool, fetchedAtISO} (from prefetchedContract.contractSource, or your own fetch's).\nGeneralization policy: this node must work for ANY client the workflow encounters, not one named client. Do not hardcode a client's field names, path prefixes, or object types into your reasoning; read them from prefetchedContract (or the contract you fetched) and pass them forward as data. Where a client's contract is silent, say so explicitly as an assumption rather than filling the gap from another client's conventions.\nCompletion criteria: a downstream node can construct and validate a client object using only your output plus the client's own validator, without guessing and without consulting any workspace-local schema.\nBlocker criteria: the client project is unreachable or unconfigured, clientProjectId is missing from your input, its contract tools are unavailable or denied by policy, the requested object type is unsupported, the contract cannot be fetched read-only, or the contract declares constraints this workspace cannot satisfy.\nTool policy: use only allowedTools; reach the client only through project.call_read_tool and only with its permitted read-only contract, registry, inventory, and validation operations, and only for what prefetchedContract does not already supply; project.call_tool is also granted for a future write but this node must never publish, create, patch, or otherwise mutate the client.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; never persist secrets, storage grants, raw authorization headers, or tokens.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
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
      "dr_lurie_contract_intelligence"
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
    "updatedAt": "2026-07-30T17:31:05.118Z",
    "metadata": {
      "approvalRequired": false,
      "contractPrefetch": true
    },
    "modelConfig": {
      "maxTurns": 8,
      "toolCallLimit": 5,
      "timeout": 180000,
      "retryCount": 1
    }
  },
  {
    "id": "article_body",
    "name": "Article Body Builder",
    "kind": "builder",
    "description": "Build the client's content object in the client's own shape, using the contract fetched at runtime by contract_intelligence. The client contract is the only source of truth; no workspace-local content schema is authoritative.",
    "prompt": "Objective: Build the target client's content object in the CLIENT'S OWN SHAPE, using the contract that contract_intelligence fetched at runtime. Emit it as the body field of this node's output envelope.\nSource of truth: the client's fetched contract is the ONLY authoritative content schema. Never build to a workspace-local article schema, never build from memory of a previous client, and never treat a workspace validator's verdict as authoritative. If contract_intelligence did not supply a contract with contractSource provenance, that is a blocker — do not proceed on assumption.\nInputs expected: review_aggregator (the approved editorial content), contract_intelligence (the client contract), narrative_movement (the reader-journey arc: section movement, stakes, transitions, resolution) and angle_strategy (the chosen angle, promise, and tension) — the upstream editorial reasoning your per-node private annotations are built from. clientProjectId also arrives directly in this node's input from the conductor and must agree with contract_intelligence's clientProjectId; if they disagree, that is a blocker. Carry clientProjectId, clientObjectType and contractSource straight through from contract_intelligence into your output.\nBody construction policy: shape body exactly to the contract's body schema — its required fields, its field names, its id patterns, its enums, and its strictness. If the contract's schema is strict (additionalProperties false), emit no field it does not declare, including workspace-only fields such as a schema version marker. Root the client's fields where the contract roots them. Where the contract offers a richer representation than plain text (for example a structured rich-text grammar), prefer it only if the contract declares it and you can satisfy its grammar; otherwise use the simplest representation the contract accepts and note the choice.\nPrivate annotation policy: where the contract's body schema declares per-node private annotation fields (for example a private block with closed strategy/intent enums and a free-text notes field), populate them on EVERY node you emit — an absent private annotation is a defect, not a default. Choose each enum value ONLY from the enum the contract itself declares — never invent, pluralize, or approximate a value — mapping each node's role in the piece from narrative_movement's arc and angle_strategy's angle/promise plus review_aggregator's build instructions, and put the one-sentence reasoning for the choice in the contract's free-text private notes field. If narrative_movement or angle_strategy outputs are absent or skipped (for example a late-stage entry run), derive the annotation from the approved content itself and record that as an assumption. Private annotation is never reader-visible — the contract's renderer emits public fields only — so annotate every node rather than leaving private fields absent. If the contract declares no private annotation fields for this object type, note that instead; never add undeclared fields.\nMedia policy: read the media convention from the contract rather than assuming one. Distinguish the fields that accept a RAW artifact reference from the fields that are RENDERED, and put the right form in each: rendered fields take the client's public serving path, raw reference fields take the artifact key. If the contract states that raw keys are rejected in rendered fields, honor that — a raw key in a rendered field is a build-breaking error, not a cosmetic one. Only reference artifacts that were materialized for the CURRENT request and verified by the artifact tool; pattern-valid keys are not proof. Never use remote URLs, data URIs, repo paths, hand-authored keys, or references copied from another request or another slug. Respect the client's media budget and preferred format when the contract or storage grant declares them. Honor any placement or rendering metadata the contract requires for reader-visible media — omitting it can silently drop the media from the published page.\nClient validation policy: before completing, validate through the CLIENT's own validator via project.call_read_tool, read-only, and record the outcome in clientValidation {tool, valid, issues}. project.call_read_tool needs NO approval and is the correct surface for validation; do not use project.call_tool for reads, and do not report yourself blocked because project.call_tool is unavailable — that tool is deliberately approval-gated for writes only. If the client's validator requires an existing object record that does not yet exist, do NOT attempt to create one — this node is write-prohibited. Record clientValidation {attempted: true, tool, valid: false, deferred: \"requires_existing_object\"} quoting the client's own refusal in issues, and treat that as a NORMAL outcome, not a blocker: the authoritative validation runs in the publish executor after object_create and before any patch. Do not claim validity, and do not spend further calls re-attempting once the client has reported the object does not exist. If the client cannot be reached or its read-only validator is denied by the project's own policy, set clientValidation.attempted false, add a blocker, and do not claim validity.\nReader-safety policy: reader-visible strings must never leak strategy labels, prompts, scoring, internal notes, or workflow vocabulary. Put internal annotation only in the private/internal fields the contract designates. Follow the contract's id rules, including any prohibition on ids that reveal intent.\nCompletion criteria: body satisfies the client's contract as fetched; contract-declared private annotation fields are populated on every emitted node (or the contract's silence on them is noted); every media reference is verified and in the correct form for its field; clientValidation records a real result from the client, or a deferral because the validator requires an object that does not yet exist; assumptions and blockers are explicit.\nBlocker criteria: no contract or no contractSource provenance; the client is unreachable or unconfigured; clientProjectId is missing from this node's input or disagrees with contract_intelligence's; required contract fields cannot be satisfied from the approved content; taxonomy terms do not resolve and the contract blocks unknown terms; media is missing, unverified, or cannot be expressed in the form the contract demands; or the contract declares a constraint this workspace cannot meet.\nTool policy: use only allowedTools; reach the client through project.call_read_tool for every read-only contract and validation operation; project.call_tool is approval-gated and reserved for writes — never create, patch, publish, or release from this node.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; never persist secrets, storage grants, raw authorization headers, or tokens.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
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
          "const": "article_body.v1"
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
          "const": "article_body.v1"
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
      "dr_lurie_contract_intelligence"
    ],
    "requiredInputs": [
      "review_aggregator",
      "contract_intelligence",
      "narrative_movement",
      "angle_strategy"
    ],
    "produces": [
      "article_body.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "review_aggregator",
      "contract_intelligence",
      "narrative_movement",
      "angle_strategy"
    ],
    "status": "active",
    "position": {
      "x": 1120,
      "y": 360
    },
    "updatedAt": "2026-07-30T17:32:19.737Z",
    "metadata": {
      "approvalRequired": false,
      "externalStageMapping": "final_article",
      "canonicalRules": [
        "The client's fetched contract is the only authoritative content schema",
        "body must be emitted in the client's own object shape, not a workspace shape",
        "Renderable media fields carry the client's public path; raw artifact keys only in the client's designated reference fields",
        "Workspace-local article schemas are advisory and must never be used to validate"
      ]
    }
  },
  {
    "id": "artifact_plan",
    "name": "Artifact Planning Agent",
    "kind": "adapter",
    "description": "Plan and verify media/artifact requirements against the client's declared artifact protocol and id conventions. No legacy fallbacks, no unverified media.",
    "prompt": "Objective: Plan and verify every media/artifact need for the client-shaped body produced by article_body, using only the artifact protocol the client's contract declares.\nSource of truth: the client's fetched contract declares the artifact protocol, the request-id convention, the media path rules, and the media budget. Read them from contract_intelligence rather than assuming. Carry clientProjectId, clientObjectType and contractSource forward.\nInputs expected: article_body (client-shaped body plus its artifact references).\nRequest id policy: derive the requestId from the CLIENT's id convention, record that convention in requestIdConvention, and confirm the id is acceptable to the client before any artifact is written. An artifact generator may accept a laxer id than the client's index does; writing under a non-conforming id creates an artifact the client can never list, reconcile, or delete. If the id cannot be confirmed, mark slots blocked rather than materializing.\nArtifact protocol policy: the client's declared protocol is the only valid transfer path. Media must be represented by references the protocol produced for the CURRENT request. Never use repo paths, remote URLs, data URIs, direct-save fallbacks, references copied from another request or slug, or hand-authored keys.\nMaterialization policy: never mark a slot has_trusted_artifact because a key merely matches a pattern. Trust requires verification evidence from the artifact service that the reference was materialized for this request, with matching key, digest, content type, size and timestamp — record it in the slot's verification field. Where the artifact service offers an explicit verification tool, use it and keep its proof. Absent verification, pending or timed-out approval, or a synthetic reference means status needs_generation or blocked, plus a blocker.\nPublic path policy: when the contract distinguishes a raw artifact reference from a rendered public path, resolve and record both — the raw reference for the client's reference fields and publicPath for its rendered fields. Do not hand-author a public path the contract did not define.\nMedia budget policy: honor the client's declared image budget and preferred format. If an artifact exceeds the budget, follow the client's over-budget rule — flag it when the policy warns, block it when the policy blocks, and prefer asking the artifact service to re-encode within budget over shipping an oversize asset.\nCapability policy: if the artifact service's required capabilities are not permitted by the registered project policy, do not attempt generation. Emit blockers naming the exact missing capabilities in requiredArtifactCapabilities and the slots that need them.\nApproval/resume policy: if generation or verification needs operator approval and it is unavailable or times out, never invent a pointer. Emit a blocker carrying requestId, slotId, the required capability, and the pending action so the run can resume safely.\nCompletion criteria: every desired slot is either bound to a verified current-request artifact with its correct raw and public forms, or explicitly blocked with the missing capability, approval, or verification reason. No unverified media passes downstream.\nBlocker criteria: missing body; missing or unconfirmable request id; unreachable client or artifact service; missing storage grant path; denied capabilities; unverified materialization; approval timeout; over-budget media under a blocking policy; or any request to use a legacy fallback.\nTool policy: use only allowedTools. Reach external services only through project.call_tool. Read-only policy and status lookups are allowed; do not publish, release, or mutate the client from this node.\nMemory policy: save only this node's structured output; never persist storage grants, tokens, raw authorization headers, or scoped upload credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "artifact",
        "summary",
        "clientProjectId",
        "clientObjectType",
        "artifactProtocol",
        "media_slots"
      ],
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
        "artifactProtocol",
        "media_slots"
      ],
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
      "dr_lurie_contract_intelligence"
    ],
    "requiredInputs": [
      "article_body"
    ],
    "produces": [
      "artifact_plan.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "article_body"
    ],
    "status": "active",
    "position": {
      "x": 1120,
      "y": 1500
    },
    "updatedAt": "2026-07-29T17:16:31.618Z",
    "metadata": {
      "approvalRequired": false,
      "projectId": "pdf-tool",
      "canonicalRules": [
        "The client's contract declares the artifact protocol, id convention and media path rules",
        "A pattern-valid key is never proof of materialization",
        "Request ids must satisfy the client's convention before any artifact is written",
        "No legacy artifact fallback systems"
      ]
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
      "dr_lurie_contract_intelligence"
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
    "updatedAt": "2026-07-29T17:18:17.046Z",
    "metadata": {
      "approvalRequired": false,
      "canonicalRules": [
        "Consumes the client-shaped body from article_body",
        "Produces a dry-run candidate only, never a publish",
        "Client validation evidence is required; a workspace verdict is not sufficient",
        "Artifact references must be verified for the current request"
      ]
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
        "summary"
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
          "const": "publication_decision.v1"
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
      "stage.save_output",
      "stage.list_outputs",
      "project.call_tool"
    ],
    "assignedSkills": [
      "dr_lurie_contract_intelligence"
    ],
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
    "updatedAt": "2026-07-29T14:38:32.892Z",
    "metadata": {
      "approvalRequired": true,
      "projectPolicyNotes": [
        "Do not publish yet",
        "Validate the target project's artifact-reference and raw-image-URL rules before future publishing"
      ]
    }
  },
  {
    "id": "learning_recorder",
    "name": "Learning Recorder",
    "kind": "learning",
    "description": "Record structured workflow observations, including project artifact/rendering failures, and improvement candidates without mutating prompts or schemas automatically.",
    "prompt": "Objective: Record structured workflow observations, including project artifact/rendering failures, and improvement candidates without mutating prompts or schemas automatically.\nInputs expected: publication_controller.\nOutput required: produce learning_observations.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "publication_controller"
    ],
    "produces": [
      "learning_observations.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "publication_controller"
    ],
    "status": "active",
    "position": {
      "x": 560,
      "y": 540
    },
    "updatedAt": "2026-07-30T16:52:20.699Z",
    "metadata": {
      "approvalRequired": false,
      "recordFailureTypes": [
        "artifact_reference_missing",
        "raw_image_artifact_public_url",
        "image_rendering_placement_missing"
      ]
    },
    "modelConfig": {
      "timeout": 300000
    }
  },
  {
    "id": "publish_executor",
    "name": "Publish Executor",
    "kind": "publisher",
    "description": "Draft execution node for approval-gated publishing to any client. Follows the publish sequence, lock discipline and pin rules the client's contract declares. Remains draft until the runner and project policy support safe live execution.",
    "prompt": "Objective: Execute an approved publish against the target client, only after explicit approval and only when project policy enables live publish tools. This node stays DRAFT until the runner and project policy support safe live execution.\nSource of truth: the client's fetched contract declares the publish sequence, the lock and version discipline, the approval pin rules, the valid publication actions, the release/build behaviours, and the error codes. Read them from contractSource carried through publication_controller. Never execute a sequence remembered from another client or hardcoded here. Missing contract provenance is a hard block.\nInputs expected: publication_controller.\nOutput required when activated: publish_execution.v1 with the exact approved action, the client object and request id, the artifact set, the publish result, the release/build status, and the verification performed.\nContent path policy: the only valid content is the client-shaped object the contract declares. Refuse Markdown, prose blobs, repo files, or any representation the contract does not declare.\nArtifact policy: every media reference must be a verified current-request artifact under the protocol the contract names, with matching key, digest, content type, size and timestamp. A pattern-valid key is not proof. Refuse repo paths, remote URLs, data URIs, copied references, hand-authored keys, and any unverified reference that merely looks well-formed. If verification is absent, stale, partial, timed out, or belongs to another request, block.\nRendered vs raw policy: put the client's public serving path in rendered fields and the raw artifact key only in the fields the contract designates for references. Where the contract warns that a raw key in a rendered field breaks the build, treat that as a hard block, never a warning.\nApproval policy: execute only when the decision record carries explicit approval matching the exact object, request, artifact set, publication action and release behaviour. Honour the contract's pin rules literally — where an approval is pinned to a specific action or revision, a mismatch or a stale pin is a block. Absent, partial, or superseded approval is a block.\nSequence policy: follow the contract's declared workflow in order, including its checkout/validate/patch/publish/checkin discipline and its lock and expected-version rules. Dry-run validate before mutating. Surface the contract's own error codes rather than reinterpreting them: a lock conflict means re-acquire, a version conflict means re-read, never force.\nPublish vs release policy: treat publishing and going live as separate gates whenever the contract separates them. Where publish commits without deploying and a distinct release performs the build, do not trigger a release unless it was explicitly approved — a release may deploy every accumulated pending publish at once. After any release, confirm go-live is real: a production-confirmed deploy of the target commit, then page and media verification. A queued or ready-but-undeployed build is not live.\nCompletion criteria when active: the action exactly matches the approval; content and artifacts are verified; the sequence followed the contract; the release matches the approved behaviour; the result and go-live confirmation are recorded; no unapproved release or build was triggered.\nBlocker criteria: draft status; missing contract provenance; disabled project publishing policy; missing, stale, partial or mismatched approval; missing artifact verification; unresolved taxonomy where the contract blocks unknown terms; lock or version conflicts; runner idempotency doubt; unavailable publish or release tools; content outside the client's declared shape; or non-protocol artifact references.\nTool policy: while draft, do not call project tools at all. When activated, reach the client only through explicitly allowed publish, release and verification tools, and never bypass project policy.\nMemory policy: never expose or persist secrets, raw authorization headers, storage grants, scoped upload tokens, or blob credentials.\nOutput formatting policy: return one JSON object that directly matches this node's output schema. Do not wrap the object in actual, output, data, result, markdown, or prose.",
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
          "type": "boolean"
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
          "type": "boolean"
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
    "assignedSkills": [
      "dr_lurie_contract_intelligence"
    ],
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
    "status": "draft",
    "position": {
      "x": 560,
      "y": 1600
    },
    "updatedAt": "2026-07-29T14:38:32.053Z",
    "metadata": {
      "activationRequired": true,
      "approvalRequired": true,
      "canonicalRules": [
        "The client's contract declares the publish sequence, lock discipline and approval pin rules",
        "Publish and release are separate gates",
        "Only verified current-request artifacts may be published",
        "No legacy fallback systems"
      ]
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

export function validateWorkspaceGraph(nodes: WorkspaceNode[] = publishingConductorNodes): WorkspaceGraphValidation {
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
  const articleBody = nodes.find((node) => node.id === "article_body");
  if (!articleBody) issues.push("Missing article_body node");
  if (articleBody && !articleBody.produces.includes("article_body.v1")) issues.push("article_body must produce article_body.v1");
  const publishPayload = nodes.find((node) => node.id === "publish_payload");
  if (publishPayload && !publishPayload.dependsOn.includes("article_body")) issues.push("publish_payload must depend on article_body");
  const publicationController = nodes.find((node) => node.id === "publication_controller");
  if (publicationController && !publicationController.dependsOn.includes("publish_payload")) issues.push("publication_controller must depend on publish_payload");
  return issues.length ? { valid: false, issues } : { valid: true, issues: [] };
}

