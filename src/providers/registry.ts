import { anthropicAdapter } from "./anthropic";
import { geminiAdapter } from "./gemini";
import { ollamaAdapter } from "./ollama";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";
import type { ProviderConfig, ProviderDefinition, ProviderId } from "./types";

const openAiCompatibleDefault = () =>
  createOpenAiCompatibleAdapter({ chatPath: "/v1/chat/completions", modelsPath: "/v1/models" });

const definitions: ProviderDefinition[] = [
  // --- Local / self-hosted ---
  {
    id: "ollama",
    label: "Ollama",
    category: "local",
    baseUrlEditable: true,
    defaultBaseUrl: "http://localhost:11434",
    requiresApiKey: false,
    supportsOrgProject: false,
    modelPlaceholder: "qwen3:4b",
    adapter: ollamaAdapter,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    category: "local",
    baseUrlEditable: true,
    defaultBaseUrl: "http://localhost:1234",
    requiresApiKey: false,
    supportsOrgProject: false,
    modelPlaceholder: "enter the loaded model id",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "localai",
    label: "LocalAI",
    category: "local",
    baseUrlEditable: true,
    defaultBaseUrl: "http://localhost:8080",
    requiresApiKey: false,
    supportsOrgProject: false,
    modelPlaceholder: "enter the configured model id",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "vllm",
    label: "vLLM",
    category: "local",
    baseUrlEditable: true,
    defaultBaseUrl: "http://localhost:8000",
    requiresApiKey: false,
    supportsOrgProject: false,
    modelPlaceholder: "enter the served model id",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "llamacpp",
    label: "llama.cpp server",
    category: "local",
    baseUrlEditable: true,
    defaultBaseUrl: "http://localhost:8080",
    requiresApiKey: false,
    supportsOrgProject: false,
    modelPlaceholder: "enter the loaded model id",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "openai_compatible",
    label: "Custom (OpenAI-compatible)",
    category: "local",
    baseUrlEditable: true,
    defaultBaseUrl: null,
    requiresApiKey: false,
    supportsOrgProject: false,
    modelPlaceholder: "enter the model id",
    adapter: openAiCompatibleDefault(),
  },

  // --- Cloud ---
  {
    id: "openai",
    label: "OpenAI",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://api.openai.com",
    requiresApiKey: true,
    supportsOrgProject: true,
    modelPlaceholder: "gpt-4.1-mini",
    adapter: createOpenAiCompatibleAdapter({
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
      extraHeaders: (config) => ({
        ...(config.organization ? { "OpenAI-Organization": config.organization } : {}),
        ...(config.project ? { "OpenAI-Project": config.project } : {}),
      }),
    }),
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://api.anthropic.com",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "claude-sonnet-4-5",
    adapter: anthropicAdapter,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "gemini-2.5-flash",
    adapter: geminiAdapter,
  },
  {
    id: "groq",
    label: "Groq",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://api.groq.com/openai",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "llama-3.3-70b-versatile",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://api.deepseek.com",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "deepseek-chat",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "mistral",
    label: "Mistral AI",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://api.mistral.ai",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "mistral-large-latest",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "xai",
    label: "xAI Grok",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://api.x.ai",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "grok-2-latest",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://openrouter.ai/api",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "openai/gpt-4o-mini",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "together",
    label: "Together AI",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://api.together.xyz",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://api.fireworks.ai/inference",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "cerebras",
    label: "Cerebras",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://api.cerebras.ai",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "llama-3.3-70b",
    adapter: openAiCompatibleDefault(),
  },
  {
    id: "perplexity",
    label: "Perplexity",
    category: "cloud",
    baseUrlEditable: false,
    defaultBaseUrl: "https://api.perplexity.ai",
    requiresApiKey: true,
    supportsOrgProject: false,
    modelPlaceholder: "sonar",
    // Perplexity has no official model-list endpoint, hence no modelsPath.
    adapter: createOpenAiCompatibleAdapter({ chatPath: "/chat/completions" }),
  },
];

export const PROVIDER_ORDER: ProviderId[] = definitions.map((def) => def.id);

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = Object.fromEntries(
  definitions.map((def) => [def.id, def]),
) as Record<ProviderId, ProviderDefinition>;

export function getProviderDefinition(id: ProviderId): ProviderDefinition {
  const def = PROVIDERS[id];
  if (!def) throw new Error(`Unknown provider: ${id}`);
  return def;
}

/** Resolves the effective base URL: the user's own value, else the provider's fixed/default base URL. */
export function resolveEffectiveConfig(id: ProviderId, config: ProviderConfig): ProviderConfig {
  const def = getProviderDefinition(id);
  const baseUrl = (config.baseUrl || "").trim() || def.defaultBaseUrl || undefined;
  return { ...config, baseUrl };
}
