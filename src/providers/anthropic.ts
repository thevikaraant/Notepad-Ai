import { describeHttpError } from "./errors";
import { createSseDecoder } from "./sse";
import type { ModelInfo, ProviderAdapter, ProviderConfig, RequestSpec } from "./types";
import { ProviderError } from "./types";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

function resolveBaseUrl(config: ProviderConfig): string {
  const base = (config.baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new ProviderError("Base URL is not set. Add it in AI Settings first.");
  }
  return base;
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION } : { "anthropic-version": ANTHROPIC_VERSION };
}

/** Anthropic's Messages API: `x-api-key` auth, `/v1/messages`, SSE `content_block_delta` streaming. */
export const anthropicAdapter: ProviderAdapter = {
  supportsModelList: true,

  buildChatRequest(config, apiKey, combinedPrompt, stream): RequestSpec {
    const base = resolveBaseUrl(config);
    return {
      method: "POST",
      url: `${base}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(apiKey),
      },
      body: {
        model: config.model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: combinedPrompt }],
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
      parsed = JSON.parse(bodyText);
    } catch {
      throw new ProviderError("Received an invalid (non-JSON) response from Anthropic.");
    }
    const data = parsed as { content?: Array<{ type?: string; text?: string }> };
    const content = (data.content || [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (!content.trim()) {
      throw new ProviderError("Empty response from Anthropic.");
    }
    return content;
  },

  createStreamDecoder() {
    return createSseDecoder((frame) => {
      if (!frame.event || !frame.data) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        return [];
      }
      if (frame.event === "content_block_delta") {
        const data = parsed as { delta?: { type?: string; text?: string } };
        if (data.delta?.type === "text_delta" && typeof data.delta.text === "string") {
          return [{ type: "delta", text: data.delta.text }];
        }
        return [];
      }
      if (frame.event === "message_stop") {
        return [{ type: "done" }];
      }
      if (frame.event === "error") {
        const data = parsed as { error?: { message?: string } };
        return [{ type: "error", message: data.error?.message || "Anthropic streaming error." }];
      }
      return [];
    });
  },

  buildModelListRequest(config, apiKey): RequestSpec {
    const base = resolveBaseUrl(config);
    return {
      method: "GET",
      url: `${base}/v1/models`,
      headers: { ...authHeaders(apiKey) },
    };
  },

  parseModelListResponse(bodyText): ModelInfo[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new ProviderError("Received an invalid (non-JSON) model list response from Anthropic.");
    }
    const data = parsed as { data?: Array<{ id?: string }> };
    const ids = (data.data || []).map((item) => item.id).filter((id): id is string => Boolean(id));
    return [...new Set(ids)].sort().map((id) => ({ id }));
  },
};
