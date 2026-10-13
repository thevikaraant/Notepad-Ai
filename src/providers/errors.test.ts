import { describe, expect, it } from "vitest";
import { describeHttpError, describeNetworkError } from "./errors";

describe("describeHttpError", () => {
  it("flags 401 as an auth problem without ever echoing request secrets", () => {
    expect(describeHttpError(401, "")).toBe("Unauthorized (401). Check your API key.");
  });

  it("surfaces an OpenAI-style error.message", () => {
    const body = JSON.stringify({ error: { message: "model `gpt-5000` does not exist" } });
    expect(describeHttpError(404, body)).toContain("model `gpt-5000` does not exist");
  });

  it("surfaces an Anthropic-style error.message", () => {
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens required" } });
    expect(describeHttpError(400, body)).toContain("max_tokens required");
  });

  it("handles a plain string error field", () => {
    expect(describeHttpError(403, JSON.stringify({ error: "disabled" }))).toContain("disabled");
  });

  it("falls back gracefully on non-JSON bodies (e.g. an HTML proxy error page)", () => {
    const message = describeHttpError(502, "<html>Bad Gateway</html>");
    expect(message).toContain("Server error (502)");
  });

  it("classifies 429 as a rate limit", () => {
    expect(describeHttpError(429, "")).toContain("Rate limited (429)");
  });

  it("classifies 5xx as server errors", () => {
    expect(describeHttpError(503, "")).toContain("Server error (503)");
  });
});

describe("describeNetworkError", () => {
  it("recognizes a connection-refused failure (local server not running)", () => {
    expect(describeNetworkError("error sending request for url: tcp connect error: Connection refused")).toContain(
      "Could not connect",
    );
  });

  it("recognizes a timeout", () => {
    expect(describeNetworkError("operation timed out")).toContain("timed out");
  });

  it("recognizes a DNS failure", () => {
    expect(describeNetworkError("dns error: failed to lookup address information")).toContain("resolve");
  });

  it("falls back to the raw message for unrecognized errors", () => {
    expect(describeNetworkError("something odd happened")).toBe("something odd happened");
  });
});
