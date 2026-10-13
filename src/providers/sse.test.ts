import { describe, expect, it } from "vitest";
import { FrameBuffer, createNdjsonDecoder, createSseDecoder, parseSseFrame } from "./sse";
import type { StreamEvent } from "./types";

describe("FrameBuffer", () => {
  it("splits complete frames and buffers a trailing remainder", () => {
    const buffer = new FrameBuffer("\n\n");
    expect(buffer.push("frame-one\n\nframe-two\n\npart")).toEqual(["frame-one", "frame-two"]);
    expect(buffer.push("ial\n\nframe-three\n\n")).toEqual(["partial", "frame-three"]);
  });

  it("handles a frame split across many small chunks", () => {
    const buffer = new FrameBuffer("\n\n");
    const pieces = ["da", "ta: { \"a\"", ":1 }", "\n", "\n"];
    const frames = pieces.flatMap((piece) => buffer.push(piece));
    expect(frames).toEqual(['data: { "a":1 }']);
  });

  it("normalizes CRLF to LF before framing", () => {
    const buffer = new FrameBuffer("\n\n");
    expect(buffer.push("frame-one\r\n\r\nframe-two\r\n\r\n")).toEqual(["frame-one", "frame-two"]);
  });
});

describe("parseSseFrame", () => {
  it("extracts a single data line", () => {
    expect(parseSseFrame('data: {"x":1}')).toEqual({ data: '{"x":1}', event: undefined });
  });

  it("extracts event + data", () => {
    expect(parseSseFrame('event: content_block_delta\ndata: {"x":1}')).toEqual({
      event: "content_block_delta",
      data: '{"x":1}',
    });
  });

  it("joins multiple data lines with newlines per the SSE spec", () => {
    expect(parseSseFrame("data: line1\ndata: line2")).toEqual({
      event: undefined,
      data: "line1\nline2",
    });
  });

  it("ignores comment lines", () => {
    expect(parseSseFrame(': keep-alive\ndata: ok')).toEqual({ event: undefined, data: "ok" });
  });

  it("returns an empty object for a frame with no event or data", () => {
    expect(parseSseFrame(": just a comment")).toEqual({});
  });
});

describe("createSseDecoder", () => {
  it("decodes deltas split arbitrarily across chunks", () => {
    const decoder = createSseDecoder((frame): StreamEvent[] => {
      if (frame.data === "[DONE]") return [{ type: "done" }];
      if (frame.data) return [{ type: "delta", text: frame.data }];
      return [];
    });

    const results: StreamEvent[] = [];
    results.push(...decoder("data: Hel"));
    results.push(...decoder("lo\n\ndata: World\n\n"));
    results.push(...decoder("data: [DONE]\n\n"));

    expect(results).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: "World" },
      { type: "done" },
    ]);
  });
});

describe("createNdjsonDecoder", () => {
  it("decodes NDJSON lines split across chunks", () => {
    const decoder = createNdjsonDecoder((line): StreamEvent[] => {
      const parsed = JSON.parse(line) as { response: string; done: boolean };
      return parsed.done ? [{ type: "done" }] : [{ type: "delta", text: parsed.response }];
    });

    const results: StreamEvent[] = [];
    results.push(...decoder('{"response":"Hel'));
    results.push(...decoder('lo","done":false}\n{"response":" World","done":false}\n'));
    results.push(...decoder('{"response":"","done":true}\n'));

    expect(results).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " World" },
      { type: "done" },
    ]);
  });
});
