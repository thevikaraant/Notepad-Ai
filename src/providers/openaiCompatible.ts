import { describeHttpError } from "./errors";
import { createSseDecoder } from "./sse";
import type { ModelInfo, ProviderAdapter, ProviderConfig, RequestSpec } from "./types";
import { ProviderError } from "./types";

export type OpenAiCompatibleOptions = {
  /** Path appended to the resolved base URL for chat completions, e.g. "/v1/chat/completions". */
  chatPath: string;
  /** Path appended to the resolved base URL for model listing. Omit when the provider has no model-list endpoint (e.g. Perplexity). */
  modelsPath?: string;
  /** Additional headers beyond "Content-Type" and the Bearer auth header (used by OpenAI's org/project headers). */
  extraHeaders?: (config: ProviderConfig) => Record<string, string>;
};

function resolveBaseUrl(config: ProviderConfig): string {
  const base = (config.baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new ProviderError("Base URL is not set. Add it in AI Settings first.");
  }
  return base;
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function parseJsonOrThrow(bodyText: string, context: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new ProviderError(`Received an invalid (non-JSON) ${context} from the provider.`);
  }
}

/**
 * Factory for the "OpenAI-compatible" family: standard `/v1/chat/completions`
 * request/response shape, standard SSE delta streaming, standard
 * `/v1/models` listing. Covers OpenAI, Groq, DeepSeek, Mistral, xAI,
 * OpenRouter, Together, Fireworks, Cerebras, Perplexity, LM Studio, LocalAI,
 * vLLM, llama.cpp server, and the custom OpenAI-compatible provider.
 */
export function createOpenAiCompatibleAdapter(options: OpenAiCompatibleOptions): ProviderAdapter {
  return {
    supportsModelList: Boolean(options.modelsPath),

    buildChatRequest(config, apiKey, combinedPrompt, stream): RequestSpec {
      const base = resolveBaseUrl(config);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...authHeaders(apiKey),
        ...(options.extraHeaders ? options.extraHeaders(config) : {}),
      };
      return {
        method: "POST",
        url: `${base}${options.chatPath}`,
        headers,
        body: {
          model: config.model,
          messages: [{ role: "user", content: combinedPrompt }],
          stream,
        },
      };
    },

    parseNonStreamResponse(status, bodyText) {
      if (status < 200 || status >= 300) {
        throw new ProviderError(describeHttpError(status, bodyText), status);
      }
      const parsed = parseJsonOrThrow(bodyText, "response") as {
        choices?: Array<{ message?: { content?: string }; text?: string }>;
      };
      const content = parsed.choices?.[0]?.message?.content ?? parsed.choices?.[0]?.text ?? "";
      if (!content.trim()) {
        throw new ProviderError("Empty response from the AI service.");
      }
      return content;
    },

    createStreamDecoder() {
      return createSseDecoder((frame) => {
        if (!frame.data) return [];
        if (frame.data === "[DONE]") return [{ type: "done" }];
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          return [];
        }
        const data = parsed as {
          choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
          error?: { message?: string } | string;
        };
        if (data.error) {
          const message = typeof data.error === "string" ? data.error : data.error.message || "Streaming error.";
          return [{ type: "error", message }];
        }
        const delta = data.choices?.[0]?.delta?.content;
        return delta ? [{ type: "delta", text: delta }] : [];
      });
    },

    buildModelListRequest: options.modelsPath
      ? (config, apiKey): RequestSpec => {
          const base = resolveBaseUrl(config);
          return {
            method: "GET",
            url: `${base}${options.modelsPath}`,
            headers: { ...authHeaders(apiKey) },
          };
        }
      : undefined,

    parseModelListResponse: options.modelsPath
      ? (bodyText): ModelInfo[] => {
          const parsed = parseJsonOrThrow(bodyText, "model list") as {
            data?: Array<{ id?: string }>;
          };
          const ids = (parsed.data || [])
            .map((item) => item.id)
            .filter((id): id is string => Boolean(id));
          return [...new Set(ids)].sort().map((id) => ({ id }));
        }
      : undefined,
  };
}
