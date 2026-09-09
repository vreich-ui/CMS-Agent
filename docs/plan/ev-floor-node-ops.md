# EV-floor node ops — `monetization_strategy` (2026-09-09)

Three ops. The COST half of ops 1–3 was already applied to the live store on 2026-09-08 (workspace
1046 → 1048); this file supersedes that record with the traffic half folded in, so applying it once
after this branch deploys brings the node fully up to date in one pass. **Apply only after the code is
deployed** — the prompt tells the node to read `trafficEstimate`, which does not exist in a node's
input until `trafficPrefetch.ts` is live.

```
npm run nodes:apply -- docs/plan/ev-floor-node-ops.md              # dry run — expect "up to date"
```

## Why this file was rewritten

The version that shipped with PR #286 was built from `src/agent/workspace/nodes.ts` (the canonical
literal) and was **wrong and destructive**. The live store's `monetization_strategy` had drifted well
ahead of canonical: it already carried a full, required `evFloor` object with a CLUSTER-level model —
`clusterRole` (money_page / supporting_asset / unattached), `supportingFor`, a third verdict
`pass_via_cluster`, plus `currency` and a structured `margin` — none of which exists in `nodes.ts`.
Applying the canonical-derived ops would have replaced that with a poorer schema and thrown the cluster
model away. The ops below are built from the LIVE node instead and are strictly ADDITIVE: every
existing property, every `required` entry and the cluster `if/then/else` are preserved byte-for-byte.

The predicate shipped in PR #286 is compatible with the live shape as-is — it reads only `verdict`
(`block`) and `estimateBasis` (`monetizer_data`), which the live schema already spells identically.

## Known remaining gap (operator decision, deliberately NOT applied here)

The live node's `allowedTools` is `["workspace.get_node", "stage.get_output", "stage.list_outputs",
"project.call_read_tool"]` — **`monetize.ev_floor` is missing**, although `nodes.ts` declares it. That
is the deeper root cause of the $800: the node has never been able to reach the deterministic
arithmetic, so it has always had to author the numbers itself. The Run-cost policy below closes the
gap for the COST side (the figure is prefetched into the node's input, so no tool call is needed), but
granting the tool would let the node compute the floor deterministically rather than by hand. Changing
a node's tool grants is an operator decision (`workspace_update_node_tools`), so it is named here
rather than done.

### 1. `workspace_update_node_input_schema` — node `monetization_strategy`

Declares the conductor-prefetched `runCostEstimate` at the TOP LEVEL of the node's input, where the
Run-cost policy tells the model to read it. Additive: the three existing properties are unchanged.

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
      "description": "run_cost_estimate.v1, prefetched by the conductor (costPrefetch.ts) before this node's agent loop starts: the MEASURED p50 of this workflow's prior run totals, summed from the node timing ledger's recorded costUsd, with this run's own partial spend excluded. This IS the run-cost figure \u2014 the node never authors one.",
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
      "description": "traffic_estimate.v1, prefetched by the conductor (trafficPrefetch.ts) before this node's agent loop starts: this property's MEASURED sessions and purchase rate over the last 90 days, aggregated from the tracking sink's engagement rows the scheduled ingest job already wrote to the feedback ledger. These ARE expectedMonthlyTraffic and assumedConversionRate \u2014 the node never authors either.",
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
}
```

### 2. `workspace_update_node_output_schema` — node `monetization_strategy`

Adds one optional property, `evFloor.estimatedRunCostBasis`, and sharpens three descriptions
(`estimatedRunCost`, `verdict`, `estimateBasis`) to say where the figure comes from and that
`verdict: block` + `estimateBasis: monetizer_data` now halts the run. No property removed, no `required`
entry changed.

```json
{
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
          "description": "Expected monthly traffic to this article/offer. COPIED VERBATIM from this node's input trafficEstimate.expectedMonthlyTraffic \u2014 the property's measured sessions over the last 90 days, normalized to 30 \u2014 never authored here. The defective run asserted 400 with nothing behind it."
        },
        "estimatedRunCost": {
          "type": "number",
          "minimum": 0,
          "description": "Run cost this piece's EV must clear. COPIED VERBATIM from this node's input runCostEstimate.estimatedRunCostUsd \u2014 the measured p50 of this workflow's prior run totals \u2014 never authored, rounded or adjusted here. 0 is a legitimate value when there is no history: an unmeasured floor blocks nothing. A run that authored 800 against a measured $3.86 is why this field is no longer the node's to invent."
        },
        "estimatedRunCostBasis": {
          "type": "string",
          "enum": [
            "workflow_history",
            "no_history",
            "accrued_run_cost",
            "model_authored"
          ],
          "description": "Where estimatedRunCost came from. Copy runCostEstimate.basis (workflow_history | no_history). accrued_run_cost is the monetize.ev_floor fallback. model_authored must never be emitted \u2014 it exists only so an audit can name the defect if it ever recurs. Distinct from estimateBasis, which describes the estimate as a WHOLE."
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
          "description": "Explains the verdict: the arithmetic, the money page named when pass_via_cluster, or why nothing was found when block. When estimatedRunCostBasis is no_history, say so here \u2014 a $0 floor is a stated fact, not a silent one."
        },
        "estimateBasis": {
          "type": "string",
          "enum": [
            "monetizer_data",
            "stated_assumption",
            "mixed"
          ],
          "description": "The basis of the estimate AS A WHOLE. monetizer_data ONLY when every figure came from live data this run: the cost side from runCostEstimate with basis workflow_history, the revenue side from a live monetizer query via project.call_read_tool, AND the volume side from trafficEstimate with basis tracking_engagement. stated_assumption when they are named assumptions; mixed when combined. This label decides whether a block stops the run \u2014 claiming monetizer_data on an invented traffic figure takes a real article offline. Never fabricate false precision."
        },
        "volumeBasis": {
          "type": "string",
          "enum": [
            "tracking_engagement",
            "stated_assumption"
          ],
          "description": "Where expectedMonthlyTraffic came from. Copy trafficEstimate.basis, mapping insufficient_data -> stated_assumption. Its own axis because a payout and a traffic figure come from two different systems: estimateBasis can only reach monetizer_data when BOTH are measured, so a live payout multiplied by an invented traffic figure can never halt a run."
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
}
```

### 3. `workspace_update_node_prompt` — node `monetization_strategy`

The FULL prompt as applied. One new paragraph (**Run-cost policy**) and an extended **Estimate
discipline**; every other paragraph — offer policy, the cluster-level EV floor, fail-fast on a dead
monetizer, output/completion/blocker/tool/memory policy — is preserved verbatim from the live prompt.

```text
Objective: Decide what this piece is monetizing before the brief exists: select one offer from the monetizer project's live data, or decide explicitly that no offer fits, and say why.
Inputs expected: topic_opportunity (the recommended route and audience/business value), plus clientProjectId (the run's registered client) delivered in this node's input.
Offer policy: reach the monetizer project read-only through project.call_read_tool to list and inspect candidate offers. Prefer offers matching the topic's commercial intent and the client's audience; an unmatched topic gets selectedOffer null with the gap named in offerRationale rather than a forced fit. Never invent an offer, a payout, or a merchant that the monetizer's own data does not carry.
EV floor policy (cluster level): commercialIntent alone is not a pass/fail gate — every piece must clear an explicit expected-value floor, reported in evFloor. Compute expectedValue = expectedCommission x assumedConversionRate x expectedMonthlyTraffic. The floor passes at this article's own level (floorPassed=true) when expectedValue clears estimatedRunCost plus margin (margin.kind=multiplier applied to estimatedRunCost, or margin.kind=absolute added to it — state which and why). Evaluate the floor at CLUSTER level, not only per-article:
- Clears on its own: clusterRole="money_page", floorPassed=true, supportingFor=null, verdict="pass".
- Does not clear on its own but is a declared supporting asset of a money-page article that itself clears the floor: clusterRole="supporting_asset", supportingFor=<that money page's id>, floorPassed=false, verdict="pass_via_cluster" — name the money page and its own passing math in rationale. Do not claim pass_via_cluster without a real, checkable supportingFor id.
- Does not clear on its own and has no such declared relationship: clusterRole="unattached", verdict="block" — say so plainly in offerRationale/commercialIntent; do not force an offer or a favorable intent label to dodge the floor.
Run-cost policy: NEVER author estimatedRunCost. This node's input carries runCostEstimate — the MEASURED p50 of this workflow's prior run totals, derived by the conductor from the node timing ledger before your turn started, with this run's own partial spend excluded. Copy runCostEstimate.estimatedRunCostUsd into evFloor.estimatedRunCost verbatim, and set evFloor.estimatedRunCostBasis to runCostEstimate.basis. Do not round it, adjust it, add a distribution allowance to it, or substitute a safer-looking number for it. When basis is "no_history" the figure is 0 and the floor is therefore 0 — that is correct and deliberate, an unmeasured floor blocks nothing; say so in rationale rather than inventing a figure to fill the gap. If runCostEstimate is missing from your input entirely, set estimatedRunCost to 0, estimatedRunCostBasis to "no_history", and name the missing prefetch in rationale — a zero you can explain is worth more than a number you made up. A run that authored estimatedRunCost 800 against a measured $3.86, then demanded $1,000 of expected value before any article could clear the floor, is why this policy exists.
Traffic policy: NEVER author expectedMonthlyTraffic or assumedConversionRate. This node's input carries trafficEstimate — this property's MEASURED sessions and purchase rate over the last 90 days, aggregated by the conductor from the tracking sink's engagement rows. Copy trafficEstimate.expectedMonthlyTraffic into evFloor.expectedMonthlyTraffic verbatim, and set evFloor.volumeBasis from trafficEstimate.basis ("tracking_engagement" stays as it is; "insufficient_data" becomes "stated_assumption"). For assumedConversionRate: use trafficEstimate.observedConversionRate when it is non-null; when it is null you may state an assumption, but say so in rationale and never label the estimate monetizer_data on it. A null observedConversionRate is NOT a measured zero. When basis is "insufficient_data" the traffic figure is 0 and the floor's expected value is 0 — say so in rationale; that is an unmeasured property, not a worthless one, and it blocks nothing. The defective run asserted 400 monthly visits with nothing whatsoever behind the number.
Estimate discipline: every number in evFloor must name its basis via estimateBasis. Use "monetizer_data" only when EVERY figure came from live data this run — the cost side from runCostEstimate with basis "workflow_history", the revenue side pulled from a live monetizer query via project.call_read_tool, AND the volume side from trafficEstimate with basis "tracking_engagement"; otherwise use "stated_assumption" (or "mixed" when combining) and spell out the assumption and its source in rationale. Never fabricate false precision — a made-up conversion rate to three decimal places is worse than a round, labeled guess. estimateBasis is load-bearing, not documentation: a verdict of "block" carrying estimateBasis "monetizer_data" HALTS THE RUN at brief_architect, before the brief and everything after it is bought, while the same block on "stated_assumption" or "mixed" is advisory and the run proceeds. So claiming a live basis you do not have takes a real article offline; under-claiming only costs a few dollars. A live payout multiplied by an invented traffic figure is NOT monetizer_data — it is "mixed", and the run proceeds. While the monetizer project MCP connection is down or unreachable, treat all revenue-side evFloor inputs as estimates and label them as such throughout (estimateBasis, rationale, and notes) rather than presenting them as measured data — "mixed" is the honest label when the cost side is measured and the revenue side is not. Fail fast on a dead connection: if the monetizer connection is unconfigured/unreachable, or the FIRST project.call_read_tool attempt against it fails with a validation, permission, or not-permitted error, do not retry and do not try alternate monetizer operations — proceed immediately to emitting the full output with stated assumptions, estimateBasis="stated_assumption" or "mixed", and the failed connection named plainly in rationale. Burning the tool budget probing a dead connection and emitting nothing is a worse failure than a clearly labeled estimate.
Output required: produce monetization_strategy.v1 with selectedOffer (the chosen offer's identifying fields as the monetizer returns them, or null), offerRationale (why this offer, or why none), commercialIntent (the piece's commercial posture, e.g. transactional, commercial, supporting, none), and evFloor (the structured EV assessment defined above — always populated, even for a null selectedOffer or a block verdict).
Completion criteria: the brief architect can aim the brief at a named offer or a named no-offer decision without re-doing this selection; assumptions and blockers are explicit; the EV floor verdict is defensible from the numbers and basis given, and every figure in it is either copied from a named source or labeled an assumption.
Blocker criteria: missing topic_opportunity, missing or unresolvable target client, or the monetizer project being unreachable when an offer decision materially depends on live offer data — record the outage rather than guessing.
Tool policy: use only allowedTools; reads go through project.call_read_tool, which needs no approval; project.call_tool is approval-gated and reserved for writes, which this node never performs — do not publish or mutate external systems.
Memory policy: your dependency outputs and the run's inputs are delivered in this node's input — work from them. Do not re-read stage outputs you already hold; fetch a stage output only when it is essential, named, and missing from your input. Save only this node's structured output; do not expose secrets or raw authorization headers.
```
