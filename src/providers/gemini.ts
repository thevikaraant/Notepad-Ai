import { describeHttpError } from "./errors";
import { createSseDecoder } from "./sse";
import type { ModelInfo, ProviderAdapter, ProviderConfig, RequestSpec } from "./types";
import { ProviderError } from "./types";

function resolveBaseUrl(config: ProviderConfig): string {
  const base = (config.baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new ProviderError("Base URL is not set. Add it in AI Settings first.");
  }
  return base;
}

/**
 * Google's Generative Language API. Auth uses the `x-goog-api-key` header —
 * deliberately not the `?key=` query parameter the docs also offer, since
 * query parameters can end up in logs/history and this app never puts
 * secrets in URLs.
 */
export const geminiAdapter: ProviderAdapter = {
  supportsModelList: true,

  buildChatRequest(config, apiKey, combinedPrompt, stream): RequestSpec {
    const base = resolveBaseUrl(config);
    if (!config.model.trim()) {
      throw new ProviderError("Gemini requires a model name (e.g. gemini-2.5-flash).");
    }
    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return {
      method: "POST",
      url: `${base}/v1beta/models/${encodeURIComponent(config.model)}:${method}`,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
      },
      body: {
        contents: [{ role: "user", parts: [{ text: combinedPrompt }] }],
      },
    };
  },

  parseNonStreamResponse(status, bodyText) {
    if (status < 200 || status >= 300) {
      throw new ProviderError(describeHttpError(status, bodyText), status);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new ProviderError("Received an invalid (non-JSON) response from Gemini.");
    }
    const data = parsed as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const content = (data.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || "")
      .join("");
    if (!content.trim()) {
      throw new ProviderError("Empty response from Gemini.");
    }
    return content;
  },

  createStreamDecoder() {
    return createSseDecoder((frame) => {
      if (!frame.data) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        return [];
      }
      const data = parsed as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        error?: { message?: string };
      };
      if (data.error) {
        return [{ type: "error", message: data.error.message || "Gemini streaming error." }];
      }
      const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
      return text ? [{ type: "delta", text }] : [];
    });
  },

  buildModelListRequest(config, apiKey): RequestSpec {
    const base = resolveBaseUrl(config);
    return {
      method: "GET",
      url: `${base}/v1beta/models`,
      headers: apiKey ? { "x-goog-api-key": apiKey } : {},
    };
  },

  parseModelListResponse(bodyText): ModelInfo[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new ProviderError("Received an invalid (non-JSON) model list response from Gemini.");
    }
    const data = parsed as { models?: Array<{ name?: string }> };
    const ids = (data.models || [])
      .map((item) => item.name?.replace(/^models\//, ""))
      .filter((id): id is string => Boolean(id));
    return [...new Set(ids)].sort().map((id) => ({ id }));
  },
};
