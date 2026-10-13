export type ProviderId =
  | "ollama"
  | "lmstudio"
  | "localai"
  | "vllm"
  | "llamacpp"
  | "openai_compatible"
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "deepseek"
  | "mistral"
  | "xai"
  | "openrouter"
  | "together"
  | "fireworks"
  | "cerebras"
  | "perplexity";

export type ProviderCategory = "local" | "cloud";

export type ProviderConfig = {
  baseUrl?: string;
  model: string;
  organization?: string;
  project?: string;
};

export type HttpMethod = "GET" | "POST";

export type RequestSpec = {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

export type ModelInfo = {
  id: string;
};

export class ProviderError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

/** Result of decoding one raw transport chunk (bytes from the wire) into zero or more text deltas. */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Stateful decoder: callers feed raw chunks in order, it buffers partial frames internally. */
export type StreamDecoder = (rawChunk: string) => StreamEvent[];

export interface ProviderAdapter {
  buildChatRequest(
    config: ProviderConfig,
    apiKey: string | null,
    combinedPrompt: string,
    stream: boolean,
  ): RequestSpec;
  parseNonStreamResponse(status: number, bodyText: string): string;
  createStreamDecoder(): StreamDecoder;
  supportsModelList: boolean;
  buildModelListRequest?(config: ProviderConfig, apiKey: string | null): RequestSpec;
  parseModelListResponse?(bodyText: string): ModelInfo[];
}

export type ProviderDefinition = {
  id: ProviderId;
  label: string;
  category: ProviderCategory;
  baseUrlEditable: boolean;
  defaultBaseUrl: string | null;
  requiresApiKey: boolean;
  supportsOrgProject: boolean;
  modelPlaceholder: string;
  adapter: ProviderAdapter;
};
