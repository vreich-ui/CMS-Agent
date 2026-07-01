import type { AgentRequest, AgentRunResponse, DraftResult, ProjectProfile } from "./types.js";
import { createAgent } from "./createAgent.js";
import { JsonMemoryAdapter } from "../memory/JsonMemoryAdapter.js";
import { draftContent } from "../skills/contentDraft.js";
import { editorialReview } from "../skills/editorialReview.js";
import { seoOptimize } from "../skills/seo.js";
import { publishContent } from "../skills/publish.js";
import { consoleObservability } from "../observability/consoleObservability.js";

export async function runAgent(request: AgentRequest, project: ProjectProfile): Promise<AgentRunResponse> {
  const workflow = request.workflow ?? project.defaultWorkflow;
  const dryRun = request.dryRun === false ? false : true;
  const memoryAdapter = new JsonMemoryAdapter();
  const memory = await memoryAdapter.importMemory(request.memory, {
    projectId: project.projectId,
    userId: request.userId,
    threadId: request.threadId
  });
  const agent = createAgent(project);
  const metadata = { projectId: project.projectId, workflow, threadId: request.threadId, model: agent.model };

  consoleObservability.runStarted(metadata);
  try {
    let draft: DraftResult = { title: request.input, content: request.input, status: "input_ready" };
    let review: unknown;
    let seo: unknown;
    let publish: unknown;

    if (workflow === "content_creation" || workflow === "refresh_existing_content") {
      consoleObservability.toolCalled({ ...metadata, tool: "draft_content" });
      draft = draftContent({ input: request.input }, project);
      consoleObservability.toolCalled({ ...metadata, tool: "editorial_review" });
      review = editorialReview({ content: draft.content }, project);
      consoleObservability.toolCalled({ ...metadata, tool: "seo_optimize" });
      seo = seoOptimize({ content: draft.content });
    }

    if (workflow === "content_creation" || workflow === "publish_only") {
      consoleObservability.toolCalled({ ...metadata, tool: "publish", dryRun });
      publish = await publishContent({ title: draft.title, content: draft.content, dryRun }, project);
    }

    const outputMemory = await memoryAdapter.exportMemory({
      ...memory,
      artifacts: [
        ...memory.artifacts,
        { id: `${Date.now()}-draft`, type: "draft", value: { title: draft.title, status: draft.status } }
      ]
    });

    const response: AgentRunResponse = {
      projectId: project.projectId,
      workflow,
      output: { title: draft.title, status: draft.status, content: draft.content, review, seo, publish, memory: outputMemory }
    };
    consoleObservability.runEnded(metadata);
    return response;
  } catch (error) {
    consoleObservability.runErrored(metadata, error);
    throw error;
  }
}
