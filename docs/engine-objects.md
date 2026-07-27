# The engine's objects

What each thing in CMS-Agent actually is: why it exists, how it is identified, what happens to it over
its life, and what it connects to.

**This file is generated** from `ui/src/objectModel.ts` — the same descriptions the interface renders
beside each object. Edit the registry and run `npm run objects:update`; CI fails if the two disagree.

The mental model these sit inside, from `PRODUCT_VISION.md`: *Projects → Missions → Workflows → Agent
Teams → Agents → Runs → Knowledge → History.* The workflow graph is one view into that, not the thing
itself.

---

## Workspace

The single document holding every node, the graph between them, and the history of both.

**Why it exists.** It is the unit of truth and the unit of concurrency. Because agents and humans edit the same configuration, every change needs one authority to serialize against — and one place a previous state can be restored from.

**Identified by.** A singleton: there is exactly one per storage backend, so it has no id. Its version identity is the pair (workspaceVersion, currentRevisionId).

**Lifecycle.** Created from seeded defaults on first read. Every mutation bumps workspaceVersion and appends to history. It is never deleted.

**Relates to.** Contains nodes, stage outputs, learning observations, relationships, events and revisions.

**Where you see it.** The version badge in the node inspector, the Constellation graph, and Settings → Repository diagnostics.

**Worth knowing.** There are THREE version concepts, not one, and conflating them wastes an afternoon. `workspaceVersion` is an integer bumped on EVERY mutation, including non-structural ones like saving a stage output — it is what optimistic concurrency guards against. A `revision` is a snapshot taken only for STRUCTURAL changes, and is the chain you actually restore from. The legacy `versions` array is a read projection carrying neither actor nor relationships. Also note that registering a client connection does NOT bump workspaceVersion, so a drift check keyed on it is blind to connection changes.

<sub>Engine type `WorkspaceDocument` · tools: `repository_get_health`, `workspace_export_workspace`, `workspace_import_workspace`, `workspace_validate_graph`</sub>

## Node

One step an agent performs: a prompt, the tools it may use, the skills assigned to it, and the shape of what it must produce.

**Why it exists.** It is the editable unit of method. Changing how the organization works means changing a node, which is why every node edit is attributed, reasoned and reversible.

**Identified by.** A stable string id such as `draft_writer`, referenced by other nodes' dependencies. Renaming one is a graph change, not a cosmetic one.

**Lifecycle.** Created, patched field by field, cloned, or deleted — but a node another node depends on cannot be deleted, and the canonical pipeline nodes are protected from removal. Every write is ledgered.

**Relates to.** Depends on other nodes, is assigned skills, grants tools, produces named artifacts that later nodes require as inputs.

**Where you see it.** The Constellation canvas, and the node inspector's five tabs.

**Worth knowing.** A node's own `riskLevel` is the CEILING for the tools it may call — granting a write tool to a read node changes nothing at run time. And `dependsOn` (execution order) is a different field from `requiredInputs` (data the prompt needs); when they disagree the resolver raises it, because the graph then does not match what the prompt actually reads.

<sub>Engine type `WorkspaceNode` · tools: `workspace_get_node`, `workspace_get_nodes`, `workspace_create_node`, `workspace_update_node`, `workspace_delete_node`, `workspace_clone_node`, `workspace_update_node_prompt`, `workspace_update_node_tools`, `workspace_update_node_skills`, `node_get_effective_prompt`, `node_get_effective_tools`, `workspace_validate_node`</sub>

## Skill

Reusable craft — instructions, tool requirements and completion criteria — that can be assigned to many nodes at once.

**Why it exists.** It keeps method that applies in several places in one place. A change to how the house writes, or checks facts, or handles artifacts, happens once rather than in every node that does it.

**Identified by.** A `skillId` slug. Skills are versioned, and a previous version can be restored.

**Lifecycle.** Created, updated (each update adding a version), cloned, assigned to or unassigned from nodes, and deletable. Versions are retained.

**Relates to.** Assigned to nodes; declares its own allowed tools, required artifacts and produced artifacts.

**Where you see it.** The node inspector's Skills tab, and the Skills panel.

**Worth knowing.** An assigned skill APPENDS its instructions to the node's prompt. An operator reading the node's own prompt is therefore reading only part of what runs — which is why the Prompt tab states when instructions are injected and shows both halves separately.

<sub>Engine type `SkillDefinition` · tools: `skill_list`, `skill_get`, `skill_create`, `skill_update`, `skill_delete`, `skill_clone`, `skill_assign`, `skill_unassign`, `skill_validate`, `skill_resolve_for_node`, `skill_list_versions`, `skill_get_version`, `skill_restore_version`</sub>

## Project

A registered connection to an external MCP server — either a client the engine publishes for, or a service it calls.

**Why it exists.** It is how the workspace reaches anything outside itself, and the boundary where permission is enforced. The client's own live contract is the authority on content shape; this record is how that contract is fetched.

**Identified by.** A `projectId` slug such as `platform` or `dr-lurie`. `platform` is client 0 and its site is the engine's self-README.

**Lifecycle.** Registered, updated, disabled, or deleted — except that a code-defined default cannot be deleted while the code still seeds it, because it is re-created on the next read. Endpoint and token are read from named environment variables and never stored.

**Relates to.** Nodes reach it through `project.call_tool`; its per-tool policy governs what they may call.

**Where you see it.** The project selector, the connection badge, and the Access page.

**Worth knowing.** Two separate lists exist and only one is enforced: `toolPolicies` is what actually governs a call, while `allowedTools` can read as empty for a client whose tools are in fact callable. Also, a 401 has two layers — the transport bearer (`*_MCP_TOKEN`) is not the same credential as a client's storage grant, and a storage failure comes back as a SUCCESSFUL call carrying an error inside the result.

<sub>Engine type `ProjectConnectionConfig` · tools: `project_list`, `project_get`, `project_create`, `project_update`, `project_delete`, `project_test_connection`, `project_list_tools`, `project_call_tool`, `project_get_registration_contract`, `project_validate_handoff`</sub>

## Run

One execution of the workflow: which nodes have run, what they produced, what it cost, and what it is waiting for.

**Why it exists.** It is the unit of work and the unit of accountability. Everything about what happened, and why it stopped where it did, hangs off a run.

**Identified by.** A `runId`, carried by the outputs, usage records and approvals belonging to it.

**Lifecycle.** Started as a dry run or a live run, advanced node by node, and pausable, resumable, cancellable, retryable or resettable. Records are retained.

**Relates to.** Belongs to a project, executes nodes, produces stage outputs and artifacts, accrues usage records, and holds the approvals it is waiting on.

**Where you see it.** The Run summary panel, the execution list, and the Overview page's run tiles.

**Worth knowing.** `blocked` and `failed` mean opposite things: blocked is a deliberate safety hold awaiting a human and is resumable, failed is something going wrong. A budget pause is a third thing again — it is not an approval, and clearing it is a budget decision rather than a review.

<sub>Engine type `WorkflowExecutionRecord` · tools: `workflow_start_dry_run`, `workflow_get_run`, `workflow_list_runs`, `workflow_run_node`, `workflow_run_all`, `workflow_run_next_node`, `workflow_run_until`, `workflow_pause_run`, `workflow_resume_run`, `workflow_cancel_run`, `workflow_retry_node`, `workflow_reset_run`, `workflow_get_run_cost`, `workflow_get_run_context`</sub>

## Stage output

The structured result one node produced, saved under a stage name so later nodes can read it.

**Why it exists.** It is the handoff between nodes. Nodes do not talk to each other directly — one saves, the next reads, and the record of what was handed over survives the run.

**Identified by.** An id plus the stage name it was saved under; the stage name is what dependent nodes look up.

**Lifecycle.** Written by a node during execution and retained. Saving one bumps the workspace version without being a structural change.

**Relates to.** Produced by a node during a run; read by nodes that require that stage as an input.

**Where you see it.** The node console's output panes, and the artifact panel.

<sub>Engine type `StageOutput` · tools: `stage_save_output`, `stage_get_output`, `stage_list_outputs`, `node_get_latest_output`, `node_list_outputs`</sub>

## Change event

One entry in the ledger: who changed what, when, why, and from which version to which.

**Why it exists.** With most configuration eventually edited by agents rather than people, the ledger is the only account of intent anyone gets. It is what makes the system auditable and a previous state restorable.

**Identified by.** An `eventId`, paired with the revision the change produced where the change was structural.

**Lifecycle.** Append-only and immutable. Restoring a previous state does not rewrite history — it appends a new event describing the restoration.

**Relates to.** Attributed to an actor (human, agent or system), scoped to an entity such as a node or skill, and paired with a revision.

**Where you see it.** The Changes page, and the reason field every save in the inspector requires.

**Worth knowing.** The ledger is workspace-wide: selecting a project does not filter it. And the `reason` on an agent's change is mandatory precisely because it is the only thing a human reviewing it later can act on.

<sub>Engine type `WorkspaceChangeEvent` · tools: `changes_list`, `changes_get`, `changes_compare`, `changes_restore`</sub>

## Artifact

A materialized output of a run — an image, a document, a rendered file — recorded with where it actually lives.

**Why it exists.** Content that leaves the workspace has to be verifiable. An artifact record is the proof that a specific file was produced for a specific request, rather than a plausible-looking path.

**Identified by.** Recorded per run, and for media, tied to the request it was materialized for.

**Lifecycle.** Created during execution by the artifact service, then verified. Only artifacts materialized for the CURRENT request may be referenced — a pattern-valid key is not proof.

**Relates to.** Belongs to a run; referenced from the article body's media fields; materialized by the pdf-tool service into the client's own storage.

**Where you see it.** The artifact panel, and publish readiness's verified-media list.

**Worth knowing.** `ArtifactReference` is NOT an engine type — it is the external pdf-tool payload shape, surviving here only as a string field inside the article body. The engine's own object is this one. Note also that pdf-tool holds no credentials of its own: it writes into a client's storage using a short-lived grant the client issues, so a missing grant surfaces as a storage error, not an auth error.

<sub>Engine type `ExecutionArtifact` · tools: `node_get_latest_output`, `publish_build_payload`, `publish_validate_payload`</sub>

## Relationship

A typed edge between nodes that is not execution order — influence, derivation, or another declared association.

**Why it exists.** PRODUCT_VISION asks the interface to answer "who influenced whom". Execution order cannot answer that, so influence is recorded separately rather than inferred from the graph.

**Identified by.** An id, plus the pair of nodes it connects and its kind.

**Lifecycle.** Created, updated and deleted through the relationship tools, and revisioned with the workspace.

**Relates to.** Connects two nodes. The `execution` kind is explicitly refused here, because execution edges are derived from `dependsOn` and having two sources of truth for them would let them disagree.

**Where you see it.** The Constellation canvas's layer toggles, and the relationship views.

<sub>Engine type `WorkspaceRelationship` · tools: `workspace_update_relationships`, `constellation_get_relationship`, `constellation_get_structure`</sub>

## Learning observation

A recorded note about how a run actually went, kept as evidence rather than acted on automatically.

**Why it exists.** It is the raw material of improvement. Separating observation from change is deliberate: the system notices things continuously, but nothing rewrites a prompt or a schema without a human or an explicit optimizer step.

**Identified by.** An id, with the run and node it came from where those are known.

**Lifecycle.** Appended during or after a run and retained. Observations are never applied automatically.

**Relates to.** Cites the node and run it describes; feeds the improvement objects below.

**Where you see it.** The learning panel, and the `learning_recorder` node's output.

<sub>Engine type `LearningObservation` · tools: `learning_record_observation`, `learning_list_observations`, `playbook_migrate_observations`</sub>

## Tool

A capability a node can be granted, carrying its own risk level, side effect and whether it needs approval.

**Why it exists.** Tools are where an agent's intentions become actions with consequences, so each one declares its risk and side effect and is granted per node rather than globally.

**Identified by.** A dotted `toolId` such as `stage.save_output`. On the wire dots become underscores, because the Messages API rejects dotted tool names.

**Lifecycle.** Defined in code, not stored — a definition holds a live handler. What IS persisted is a record of each execution, for audit.

**Relates to.** Granted by nodes and by skills, gated by the resolver against the node's risk ceiling, and — for client tools — by the project's per-tool policy.

**Where you see it.** The node inspector's Tools tab, and the Access page for client tools.

**Worth knowing.** A tool a node lists that the registry does not know about will never resolve, so config can look populated while granting nothing. The Tools tab reports that case rather than hiding the row.

<sub>Engine type `ToolDefinition` · tools: `tool_list`, `tool_get`, `tool_test`, `tool_get_effective_for_node`, `tool_list_executions`, `tool_get_execution`</sub>

---

# Beyond the pipeline

These are not yet surfaced in the interface. They are named here so the object model does not appear to stop at publishing.

## Improvement objects

The outer loop: rubrics and datasets to evaluate against, results and pairwise comparisons, proposals and trials, regression reports, and per-node playbooks of what has been learned.

**Why it exists.** They make improvement a reviewable process rather than an edit. A proposal is evaluated against a rubric on a dataset, trialled, checked for regression, and only then promoted — which is what allows agents to improve the system without being trusted blindly.

**Identified by.** Each is its own stored record with its own id; rubrics are versioned and restorable.

**Lifecycle.** Created and retained; promotion is an explicit step, and auto-promotion is separately gated.

**Relates to.** All key back to nodes and runs, and pairwise results carry dual-ordering to detect position bias.

**Where you see it.** Not yet surfaced in the interface — reachable through MCP only. Worth knowing they exist before the Phase 7 screens land.

<sub>Engine type `EvalRubric · EvalResult · EvalDataset · ImprovementProposal · TrialRecord · FeedbackRecord · PairwiseResult · RegressionReport · NodePlaybook` · tools: `evaluation_create_rubric`, `evaluation_run`, `evaluation_run_regression`, `optimizer_propose`, `optimizer_run_trial`, `optimizer_promote`, `optimizer_auto_promote`, `feedback_record`, `feedback_list`, `playbook_get`, `playbook_curate`, `dataset_build`, `dataset_list`</sub>
