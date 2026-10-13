import { describe, expect, it } from "vitest";
import { ollamaAdapter } from "./ollama";
import { ProviderError } from "./types";

describe("ollama buildChatRequest", () => {
  it("preserves the existing /api/generate request shape", () => {
    const request = ollamaAdapter.buildChatRequest(
      { baseUrl: "http://localhost:11434", model: "qwen3:4b" },
      null,
      "rewrite this",
      false,
    );
    expect(request).toEqual({
      method: "POST",
      url: "http://localhost:11434/api/generate",
      headers: { "Content-Type": "application/json" },
      body: { model: "qwen3:4b", prompt: "rewrite this", stream: false },
    });
  });

  it("requires a model name", () => {
    expect(() =>
      ollamaAdapter.buildChatRequest({ baseUrl: "http://localhost:11434", model: "" }, null, "hi", false),
    ).toThrow(/model name/);
  });

  it("requires a base URL", () => {
    expect(() => ollamaAdapter.buildChatRequest({ model: "qwen3:4b" }, null, "hi", false)).toThrow(ProviderError);
  });
});

describe("ollama parseNonStreamResponse", () => {
  it("extracts the response field", () => {
    const body = JSON.stringify({ response: "hello", done: true });
    expect(ollamaAdapter.parseNonStreamResponse(200, body)).toBe("hello");
  });

  it("surfaces an in-body error even on a 200 status", () => {
    const body = JSON.stringify({ error: "model not found" });
    expect(() => ollamaAdapter.parseNonStreamResponse(200, body)).toThrow(/model not found/);
  });

  it("classifies connection-level HTTP errors", () => {
    expect(() => ollamaAdapter.parseNonStreamResponse(404, "")).toThrow(/Not found/);
  });
});

describe("ollama streaming (NDJSON)", () => {
  it("decodes multiple lines split across chunk boundaries", () => {
    const decoder = ollamaAdapter.createStreamDecoder();
    const events = [
      ...decoder('{"model":"m","response":"Hel'),
      ...decoder('lo","done":false}\n{"model":"m","response":" World","done":false}\n'),
      ...decoder('{"model":"m","response":"","done":true}\n'),
    ];
    expect(events).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " World" },
      { type: "done" },
    ]);
  });

  it("surfaces a mid-stream error line", () => {
    const decoder = ollamaAdapter.createStreamDecoder();
    const events = decoder('{"error":"model crashed"}\n');
    expect(events).toEqual([{ type: "error", message: "model crashed" }]);
  });
});

describe("ollama model listing", () => {
  it("builds a GET /api/tags request", () => {
    const request = ollamaAdapter.buildModelListRequest!({ baseUrl: "http://localhost:11434", model: "" }, null);
    expect(request).toEqual({ method: "GET", url: "http://localhost:11434/api/tags", headers: {} });
  });

  it("parses the {models:[{name}]} shape", () => {
    const body = JSON.stringify({ models: [{ name: "llama3" }, { name: "qwen3:4b" }] });
    expect(ollamaAdapter.parseModelListResponse!(body)).toEqual([{ id: "llama3" }, { id: "qwen3:4b" }]);
  });
});
