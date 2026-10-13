import { describe, expect, it } from "vitest";
import { geminiAdapter } from "./gemini";

describe("gemini buildChatRequest", () => {
  it("uses the x-goog-api-key header, never a ?key= query parameter", () => {
    const request = geminiAdapter.buildChatRequest(
      { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash" },
      "secret-key",
      "rewrite this",
      false,
    );
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(request.url).not.toContain("secret-key");
    expect(request.url).not.toContain("key=");
    expect(request.headers["x-goog-api-key"]).toBe("secret-key");
    expect(request.body).toEqual({ contents: [{ role: "user", parts: [{ text: "rewrite this" }] }] });
  });

  it("uses streamGenerateContent?alt=sse when streaming", () => {
    const request = geminiAdapter.buildChatRequest(
      { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash" },
      "k",
      "hi",
      true,
    );
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
  });

  it("requires a model name", () => {
    expect(() =>
      geminiAdapter.buildChatRequest({ baseUrl: "https://generativelanguage.googleapis.com", model: "" }, "k", "hi", false),
    ).toThrow(/model name/);
  });
});

describe("gemini parseNonStreamResponse", () => {
  it("joins candidate parts text", () => {
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }] });
    expect(geminiAdapter.parseNonStreamResponse(200, body)).toBe("hello world");
  });

  it("classifies a 400 with the Gemini error message", () => {
    const body = JSON.stringify({ error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" } });
    expect(() => geminiAdapter.parseNonStreamResponse(400, body)).toThrow(/API key not valid/);
  });
});

describe("gemini streaming", () => {
  it("emits each candidate chunk's text as a delta", () => {
    const decoder = geminiAdapter.createStreamDecoder();
    const events = [
      ...decoder('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n'),
      ...decoder('data: {"candidates":[{"content":{"parts":[{"text":" World"}]}}]}\n\n'),
    ];
    expect(events).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " World" },
    ]);
  });

  it("surfaces an in-stream error object", () => {
    const decoder = geminiAdapter.createStreamDecoder();
    const events = decoder('data: {"error":{"code":429,"message":"quota exceeded"}}\n\n');
    expect(events).toEqual([{ type: "error", message: "quota exceeded" }]);
  });
});

describe("gemini model listing", () => {
  it("builds the GET /v1beta/models request with the header, not a query param", () => {
    const request = geminiAdapter.buildModelListRequest!(
      { baseUrl: "https://generativelanguage.googleapis.com", model: "" },
      "secret",
    );
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(request.url).not.toContain("secret");
    expect(request.headers["x-goog-api-key"]).toBe("secret");
  });

  it("strips the 'models/' prefix from returned ids", () => {
    const body = JSON.stringify({ models: [{ name: "models/gemini-2.5-flash" }, { name: "models/gemini-2.0-pro" }] });
    expect(geminiAdapter.parseModelListResponse!(body)).toEqual([
      { id: "gemini-2.0-pro" },
      { id: "gemini-2.5-flash" },
    ]);
  });
});
