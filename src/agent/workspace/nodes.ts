import type { WorkspaceNode, WorkspaceGraphValidation } from "./nodeTypes.js";

export const publishingConductorNodes = [
  {
    "id": "input_triage",
    "name": "Publishing Input Triage",
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
      "stage.save_output",
      "stage.list_outputs"
    ],
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
      "x": 0,
      "y": 0
    },
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "topic_opportunity",
    "name": "Topic Opportunity Agent",
    "kind": "strategy",
    "description": "Assess topic viability, audience value, search/editorial opportunity, and recommended positioning.",
    "prompt": "Objective: Assess topic viability, audience value, search/editorial opportunity, and recommended positioning.\nInputs expected: input_triage.\nOutput required: produce topic_opportunity.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "stage.save_output",
      "stage.list_outputs"
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
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
      "stage.save_output",
      "stage.list_outputs"
    ],
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
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
    "prompt": "Objective: Gather source-backed claims, evidence, examples, constraints, and open questions for the article.\nInputs expected: reader_insight.\nOutput required: produce research_brief.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "stage.save_output",
      "stage.list_outputs"
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "externalStageMapping": "research",
      "approvalRequired": false
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
      "stage.save_output",
      "stage.list_outputs"
    ],
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
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
      "stage.save_output",
      "stage.list_outputs"
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
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
      "stage.save_output",
      "stage.list_outputs"
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
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
    "prompt": "Objective: Convert strategy into an executable article brief with structure, claims, proof points, and acceptance criteria.\nInputs expected: angle_strategy.\nOutput required: produce article_brief.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "stage.save_output",
      "stage.list_outputs"
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "draft_writer",
    "name": "Full Draft Writer",
    "kind": "drafting",
    "description": "Write a complete draft from the approved brief while preserving canonical structured artifacts over Markdown.",
    "prompt": "Objective: Write a complete draft from the approved brief while preserving canonical structured artifacts over Markdown.\nInputs expected: brief_architect.\nOutput required: produce draft.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "stage.save_output",
      "stage.list_outputs"
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "externalStageMapping": "draft",
      "approvalRequired": false
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
      "stage.save_output",
      "stage.list_outputs"
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "trust_factual",
    "name": "Trust / Factual Editor",
    "kind": "review",
    "description": "Check claims, citations, hedging, trust signals, factual risk, and unsupported assertions.",
    "prompt": "Objective: Check claims, citations, hedging, trust signals, factual risk, and unsupported assertions.\nInputs expected: draft_writer.\nOutput required: produce trust_factual_review.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "stage.save_output",
      "stage.list_outputs"
    ],
    "requiredInputs": [
      "draft_writer"
    ],
    "produces": [
      "trust_factual_review.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "draft_writer"
    ],
    "status": "active",
    "position": {
      "x": 0,
      "y": 360
    },
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "approvalRequired": false
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
      "stage.save_output",
      "stage.list_outputs"
    ],
    "requiredInputs": [
      "draft_writer"
    ],
    "produces": [
      "emotional_resonance_review.v1"
    ],
    "riskLevel": "read",
    "dependsOn": [
      "draft_writer"
    ],
    "status": "active",
    "position": {
      "x": 280,
      "y": 360
    },
    "updatedAt": "2026-07-03T00:00:00.000Z",
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
      "stage.save_output",
      "stage.list_outputs"
    ],
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
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
      "stage.save_output",
      "stage.list_outputs"
    ],
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "approvalRequired": false
    }
  },
  {
    "id": "article_body",
    "name": "Article Body Builder",
    "kind": "builder",
    "description": "Build canonical article_body.v1 structured article content. Markdown is not canonical and is only a render/export adapter.",
    "prompt": "Objective: Build canonical article_body.v1 structured article content. Markdown is not canonical and is only a render/export adapter. Reader-visible image nodes must specify rendering.placement, normally 'inline'.\nInputs expected: review_aggregator.\nOutput required: produce article_body.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
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
          "const": "article_body.v1"
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
      "stage.list_outputs"
    ],
    "requiredInputs": [
      "review_aggregator"
    ],
    "produces": [
      "article_body.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "review_aggregator"
    ],
    "status": "active",
    "position": {
      "x": 1120,
      "y": 360
    },
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "externalStageMapping": "final_article",
      "canonicalRules": [
        "article_body.v1 is canonical article content",
        "Markdown is only a render/export adapter",
        "Reader-visible image nodes require rendering.placement"
      ],
      "approvalRequired": false
    }
  },
  {
    "id": "publish_payload",
    "name": "Publish Payload Builder",
    "kind": "adapter",
    "description": "Create a dry-run adapter-only payload from article_body.v1 for future project publishing backends; preserve artifactReferences; Markdown is adapter/export only; do not publish.",
    "prompt": "Objective: Create a dry-run adapter-only payload from article_body.v1 for future project publishing backends; preserve artifactReferences; Markdown is adapter/export only; do not publish.\nInputs expected: article_body.\nOutput required: produce dry_run_publish_payload.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
    "schema": {
      "type": "object",
      "required": [
        "artifact",
        "summary"
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
          "const": "dry_run_publish_payload.v1"
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
      "stage.save_output",
      "publish.build_payload",
      "publish.validate_payload"
    ],
    "requiredInputs": [
      "article_body"
    ],
    "produces": [
      "dry_run_publish_payload.v1"
    ],
    "riskLevel": "write",
    "dependsOn": [
      "article_body"
    ],
    "status": "active",
    "position": {
      "x": 0,
      "y": 540
    },
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "canonicalRules": [
        "Consumes article_body.v1",
        "Produces dry-run adapter payload only",
        "Must preserve artifactReferences",
        "Markdown is adapter/export only"
      ],
      "approvalRequired": false
    }
  },
  {
    "id": "publication_controller",
    "name": "Publication Controller",
    "kind": "controller",
    "description": "Prepare an auditable publication decision record for future explicit approval; do not publish yet; validate Dr. Lurie artifact rules before any future publishing; do not call publishing tools in this workspace.",
    "prompt": "Objective: Prepare an auditable publication decision record for future explicit approval; do not publish yet; validate Dr. Lurie artifact rules before any future publishing; do not call publishing tools in this workspace.\nInputs expected: publish_payload.\nOutput required: produce publication_decision.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
      "stage.list_outputs"
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "approvalRequired": true,
      "drLuriePolicy": [
        "Do not publish yet",
        "Validate artifactReferences and raw image artifact URL rules before future publishing"
      ]
    }
  },
  {
    "id": "learning_recorder",
    "name": "Learning Recorder",
    "kind": "learning",
    "description": "Record structured workflow observations, including Dr. Lurie artifact/rendering failures, and improvement candidates without mutating prompts or schemas automatically.",
    "prompt": "Objective: Record structured workflow observations, including Dr. Lurie artifact/rendering failures, and improvement candidates without mutating prompts or schemas automatically.\nInputs expected: publication_controller.\nOutput required: produce learning_observations.v1 with concise rationale, assumptions, and unresolved questions.\nCompletion criteria: required inputs are addressed, output matches the node schemas, dependencies are respected, and blockers are explicit.\nBlocker criteria: missing critical input, unsafe or contradictory instructions, unavailable evidence for factual claims, or a requested side effect outside this node's policy.\nTool policy: use only allowedTools; prefer read-only workspace/stage tools; do not publish or mutate external systems.\nMemory policy: read relevant stage outputs and learning observations when useful; save only this node's structured output; do not expose secrets or raw authorization headers.",
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
    "updatedAt": "2026-07-03T00:00:00.000Z",
    "metadata": {
      "approvalRequired": false,
      "recordFailureTypes": [
        "artifact_reference_missing",
        "raw_image_artifact_public_url",
        "image_rendering_placement_missing"
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
// grid position (top-to-bottom by y, then left-to-right by x), then canonical Publishing Conductor
// index, then original insertion order (stable). Prompt/schema edits, storage insertion order, and
// updatedAt never affect the result. Nodes with neither a position nor a canonical entry are kept in
// their original relative order at the end.
export function sortWorkspaceNodes<T extends SortableWorkspaceNode>(nodes: T[]): T[] {
  return nodes
    .map((node, index) => ({ node, index, position: effectivePosition(node) }))
    .sort((a, b) => {
      if (a.position && b.position) {
        if (a.position.y !== b.position.y) return a.position.y - b.position.y;
        if (a.position.x !== b.position.x) return a.position.x - b.position.x;
      } else if (a.position || b.position) {
        return a.position ? -1 : 1;
      }
      const aIndex = canonicalNodeById.get(a.node.id)?.index ?? Number.POSITIVE_INFINITY;
      const bIndex = canonicalNodeById.get(b.node.id)?.index ?? Number.POSITIVE_INFINITY;
      if (aIndex !== bIndex) return aIndex - bIndex;
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

