import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { describeHttpError, describeNetworkError } from "./errors";
import type { RequestSpec, StreamDecoder, StreamEvent } from "./types";

export type HttpResult = { status: number; headers: Record<string, string>; body: string };

function errorToMessage(error: unknown): string {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  return describeNetworkError(raw);
}

/** Non-streaming request (model listing, connection test). Goes through the Rust `http_request` command so the WebView never makes a direct cross-origin fetch. */
export async function sendHttpRequest(spec: RequestSpec): Promise<HttpResult> {
  try {
    return await invoke<HttpResult>("http_request", {
      request: {
        method: spec.method,
        url: spec.url,
        headers: spec.headers,
        body: spec.body ?? null,
      },
    });
  } catch (error) {
    throw new Error(errorToMessage(error));
  }
}

let streamCounter = 0;
function nextRequestId(): string {
  streamCounter += 1;
  return `stream-${Date.now()}-${streamCounter}`;
}

export type StreamHandle = {
  cancel: () => void;
};

export type StreamCallbacks = {
  onDelta: (text: string) => void;
  onDone: (aborted: boolean) => void;
  onError: (message: string) => void;
};

type ChunkPayload = { request_id: string; data: string };
type EndPayload = { request_id: string; status: number; aborted: boolean };
type ErrorPayload = { request_id: string; message: string; status?: number; body?: string };

/**
 * Starts a streaming chat request. Registers event listeners before invoking
 * the Rust command (so no chunk can arrive before we're listening), decodes
 * each raw chunk with the adapter's protocol-specific decoder, and reports
 * deltas/completion/errors via callbacks. Returns a handle whose `cancel()`
 * tells the backend to stop the in-flight request.
 */
export async function startStream(
  spec: RequestSpec,
  decoder: StreamDecoder,
  callbacks: StreamCallbacks,
): Promise<StreamHandle> {
  const requestId = nextRequestId();
  let settled = false;
  const unlistenFns: UnlistenFn[] = [];
  const cleanup = () => {
    for (const fn of unlistenFns) fn();
    unlistenFns.length = 0;
  };

  const applyEvents = (events: StreamEvent[]) => {
    for (const event of events) {
      if (settled) return;
      if (event.type === "delta") {
        callbacks.onDelta(event.text);
      } else if (event.type === "done") {
        settled = true;
        cleanup();
        callbacks.onDone(false);
      } else if (event.type === "error") {
        settled = true;
        cleanup();
        callbacks.onError(event.message);
      }
    }
  };

  unlistenFns.push(
    await listen<ChunkPayload>("ai-stream-chunk", (event) => {
      if (settled || event.payload.request_id !== requestId) return;
      applyEvents(decoder(event.payload.data));
    }),
  );
  unlistenFns.push(
    await listen<EndPayload>("ai-stream-end", (event) => {
      if (settled || event.payload.request_id !== requestId) return;
      settled = true;
      cleanup();
      callbacks.onDone(event.payload.aborted);
    }),
  );
  unlistenFns.push(
    await listen<ErrorPayload>("ai-stream-error", (event) => {
      if (settled || event.payload.request_id !== requestId) return;
      settled = true;
      cleanup();
      const message =
        event.payload.status !== undefined
          ? describeHttpError(event.payload.status, event.payload.body || "")
          : describeNetworkError(event.payload.message);
      callbacks.onError(message);
    }),
  );

  invoke("ai_stream_request", {
    requestId,
    method: spec.method,
    url: spec.url,
    headers: spec.headers,
    body: spec.body ?? null,
  }).catch((error) => {
    if (settled) return;
    settled = true;
    cleanup();
    callbacks.onError(errorToMessage(error));
  });

  return {
    cancel: () => {
      void invoke("cancel_ai_stream", { requestId });
    },
  };
}
