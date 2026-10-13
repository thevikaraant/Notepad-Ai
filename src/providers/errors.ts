/** Best-effort extraction of a human-readable detail from a provider's JSON error body. */
function extractErrorDetail(bodyText: string): string {
  if (!bodyText) return "";
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed && typeof parsed === "object") {
      const data = parsed as Record<string, unknown>;
      const err = data.error;
      if (typeof err === "string") return err;
      if (err && typeof err === "object") {
        const errorObj = err as Record<string, unknown>;
        if (typeof errorObj.message === "string") return errorObj.message;
      }
      if (typeof data.message === "string") return data.message;
      if (typeof data.detail === "string") return data.detail;
    }
  } catch {
    // Not JSON (e.g. an HTML error page from a proxy) — ignore and fall back.
  }
  return "";
}

/** Maps an HTTP status + response body into a user-facing message. Never echoes request headers/body, so an API key can't leak into it. */
export function describeHttpError(status: number, bodyText: string): string {
  const detail = extractErrorDetail(bodyText);
  const suffix = detail ? ` ${detail}` : "";

  switch (status) {
    case 400:
      return `Bad request (400).${suffix || " Check the request parameters."}`;
    case 401:
      return "Unauthorized (401). Check your API key.";
    case 403:
      return `Forbidden (403).${suffix || " Check your API key and account permissions."}`;
    case 404:
      return `Not found (404).${suffix || " Check the model name and base URL."}`;
    case 429:
      return `Rate limited (429).${suffix || " You may have hit a rate limit or quota."}`;
    default:
      if (status >= 500) {
        return `Server error (${status}).${suffix || " The provider may be experiencing issues."}`;
      }
      return `Request failed (${status}).${suffix}`;
  }
}

/** Maps a raw invoke()-rejection string (network-level failure, before any HTTP status exists) into a user-facing message. */
export function describeNetworkError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "Request timed out. Check that the server is running and reachable.";
  }
  if (
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("error sending request") ||
    lower.includes("error trying to connect")
  ) {
    return "Could not connect to the server. Make sure it is running and the base URL is correct.";
  }
  if (lower.includes("dns") || lower.includes("lookup")) {
    return "Could not resolve the server address. Check the base URL.";
  }
  if (lower.includes("invalid header")) {
    return "Invalid request header. Check your API key for stray characters.";
  }
  return raw || "Network error.";
}
