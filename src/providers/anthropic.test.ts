import { describe, expect, it } from "vitest";
import { anthropicAdapter } from "./anthropic";

describe("anthropic buildChatRequest", () => {
  it("uses x-api-key + anthropic-version headers and /v1/messages", () => {
    const request = anthropicAdapter.buildChatRequest(
      { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
      "secret",
      "rewrite this",
      true,
    );
    expect(request).toEqual({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "secret",
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        messages: [{ role: "user", content: "rewrite this" }],
        stream: true,
      },
    });
  });

  it("never puts the API key in the URL", () => {
    const request = anthropicAdapter.buildChatRequest(
      { baseUrl: "https://api.anthropic.com", model: "m" },
      "super-secret",
      "hi",
      false,
    );
    expect(request.url).not.toContain("super-secret");
  });
});

describe("anthropic parseNonStreamResponse", () => {
  it("joins text content blocks", () => {
    const body = JSON.stringify({ content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] });
    expect(anthropicAdapter.parseNonStreamResponse(200, body)).toBe("hello world");
  });

  it("classifies a 401 as an auth problem", () => {
    const body = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    expect(() => anthropicAdapter.parseNonStreamResponse(401, body)).toThrow(/API key/);
  });
});

describe("anthropic streaming (SSE with event types)", () => {
  it("accumulates content_block_delta text_delta events and stops at message_stop", () => {
    const decoder = anthropicAdapter.createStreamDecoder();
    const frame1 =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n';
    const frame2 =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n';
    const frame3 = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const events = [...decoder(frame1), ...decoder(frame2), ...decoder(frame3)];
    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done" },
    ]);
  });

  it("ignores ping and message_start events", () => {
    const decoder = anthropicAdapter.createStreamDecoder();
    const events = [
      ...decoder("event: ping\ndata: {}\n\n"),
      ...decoder('event: message_start\ndata: {"type":"message_start"}\n\n'),
    ];
    expect(events).toEqual([]);
  });

  it("surfaces an error event", () => {
    const decoder = anthropicAdapter.createStreamDecoder();
    const events = decoder('event: error\ndata: {"error":{"type":"overloaded_error","message":"overloaded"}}\n\n');
    expect(events).toEqual([{ type: "error", message: "overloaded" }]);
  });
});

describe("anthropic model listing", () => {
  it("builds the GET /v1/models request", () => {
    const request = anthropicAdapter.buildModelListRequest!({ baseUrl: "https://api.anthropic.com", model: "" }, "k");
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://api.anthropic.com/v1/models");
    expect(request.headers["x-api-key"]).toBe("k");
  });

  it("parses {data:[{id}]}", () => {
    const body = JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }, { id: "claude-haiku-4-5" }] });
    expect(anthropicAdapter.parseModelListResponse!(body)).toEqual([
      { id: "claude-haiku-4-5" },
      { id: "claude-sonnet-4-5" },
    ]);
  });
});
