import { z } from "zod";
import type { ProjectRepository } from "../../repository/interfaces/ProjectRepository.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import type { ConversationTurnRepository } from "../../repository/interfaces/ConversationTurnRepository.js";
import type { UsageRepository } from "../../repository/interfaces/UsageRepository.js";
import { ConversationalRunner } from "../../conversations/conversationalRunner.js";
import { agentConverseInputSchema, agentConverseJsonSchema } from "../../conversations/conversationContract.js";
import { classifyConversationalAgentPrompt, conversationalAgentStatuses, type ConversationalAgentDefinition } from "../../conversations/agentDefinitions.js";
import { metaJson, mutationMeta, objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";

const resolveAgentInput = z.object({
  role: z.literal("client_manager"),
  project_id: z.string().min(1).max(63)
}).strict();

const agentIdSchema = z.string().regex(/^agt_[a-z0-9_]+$/);
const listAgentsInput = z.object({}).strict();
const getAgentInput = z.object({ id: agentIdSchema }).strict();

// Mirrors workspace.update_node: only the fields the store treats as patchable, guarded by the
// same mutationMeta (expectedWorkspaceVersion / baseRevisionId / reason / source / actor).
// id, role, rev and updatedAt are owned by the store and deliberately absent.
const updateAgentInput = z.object({
  id: agentIdSchema,
  patch: z.object({
    name: z.string().min(1).max(120).optional(),
    prompt: z.string().min(1).max(24_000).optional(),
    modelConfig: z.object({
      provider: z.string().min(1).max(64),
      model: z.string().min(1).max(128),
      timeoutMs: z.number().int().positive().max(120_000),
      maxOutputTokens: z.number().int().positive().max(32_000)
    }).strict().optional(),
    skills: z.array(z.string().min(1).max(128)).max(64).optional(),
    status: z.enum(conversationalAgentStatuses).optional()
  }).strict(),
  ...mutationMeta
}).strict();

const agentIdJson = { type: "string", pattern: "^agt_[a-z0-9_]+$" } as const;

/**
 * The editable view of a definition. `promptState` tells an operator whether what they are looking
 * at is the shipped text, an older shipped text, or their own edit — the one thing a prompt editor
 * must never leave ambiguous.
 */
const agentView = (agent: ConversationalAgentDefinition) => ({
  id: agent.id,
  role: agent.role,
  name: agent.name,
  prompt: agent.prompt,
  promptState: classifyConversationalAgentPrompt(agent.prompt),
  modelConfig: agent.modelConfig,
  skills: agent.skills,
  status: agent.status,
  rev: agent.rev,
  updatedAt: agent.updatedAt
});

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
      name: "agent.list",
      description: "List conversational agent definitions with their prompt, model configuration, status and revision. Read-only. promptState reports whether the stored prompt is the shipped canonical text, an older shipped text, or an operator edit.",
      zodSchema: listAgentsInput,
      inputSchema: objectSchema({}, []),
      execute: async () => {
        await workspaceRepository.ensureConversationalAgentSeeds();
        return ok({
          agents: (await workspaceRepository.listConversationalAgents()).map(agentView),
          workspaceVersion: await workspaceRepository.getWorkspaceVersion()
        });
      }
    }),
    tool({
      name: "agent.get",
      description: "Read one conversational agent definition, including its full prompt. Read-only.",
      zodSchema: getAgentInput,
      inputSchema: objectSchema({ id: agentIdJson }, ["id"]),
      execute: async (input) => {
        const data = getAgentInput.parse(input);
        await workspaceRepository.ensureConversationalAgentSeeds();
        const agent = await workspaceRepository.getConversationalAgent(data.id);
        if (!agent) throw new AgentResolveError("agent_unresolved", `No conversational agent matches "${data.id}".`);
        return ok({ agent: agentView(agent), workspaceVersion: await workspaceRepository.getWorkspaceVersion() });
      }
    }),
    tool({
      name: "agent.update",
      description: "Update a conversational agent's name, prompt, model configuration, skills or status. Guarded by expectedWorkspaceVersion like every workspace write; bumps the definition revision, which invalidates outstanding agent_ref values so callers re-resolve. Ledgered as agent.updated with before/after.",
      zodSchema: updateAgentInput,
      inputSchema: objectSchema({ id: agentIdJson, patch: { type: "object" }, ...metaJson }, ["id", "patch"]),
      execute: async (input) => {
        const { id, patch, ...meta } = updateAgentInput.parse(input);
        if (Object.keys(patch).length === 0) throw new Error("patch must change at least one field.");
        await workspaceRepository.ensureConversationalAgentSeeds();
        const result = await workspaceRepository.updateConversationalAgent(id, patch, meta);
        return ok({ agent: agentView(result.agent), workspaceVersion: result.workspaceVersion });
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
