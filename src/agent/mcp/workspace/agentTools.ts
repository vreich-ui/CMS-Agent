import { z } from "zod";
import type { ProjectRepository } from "../../repository/interfaces/ProjectRepository.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import type { ConversationTurnRepository } from "../../repository/interfaces/ConversationTurnRepository.js";
import type { UsageRepository } from "../../repository/interfaces/UsageRepository.js";
import { ConversationalRunner } from "../../conversations/conversationalRunner.js";
import { agentConverseInputSchema, agentConverseJsonSchema } from "../../conversations/conversationContract.js";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";

const resolveAgentInput = z.object({
  role: z.literal("client_manager"),
  project_id: z.string().min(1).max(63)
}).strict();

const resolveAgentJsonSchema = objectSchema({
  role: { type: "string", const: "client_manager" },
  project_id: { type: "string", minLength: 1, maxLength: 63 }
}, ["role", "project_id"]);

export class AgentResolveError extends Error {
  constructor(public readonly code: "unknown_project" | "project_disabled" | "agent_unresolved", message: string) {
    super(`${code}: ${message}`);
  }
}

export type AgentToolDeps = {
  workspaceRepository: WorkspaceRepository;
  projectRepository: ProjectRepository;
  conversationTurnRepository: ConversationTurnRepository;
  usageRepository: UsageRepository;
  conversationalRunner?: Pick<ConversationalRunner, "run">;
};

// CA2 deliberately resolves only the canonical workspace seed. Project-specific overrides and
// conversational execution are later waves; callers discover an opaque ref instead of selecting
// a node or implementation id.
export function createAgentTools({ workspaceRepository, projectRepository, conversationTurnRepository, usageRepository, conversationalRunner }: AgentToolDeps): WorkspaceTool[] {
  const runner = conversationalRunner ?? new ConversationalRunner({ workspaceRepository, projectRepository, conversationTurnRepository, usageRepository });
  return [
    tool({
      name: "agent.resolve",
      description: "Resolve the active conversational agent for a registered project and role. Returns an opaque agent reference and definition revision; callers must not hardcode agent or node ids.",
      zodSchema: resolveAgentInput,
      inputSchema: resolveAgentJsonSchema,
      execute: async (input) => {
        const data = resolveAgentInput.parse(input);
        const project = await projectRepository.get(data.project_id);
        if (!project) throw new AgentResolveError("unknown_project", `No registered project matches "${data.project_id}".`);
        if (project.status !== "active") throw new AgentResolveError("project_disabled", `Project "${data.project_id}" is disabled.`);

        await workspaceRepository.ensureConversationalAgentSeeds();
        const agent = (await workspaceRepository.listConversationalAgents()).find((candidate) => candidate.role === data.role && candidate.status === "active");
        if (!agent) throw new AgentResolveError("agent_unresolved", `No active ${data.role} agent definition is available.`);

        return ok({
          agent_ref: `${agent.id}@${agent.rev}`,
          name: agent.name,
          rev: agent.rev,
          model: agent.modelConfig.model,
          status: agent.status
        });
      }
    }),
    tool({
      name: "agent.converse",
      description: "Execute exactly one client_manager.turn.v1 model turn. Caller tools are passed to the provider and returned as unexecuted tool calls; CMS-Agent never executes them or owns the human wait state. Duplicate conversation_id + turn_id calls replay one stored response without another provider call.",
      zodSchema: agentConverseInputSchema,
      inputSchema: agentConverseJsonSchema,
      execute: async (input) => ok(await runner.run(input))
    })
  ];
}
