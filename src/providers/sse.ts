import type { StreamDecoder, StreamEvent } from "./types";

/**
 * Transport-level chunk framing shared by every streaming adapter. Network
 * chunk boundaries never line up with protocol frame boundaries (SSE "\n\n"
 * blocks, NDJSON "\n" lines), so each decoder buffers a remainder between
 * calls.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export class FrameBuffer {
  private buffer = "";

  constructor(private readonly delimiter: string) {}

  push(chunk: string): string[] {
    this.buffer += normalizeNewlines(chunk);
    const parts = this.buffer.split(this.delimiter);
    this.buffer = parts.pop() ?? "";
    return parts.filter((part) => part.length > 0);
  }
}

export type SseFrame = {
  event?: string;
  data?: string;
};

export function parseSseFrame(frame: string): SseFrame {
  const lines = frame.split("\n");
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (event === undefined && dataLines.length === 0) return {};
  return { event, data: dataLines.length ? dataLines.join("\n") : undefined };
}

/** Builds a stateful decoder over SSE ("\n\n"-framed) chunks. */
export function createSseDecoder(
  handleFrame: (frame: SseFrame) => StreamEvent[],
): StreamDecoder {
  const buffer = new FrameBuffer("\n\n");
  return (rawChunk: string) => {
    const frames = buffer.push(rawChunk);
    const events: StreamEvent[] = [];
    for (const rawFrame of frames) {
      const frame = parseSseFrame(rawFrame);
      events.push(...handleFrame(frame));
    }
    return events;
  };
}

/** Builds a stateful decoder over NDJSON ("\n"-framed) chunks. */
export function createNdjsonDecoder(
  handleLine: (line: string) => StreamEvent[],
): StreamDecoder {
  const buffer = new FrameBuffer("\n");
  return (rawChunk: string) => {
    const lines = buffer.push(rawChunk);
    const events: StreamEvent[] = [];
    for (const line of lines) {
      events.push(...handleLine(line));
    }
    return events;
  };
}
