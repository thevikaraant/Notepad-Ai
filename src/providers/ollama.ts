import { describeHttpError } from "./errors";
import { createNdjsonDecoder } from "./sse";
import type { ModelInfo, ProviderAdapter, ProviderConfig, RequestSpec } from "./types";
import { ProviderError } from "./types";

function resolveBaseUrl(config: ProviderConfig): string {
  const base = (config.baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new ProviderError("Base URL is not set. Add it in AI Settings first (e.g. http://localhost:11434).");
  }
  return base;
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Ollama's native API (not its OpenAI-compatible shim) — preserves the
 * `/api/generate` endpoint shape the app already used pre-multi-provider.
 * Streaming responses are NDJSON: one JSON object per line.
 */
export const ollamaAdapter: ProviderAdapter = {
  supportsModelList: true,

  buildChatRequest(config, apiKey, combinedPrompt, stream): RequestSpec {
    const base = resolveBaseUrl(config);
    if (!config.model.trim()) {
      throw new ProviderError("Ollama requires a model name (e.g. qwen3:4b, llama3).");
    }
    return {
      method: "POST",
      url: `${base}/api/generate`,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(apiKey),
      },
      body: {
        model: config.model,
        prompt: combinedPrompt,
        stream,
      },
    };
  },

  parseNonStreamResponse(status, bodyText) {
    if (status < 200 || status >= 300) {
      throw new ProviderError(describeHttpError(status, bodyText), status);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText.trim());
    } catch {
      throw new ProviderError("Received an invalid (non-JSON) response from Ollama.");
    }
    const data = parsed as { response?: string; error?: string };
    if (data.error) {
      throw new ProviderError(data.error);
    }
    const content = data.response || "";
    if (!content.trim()) {
      throw new ProviderError("Empty response from Ollama.");
    }
    return content;
  },

  createStreamDecoder() {
    return createNdjsonDecoder((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      const data = parsed as { response?: string; done?: boolean; error?: string };
      if (data.error) {
        return [{ type: "error", message: data.error }];
      }
      const events: Array<{ type: "delta"; text: string } | { type: "done" }> = [];
      if (data.response) events.push({ type: "delta", text: data.response });
      if (data.done) events.push({ type: "done" });
      return events;
    });
  },

  buildModelListRequest(config, apiKey): RequestSpec {
    const base = resolveBaseUrl(config);
    return {
      method: "GET",
      url: `${base}/api/tags`,
      headers: { ...authHeaders(apiKey) },
    };
  },

  parseModelListResponse(bodyText): ModelInfo[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new ProviderError("Received an invalid (non-JSON) model list response from Ollama.");
    }
    const data = parsed as { models?: Array<{ name?: string }> };
    const names = (data.models || []).map((item) => item.name).filter((name): name is string => Boolean(name));
    return [...new Set(names)].sort().map((id) => ({ id }));
  },
};
