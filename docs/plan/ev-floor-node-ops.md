# EV-floor node ops — `monetization_strategy` (2026-09-08)

Store operations for the EV-floor repair. Apply with:

```
npm run nodes:apply -- docs/plan/ev-floor-node-ops.md              # dry run
WORKSPACE_STORE=gcs GCS_BUCKET=cms-agent-503015-cms-agent-state \
  npm run nodes:apply -- docs/plan/ev-floor-node-ops.md --write    # apply
```

Then `npm run nodes:update` to bring `src/agent/workspace/nodes.ts` back in sync with the store, and
commit that regeneration. The code half of this change (`costPrefetch.ts`, `runCostHistory.ts`, the
`ev_floor_blocked` predicate and its run halt) takes effect on DEPLOY and is independent of these ops:
without them the prefetched figure still reaches the node's input and the predicate still fails open,
the model just is not told to copy the tool's artifact.

## Why

`monetization_strategy` emitted `estimatedRunCost: 800` on run `run_1788769566432_5qnafb` against a
measured $3.86, then required $1,000 of expected value before any article could clear the floor. The
cost figure is now derived from measured history and delivered in the node's input; these ops tell the
node to use it, and declare the `evFloor` field the conductor's `ev_floor_blocked` predicate reads.

### 1. `workspace_update_node_input_schema` — node `monetization_strategy`

Declares the conductor-prefetched `runCostEstimate` at the TOP LEVEL of the node's input, where the
prompt tells the model to read it. (`additionalProperties: true` already let the value through; the
declaration is what makes it visible to the model rather than an undocumented extra key.)

```json
{
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
      "description": "run_cost_estimate.v1, prefetched by the conductor (costPrefetch.ts) before this node's agent loop starts: the MEASURED p50 of this workflow's prior run totals from the node timing ledger, this run's own partial spend excluded. This is the run-cost figure \u2014 the node never authors one.",
      "properties": {
        "artifact": {
          "const": "run_cost_estimate.v1"
        },
        "estimatedRunCostUsd": {
          "type": "number"
        },
        "basis": {
          "type": "string",
          "enum": [
            "workflow_history",
            "no_history"
          ]
        },
        "sampleRuns": {
          "type": "number"
        },
        "sampleRecords": {
          "type": "number"
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
    }
  }
}
```

### 2. `workspace_update_node_output_schema` — node `monetization_strategy`

Adds `evFloor` — the verbatim `ev_floor.v1` artifact. Deliberately NOT in `required`: a run whose
monetizer is unreachable must still be able to complete this node, and an absent floor fails open at
the predicate.

```json
{
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
    "evFloor": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": true,
      "description": "The ev_floor.v1 artifact returned by monetize.ev_floor, copied VERBATIM \u2014 never re-derived, re-rounded or re-reasoned. The conductor's `ev_floor_blocked` predicate reads verdict and estimateBasis off this field at brief_architect's pre-dispatch: verdict \"block\" WITH estimateBasis \"monetizer_data\" halts the run before the expensive post-brief chain; every other basis is advisory and the run proceeds. null or absent means no floor was computed, which also proceeds.",
      "properties": {
        "artifact": {
          "const": "ev_floor.v1"
        },
        "runCostUsd": {
          "type": "number"
        },
        "runCostBasis": {
          "type": "string",
          "enum": [
            "workflow_history",
            "accrued_run_cost",
            "caller_override",
            "no_history"
          ]
        },
        "floorMultiplier": {
          "type": "number"
        },
        "floorUsd": {
          "type": "number"
        },
        "expectedValueUsd": {
          "type": [
            "number",
            "null"
          ]
        },
        "breakEvenConversions": {
          "type": [
            "number",
            "null"
          ]
        },
        "meetsFloor": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "revenueBasis": {
          "type": "string",
          "enum": [
            "monetizer_data",
            "stated_assumption"
          ]
        },
        "estimateBasis": {
          "type": "string",
          "enum": [
            "monetizer_data",
            "mixed",
            "stated_assumption"
          ]
        },
        "verdict": {
          "type": "string",
          "enum": [
            "proceed",
            "block",
            "unknown"
          ]
        },
        "rationale": {
          "type": "string"
        }
      }
    },
    "notes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```

### 3. `workspace_update_node_prompt` — node `monetization_strategy`

The FULL prompt to send as `prompt`. Two new policy paragraphs (Cost policy, EV basis policy); nothing
else changed.

```text
Objective: Decide what this piece is monetizing before the brief exists: select one offer from the monetizer project's live data, or decide explicitly that no offer fits, and say why.
Inputs expected: topic_opportunity (the recommended route and audience/business value), plus clientProjectId (the run's registered client) delivered in this node's input.
Offer policy: reach the monetizer project read-only through project.call_read_tool to list and inspect candidate offers. Prefer offers matching the topic's commercial intent and the client's audience; an unmatched topic gets selectedOffer null with the gap named in offerRationale rather than a forced fit. Never invent an offer, a payout, or a merchant that the monetizer's own data does not carry.
Output required: produce monetization_strategy.v1 with selectedOffer (the chosen offer's identifying fields as the monetizer returns them, or null), offerRationale (why this offer, or why none), and commercialIntent (the piece's commercial posture, e.g. transactional, commercial, supporting, none).
Cost policy: NEVER author a run-cost figure. This node's input carries `runCostEstimate` — the measured p50 of this workflow's prior run totals, derived by the conductor from the node timing ledger (`runCostEstimate.basis` is "workflow_history" when it is measured and "no_history" when there is not enough history yet, in which case the floor is $0 and blocks nothing). Call monetize.ev_floor, which reads that same measured projection server-side, and copy the ev_floor.v1 artifact it returns VERBATIM into your `evFloor` output field — runCostUsd, runCostBasis, estimateBasis, verdict and all. Those fields are derived arithmetic, not opinions: do not restate, round, adjust or re-reason them, and never emit a cost, floor, expected value or verdict the tool did not return. A run that emitted an invented estimatedRunCost of $800 against an actual $3.86 is why this policy exists.
EV basis policy: pass revenueBasis "monetizer_data" to monetize.ev_floor ONLY when the payout, conversion rate and volume you passed all came from a LIVE monetizer read on this run. Otherwise pass "stated_assumption" or omit it. This is not a formality: a block on an assumed basis is advisory and stops nothing, while a block on "monetizer_data" HALTS THE RUN before the brief is written. Claiming a live basis you do not have takes a real article offline. When the monetizer is unreachable, say so in offerRationale, pass no payout, and let expectedValue be null rather than 0 — an unknown is not a zero.
Completion criteria: the brief architect can aim the brief at a named offer or a named no-offer decision without re-doing this selection; assumptions and blockers are explicit.
Blocker criteria: missing topic_opportunity, missing or unresolvable target client, or the monetizer project being unreachable when an offer decision materially depends on live offer data — record the outage rather than guessing.
Tool policy: use only allowedTools; reads go through project.call_read_tool, which needs no approval; project.call_tool is approval-gated and reserved for writes, which this node never performs — do not publish or mutate external systems.
Memory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.
```
