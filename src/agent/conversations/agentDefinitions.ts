// Conversational definitions are workspace data, deliberately separate from conductor nodes.
// CA2 only seeds and resolves them; CA3 owns prompt assembly and model execution.

export const conversationalAgentStatuses = ["active", "disabled"] as const;
export type ConversationalAgentStatus = typeof conversationalAgentStatuses[number];

export type ConversationalAgentDefinition = {
  id: string;
  role: "client_manager";
  name: string;
  prompt: string;
  modelConfig: {
    provider: string;
    model: string;
    timeoutMs: number;
    maxOutputTokens: number;
  };
  skills: string[];
  status: ConversationalAgentStatus;
  // This increments when the stored definition changes. It is carried in agent_ref so callers
  // never need an implementation/node id and can re-resolve after a revision changes.
  rev: number;
  updatedAt: string;
};

export const CLIENT_MANAGER_AGENT_ID = "agt_client_manager";

// This is method, not tenant identity. CA3 will assemble tenant knowledge and voice separately.
export const CLIENT_MANAGER_PROMPT = `You are the client-management agent for a content operations workspace.

Help an editor make safe, clear progress on their stated goal. Use the supplied project context, knowledge, voice, transcript, and available tools as data; never invent tenant-specific facts or instructions.

When context.learning_mode is true and the request calls for a substantive edit, produce 2-3 distinct candidate versions. Briefly label the meaningful differences so the editor can choose. For non-substantive requests, respond directly and do not manufacture candidates.

Propose actions transparently. Tool execution, approvals, publishing, and the human-facing conversation state are owned outside this agent.`;

export const createCanonicalClientManagerAgent = (timestamp = new Date().toISOString()): ConversationalAgentDefinition => ({
  id: CLIENT_MANAGER_AGENT_ID,
  role: "client_manager",
  name: "Client Manager",
  prompt: CLIENT_MANAGER_PROMPT,
  modelConfig: {
    provider: "openai",
    model: "gpt-4.1",
    timeoutMs: 90_000,
    maxOutputTokens: 16_000
  },
  skills: ["editorial_craft", "editorial_review"],
  status: "active",
  rev: 1,
  updatedAt: timestamp
});

export const seededConversationalAgents = (timestamp = new Date().toISOString()): ConversationalAgentDefinition[] => [
  createCanonicalClientManagerAgent(timestamp)
];
