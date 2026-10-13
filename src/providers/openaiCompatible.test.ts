import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";
import { ProviderError } from "./types";

const adapter = createOpenAiCompatibleAdapter({
  chatPath: "/v1/chat/completions",
  modelsPath: "/v1/models",
});

const perplexityLikeAdapter = createOpenAiCompatibleAdapter({
  chatPath: "/chat/completions",
});

describe("buildChatRequest", () => {
  it("builds a standard chat completions request with Bearer auth", () => {
    const request = adapter.buildChatRequest(
      { baseUrl: "https://api.example.com", model: "demo-model" },
      "secret-key",
      "rewrite this",
      false,
    );
    expect(request).toEqual({
      method: "POST",
      url: "https://api.example.com/v1/chat/completions",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-key" },
      body: { model: "demo-model", messages: [{ role: "user", content: "rewrite this" }], stream: false },
    });
  });

  it("strips a trailing slash from the base URL", () => {
    const request = adapter.buildChatRequest(
      { baseUrl: "http://localhost:1234/", model: "local-model" },
      null,
      "hi",
      false,
    );
    expect(request.url).toBe("http://localhost:1234/v1/chat/completions");
  });

  it("omits the Authorization header when no key is configured (e.g. a local server)", () => {
    const request = adapter.buildChatRequest({ baseUrl: "http://localhost:1234", model: "m" }, null, "hi", false);
    expect(request.headers.Authorization).toBeUndefined();
  });

  it("uses the no-/v1 chat path for a Perplexity-shaped provider", () => {
    const request = perplexityLikeAdapter.buildChatRequest(
      { baseUrl: "https://api.perplexity.ai", model: "sonar" },
      "key",
      "hi",
      true,
    );
    expect(request.url).toBe("https://api.perplexity.ai/chat/completions");
    expect(request.body).toMatchObject({ stream: true });
  });

  it("throws a clear ProviderError when the base URL is missing", () => {
    expect(() => adapter.buildChatRequest({ model: "m" }, null, "hi", false)).toThrow(ProviderError);
  });

  it("never puts the API key in the URL", () => {
    const request = adapter.buildChatRequest(
      { baseUrl: "https://api.example.com", model: "m" },
      "super-secret",
      "hi",
      false,
    );
    expect(request.url).not.toContain("super-secret");
  });
});

describe("parseNonStreamResponse", () => {
  it("extracts choices[0].message.content", () => {
    const body = JSON.stringify({ choices: [{ message: { content: "hello world" } }] });
    expect(adapter.parseNonStreamResponse(200, body)).toBe("hello world");
  });

  it("falls back to choices[0].text for legacy completion shapes", () => {
    const body = JSON.stringify({ choices: [{ text: "legacy text" }] });
    expect(adapter.parseNonStreamResponse(200, body)).toBe("legacy text");
  });

  it("throws on a non-2xx status with the classified error message", () => {
    const body = JSON.stringify({ error: { message: "invalid_api_key" } });
    expect(() => adapter.parseNonStreamResponse(401, body)).toThrow(/API key/);
  });

  it("throws on empty content", () => {
    const body = JSON.stringify({ choices: [{ message: { content: "" } }] });
    expect(() => adapter.parseNonStreamResponse(200, body)).toThrow(/Empty response/);
  });

  it("throws a clear error on invalid JSON", () => {
    expect(() => adapter.parseNonStreamResponse(200, "not json")).toThrow(/invalid/);
  });
});

describe("createStreamDecoder", () => {
  it("accumulates deltas and recognizes [DONE]", () => {
    const decoder = adapter.createStreamDecoder();
    const events = [
      ...decoder('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'),
      ...decoder('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'),
    ];
    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done" },
    ]);
  });

  it("surfaces a mid-stream error object", () => {
    const decoder = adapter.createStreamDecoder();
    const events = decoder('data: {"error":{"message":"rate limited"}}\n\n');
    expect(events).toEqual([{ type: "error", message: "rate limited" }]);
  });

  it("ignores unparseable keep-alive frames instead of throwing", () => {
    const decoder = adapter.createStreamDecoder();
    expect(() => decoder("data: not-json\n\n")).not.toThrow();
  });

  it("handles a delta split across two chunk boundaries", () => {
    const decoder = adapter.createStreamDecoder();
    const events = [
      ...decoder('data: {"choices":[{"delta":{"content":"Hel'),
      ...decoder('lo"}}]}\n\n'),
    ];
    expect(events).toEqual([{ type: "delta", text: "Hello" }]);
  });
});

describe("model listing", () => {
  it("builds a GET request with Bearer auth and no body", () => {
    const request = adapter.buildModelListRequest!({ baseUrl: "https://api.example.com", model: "" }, "key");
    expect(request).toEqual({
      method: "GET",
      url: "https://api.example.com/v1/models",
      headers: { Authorization: "Bearer key" },
    });
  });

  it("parses and de-duplicates+sorts the OpenAI-style model list shape", () => {
    const body = JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }] });
    expect(adapter.parseModelListResponse!(body)).toEqual([{ id: "a-model" }, { id: "b-model" }]);
  });

  it("is unsupported for a Perplexity-shaped provider (no models endpoint)", () => {
    expect(perplexityLikeAdapter.supportsModelList).toBe(false);
    expect(perplexityLikeAdapter.buildModelListRequest).toBeUndefined();
  });
});
