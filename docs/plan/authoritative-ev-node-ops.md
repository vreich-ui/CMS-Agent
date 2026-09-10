# Authoritative EV additive node migration (W4/W6b, 2026-09-10)

Project/site: CMS-Agent (`vreich-ui/CMS-Agent`, Netlify site `cms-agent`).

Status: **prepared, not applied**. Apply only after the compatible CMS-Agent service revision is
deployed and verified. The live read on 2026-09-10 observed workspace version 1085. That number is
evidence, not a reusable write precondition: immediately before applying, re-read
`monetization_strategy` and `reader_insight`, use the fresh workspace version/base revision, compute
the full replacement schema from that fresh value, and abort on any conflict.

The migration is additive and intentionally does not change model configuration, skills, budgets,
tool grants, tenant policy, publishing authority, schedules, or any unrelated field.

## Exact field diff

### `monetization_strategy`

- Prompt: preserve every current paragraph and append an **Engine decision policy** saying:
  - scope the `project.call_read_tool` offer read explicitly to `clientProjectId` in the remote
    operation arguments;
  - `runCostEstimate` and `trafficEstimate` are inputs to an explanation, not self-certifying
    evidence;
  - the conductor verifies the same-run read receipt, tenant, observation window, current-route cost
    population, currency, configured margin, cluster parent, and explicit override, then appends
    `engineDecision`;
  - model-authored `evFloor.verdict`, `estimateBasis`, arithmetic, and provenance cannot halt a run;
  - `pass_via_cluster` requires a current same-tenant `parentEconomicDecision` whose `decisionId`
    equals `supportingFor`.
- Input schema: preserve the current schema and add these optional evidence properties/children:
  - `runCostEstimate.workflowId: string`
  - `runCostEstimate.evaluatedAt: string, format date-time`
  - `runCostEstimate.projectId: string`
  - `runCostEstimate.scope: enum [project, pooled, none]`
  - `runCostEstimate.candidateRuns: number, minimum 0`
  - `runCostEstimate.coverageRuns: number, minimum 0`
  - `runCostEstimate.exclusionReasons: object`
  - `trafficEstimate.projectId: string`
  - `trafficEstimate.windowStart: string, format date-time`
  - `trafficEstimate.windowEnd: string, format date-time`
- Output schema and legacy `schema`: preserve the complete current cluster-level `evFloor` object,
  every required entry, and its `if/then/else`; add one optional top-level property
  `engineDecision: {type: object, readOnly: true}` with the description “economic_decision.v1
  appended by CMS-Agent conductor code; the only economic decision that may halt the run.”
- Leave `allowedTools` exactly as observed:
  `workspace.get_node`, `stage.get_output`, `stage.list_outputs`, `project.call_read_tool`.
  `monetize.ev_floor` is an optional advisory calculator and is not required by the engine fix.

### `reader_insight`

- Add `monetization_strategy` to `dependsOn` and `requiredInputs`, preserving `topic_opportunity`.
- Preserve prompt, schemas, tools, skills, model configuration, metadata, status, and position.

The executor supplies the `ev_floor_blocked` policy from code at this first paid downstream node; do
not write a second free-form gate into stored metadata.

## Readback/verification contract

After each mutation, read the node back and compare the full field, not only the acknowledgement.
Then run graph validation and verify the publishing graph has no cycle/orphan, exactly one economic
halt policy, and `reader_insight` is not dependency-ready before `monetization_strategy` completes.
If another writer changed either node, refetch and recompute the additive replacement; never replay
the 2026-09-09 full schema or the old bundled budget-lowering operations.
