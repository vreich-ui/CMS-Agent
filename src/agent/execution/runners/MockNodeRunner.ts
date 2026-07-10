import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import type { NodeRunner, NodeRunnerInput, NodeRunnerResult } from "./NodeRunner.js";
import type { NodeRunnerContext, ExecutionMode } from "../executionContext.js";
export class MockNodeRunner implements NodeRunner {
  supports(mode: ExecutionMode) { return mode === "mock"; }
  validateConfiguration(_node: WorkspaceNode) { return { ok: true as const }; }
  async run({ node }: NodeRunnerInput, context: NodeRunnerContext): Promise<NodeRunnerResult> {
    if (node.id === "article_body") return { ok: true, output: { schema_version: "article_body.v1", nodes: [{ id: "n_dryRunIntro", kind: "content", visibility: "public", public: { title: "Dry-run article", body: "Deterministic mock article body for Publishing Conductor dry-run execution." } }] } };
    if (node.id === "publish_payload") return { ok: true, output: { artifact: "dry_run_publish_payload.v1", dryRun: true, target: "preview", articleBody: context.run.stageOutputs.article_body, publicationSideEffects: false } };
    return { ok: true, output: { artifact: node.produces[0] ?? `${node.id}.mock.v1`, nodeId: node.id, dryRun: true, summary: `Dry-run mock output for ${node.name}.`, dependencyOutputs: node.dependsOn } };
  }
}
