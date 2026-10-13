import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "./types";

type Handler = (event: { payload: unknown }) => void;
const listeners: Record<string, Handler[]> = {};
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    (listeners[name] ||= []).push(handler);
    return () => {
      listeners[name] = (listeners[name] || []).filter((h) => h !== handler);
    };
  }),
}));

function emit(name: string, payload: unknown) {
  for (const handler of listeners[name] || []) handler({ payload });
}

function lastRequestId(): string {
  const call = invokeMock.mock.calls.find((c) => c[0] === "ai_stream_request");
  if (!call) throw new Error("ai_stream_request was never invoked");
  return (call[1] as { requestId: string }).requestId;
}

beforeEach(() => {
  invokeMock.mockReset();
  for (const key of Object.keys(listeners)) delete listeners[key];
});

const { startStream, sendHttpRequest } = await import("./httpClient");

describe("startStream", () => {
  it("decodes chunk events into onDelta calls and finishes with onDone", async () => {
    invokeMock.mockResolvedValue(undefined);
    const onDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const decoder = (chunk: string): StreamEvent[] => [{ type: "delta", text: chunk }];

    await startStream({ method: "POST", url: "https://example.com", headers: {} }, decoder, {
      onDelta,
      onDone,
      onError,
    });
    const requestId = lastRequestId();

    emit("ai-stream-chunk", { request_id: requestId, data: "Hello" });
    emit("ai-stream-chunk", { request_id: requestId, data: " World" });
    emit("ai-stream-end", { request_id: requestId, status: 200, aborted: false });

    expect(onDelta.mock.calls).toEqual([["Hello"], [" World"]]);
    expect(onDone).toHaveBeenCalledWith(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores events for a different request id", async () => {
    invokeMock.mockResolvedValue(undefined);
    const onDelta = vi.fn();
    const decoder = (chunk: string): StreamEvent[] => [{ type: "delta", text: chunk }];

    await startStream({ method: "POST", url: "https://example.com", headers: {} }, decoder, {
      onDelta,
      onDone: vi.fn(),
      onError: vi.fn(),
    });

    emit("ai-stream-chunk", { request_id: "some-other-request", data: "nope" });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("reports an aborted end (Stop button / cancellation) distinctly from a normal finish", async () => {
    invokeMock.mockResolvedValue(undefined);
    const onDone = vi.fn();
    await startStream(
      { method: "POST", url: "https://example.com", headers: {} },
      () => [],
      { onDelta: vi.fn(), onDone, onError: vi.fn() },
    );
    const requestId = lastRequestId();

    emit("ai-stream-end", { request_id: requestId, status: 200, aborted: true });
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it("classifies a stream-level HTTP error (e.g. a 401 from a bad key)", async () => {
    invokeMock.mockResolvedValue(undefined);
    const onError = vi.fn();
    await startStream(
      { method: "POST", url: "https://example.com", headers: {} },
      () => [],
      { onDelta: vi.fn(), onDone: vi.fn(), onError },
    );
    const requestId = lastRequestId();

    emit("ai-stream-error", { request_id: requestId, message: "Request failed with status 401", status: 401 });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("API key"));
  });

  it("translates an in-decoder error event the same way", async () => {
    invokeMock.mockResolvedValue(undefined);
    const onError = vi.fn();
    const decoder = (): StreamEvent[] => [{ type: "error", message: "rate limited" }];
    await startStream({ method: "POST", url: "https://example.com", headers: {} }, decoder, {
      onDelta: vi.fn(),
      onDone: vi.fn(),
      onError,
    });
    const requestId = lastRequestId();

    emit("ai-stream-chunk", { request_id: requestId, data: "irrelevant" });
    expect(onError).toHaveBeenCalledWith("rate limited");
  });

  it("cancel() invokes cancel_ai_stream with the same request id", async () => {
    invokeMock.mockResolvedValue(undefined);
    const handle = await startStream(
      { method: "POST", url: "https://example.com", headers: {} },
      () => [],
      { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
    );
    const requestId = lastRequestId();
    invokeMock.mockClear();

    handle.cancel();
    expect(invokeMock).toHaveBeenCalledWith("cancel_ai_stream", { requestId });
  });

  it("surfaces a synchronous invoke rejection (e.g. invalid header) as an error", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_stream_request") return Promise.reject("invalid header value");
      return Promise.resolve(undefined);
    });
    const onError = vi.fn();
    await startStream(
      { method: "POST", url: "https://example.com", headers: {} },
      () => [],
      { onDelta: vi.fn(), onDone: vi.fn(), onError },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Invalid request header"));
  });
});

describe("sendHttpRequest", () => {
  it("forwards method/url/headers/body to the http_request command", async () => {
    invokeMock.mockResolvedValue({ status: 200, headers: {}, body: "{}" });
    await sendHttpRequest({ method: "GET", url: "https://example.com/v1/models", headers: { Authorization: "Bearer x" } });
    expect(invokeMock).toHaveBeenCalledWith("http_request", {
      request: { method: "GET", url: "https://example.com/v1/models", headers: { Authorization: "Bearer x" }, body: null },
    });
  });

  it("translates a rejected invoke into a friendly network error message", async () => {
    invokeMock.mockRejectedValue("error sending request for url: tcp connect error: Connection refused");
    await expect(
      sendHttpRequest({ method: "GET", url: "http://localhost:11434/api/tags", headers: {} }),
    ).rejects.toThrow(/Could not connect/);
  });
});
