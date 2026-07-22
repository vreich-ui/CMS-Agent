// Model-provider registry (docs/improvement/STRATEGY.md §4 model tiering): lets a node's
// modelConfig route execution to OpenAI (default), Gemini via Google's OpenAI-compatible endpoint,
// or any OpenAI-compatible server (vLLM on Cloud Run, etc.) without changing the runner
// architecture. Security convention preserved from ProjectConnectionConfig: configs carry API-key
// environment-variable NAMES, never values.
import { OpenAIChatCompletionsModel, type Model } from "@openai/agents";
import OpenAI from "openai";

export type ResolvedProvider = {
  label: string;
  kind: "default" | "openai_compatible" | "anthropic";
  baseURL?: string;
  apiKeyEnv: string;
};

const GOOGLE_OPENAI_COMPAT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

// Throws with an actionable message on unknown providers or incomplete openai_compatible configs;
// validateConfiguration surfaces the message as a configuration error before any run is minted.
export function resolveProvider(modelConfig: Record<string, unknown> = {}): ResolvedProvider {
  const provider = asString(modelConfig.provider) ?? "openai";
  if (provider === "openai") return { label: "openai", kind: "default", apiKeyEnv: "OPENAI_API_KEY" };
  // Native Anthropic path (Phase 6): resolved so the provider is a first-class, known value, but the
  // Messages API request is issued by AnthropicNodeRunner, not the OpenAI-compatible client below.
  if (provider === "anthropic") return { label: "anthropic", kind: "anthropic", baseURL: asString(modelConfig.baseURL), apiKeyEnv: asString(modelConfig.apiKeyEnv) ?? "ANTHROPIC_API_KEY" };
  if (provider === "google") return { label: "google", kind: "openai_compatible", baseURL: GOOGLE_OPENAI_COMPAT_BASE_URL, apiKeyEnv: asString(modelConfig.apiKeyEnv) ?? "GEMINI_API_KEY" };
  if (provider === "openai_compatible") {
    const baseURL = asString(modelConfig.baseURL);
    const apiKeyEnv = asString(modelConfig.apiKeyEnv);
    if (!baseURL || !apiKeyEnv) throw new Error("provider=openai_compatible requires modelConfig.baseURL and modelConfig.apiKeyEnv (an environment-variable NAME, never a value).");
    return { label: `openai_compatible:${new URL(baseURL).host}`, kind: "openai_compatible", baseURL, apiKeyEnv };
  }
  throw new Error(`Unknown provider "${provider}" (expected openai, anthropic, google, or openai_compatible).`);
}

// Default provider keeps today's exact code path (a model-name string resolved by the SDK's
// default client). Compatible providers get an explicit chat-completions model bound to a client
// pointed at their baseURL.
export function buildAgentModel(resolved: ResolvedProvider, modelName: string): string | Model {
  if (resolved.kind === "default") return modelName;
  // Defensive: anthropic nodes are dispatched to AnthropicNodeRunner and never reach here. If they do,
  // fail loudly rather than silently building an OpenAI client against the Anthropic endpoint.
  if (resolved.kind === "anthropic") throw new Error("provider=anthropic runs on the native AnthropicNodeRunner, not the OpenAI-compatible path.");
  const apiKey = process.env[resolved.apiKeyEnv];
  if (!apiKey) throw new Error(`${resolved.apiKeyEnv} is required for provider ${resolved.label}.`);
  return new OpenAIChatCompletionsModel(new OpenAI({ baseURL: resolved.baseURL, apiKey }), modelName);
}
