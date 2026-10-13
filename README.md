# NotepadAI

Classic notepad with an AI rewrite helper, built with Tauri + Vanilla TS.

## Prerequisites

- Node.js 18+ (npm or pnpm).
- Rust toolchain (`rustup` + stable).
- Tauri build deps for your OS:
  - Linux: `webkit2gtk`, `libsoup`, `gtk`, `openssl` (package names vary by distro).
  - Windows: Microsoft Visual Studio Build Tools (C++), WebView2 Runtime.
  - macOS: Xcode command line tools.

## Setup

1) Install dependencies:
```
npm install
```

2) Run in dev mode:
```
npm run tauri dev
```

## Build (Release Bundles)

```
npm run tauri build
```

- Linux builds produce `.deb`/`.rpm` bundles in `src-tauri/target/release/bundle`.
- Windows builds produce a `.exe` bundle in `src-tauri/target/release/bundle/windows`.
- macOS builds produce `.app` bundles in `src-tauri/target/release/bundle/macos`.

Note: Tauri bundles are OS-specific. You must build on Windows to get a `.exe`. Building on Linux only produces Linux bundles.

## AI Providers

AI Settings supports 18 providers through a shared adapter architecture (`src/providers/`):

**Local / self-hosted** — Ollama, LM Studio, LocalAI, vLLM, llama.cpp server, and a generic "Custom (OpenAI-compatible)" provider for any other OpenAI-compatible server. Base URL is editable (defaults to each tool's usual local port); API key is optional.

**Cloud** — OpenAI, Anthropic Claude, Google Gemini, Groq, DeepSeek, Mistral AI, xAI Grok, OpenRouter, Together AI, Fireworks AI, Cerebras, Perplexity. Base URL is fixed to the provider's official API host; an API key is required.

All providers support: streaming responses (shown live in the editor as they generate, with a Stop button), model discovery via "Fetch Models" (except Perplexity, which has no official model-list endpoint — enter the model id manually), and "Test Connection".

### Configuring a provider

1. Open **AI → Settings**.
2. Pick a provider. Local providers show an editable Base URL field; cloud providers show their fixed API host.
3. Enter or fetch a Model id. OpenAI additionally shows optional Organization/Project fields.
4. Paste an API key if the provider requires one (stored in the OS keyring, one secret per provider — switching providers never clears another provider's key or settings).
5. Click **Test Connection**, then **Save**.

If a local/custom base URL is non-loopback and a key is configured, a one-time "trust this host" confirmation appears before the key is ever sent, to avoid accidentally sending a secret to the wrong server.

### Request/response handling

- Every adapter builds its own request (auth headers, body shape, endpoint path) and parses its own response — OpenAI-compatible providers share one implementation (`src/providers/openaiCompatible.ts`); Ollama, Anthropic, and Gemini each have a bespoke one, since their APIs don't match the OpenAI shape.
- Streaming: SSE (`data: ...` frames) for OpenAI-compatible/Anthropic/Gemini, NDJSON lines for Ollama. Network requests (including streaming) run in the Tauri/Rust backend via `http_request` / `ai_stream_request`, never a direct WebView fetch — this avoids CORS issues and keeps provider knowledge (and secrets) out of the browser devtools network tab.
- Errors (401/403/404/429/5xx, connection-refused, DNS failure, timeout, invalid JSON, empty response) are classified into plain-language messages in `src/providers/errors.ts` without ever echoing request headers or the API key.
- A stream interrupted mid-generation (network drop, or the Stop button) keeps whatever partial text was already generated and offers the usual Apply / Keep Both / Copy / Cancel choices, rather than discarding it.

### Adding another provider

Most providers are pure configuration, not new code. In `src/providers/registry.ts`, add an entry with the provider's id/label/category/base URL/model placeholder, and an adapter:
- If it's OpenAI-compatible (most are), call `createOpenAiCompatibleAdapter({ chatPath, modelsPath })` from `openaiCompatible.ts` — no new code needed.
- If its request/response/streaming shape is genuinely different, write a new adapter module implementing the `ProviderAdapter` interface (`src/providers/types.ts`) and reference it from the registry.

### Known limitations

- Perplexity has no official model-list endpoint, so "Fetch Models" is disabled for it and "Test Connection" falls back to a minimal real chat request (a few tokens) rather than a free metadata call.
- Fixed-base-URL cloud providers don't offer a base-URL override (e.g. for an enterprise proxy in front of OpenAI) — use the "Custom (OpenAI-compatible)" provider for that instead.
- Anthropic's `max_tokens` is a fixed value (4096), not user-configurable, to keep the settings UI simple.
- Cancelling a stream is cooperative (checked between chunks); a connection that stalls completely with no data arriving won't be interrupted instantly by Stop — this matches the lack of an overall request timeout, which is intentional so legitimately slow local-model generations aren't cut off.
- This was built and tested via `cargo check`, the TypeScript build, and the mocked-response test suite below; I was not able to click through the live GUI in this environment (no display), so a manual `npm run tauri dev` smoke test is still recommended before shipping.

## Settings Storage and Migration

- Non-secret settings (active provider, per-provider base URL/model/org/project, custom prompt, trusted hosts) are stored in `settings.json` via `@tauri-apps/plugin-store` (`src/settings.ts`).
- API keys are stored in the OS keyring, one secret per provider, never written in plaintext or logged.
- The pre-multi-provider settings format (a single `apiEndpoint` + `customPrompt`, one keyring secret) is migrated automatically and exactly once on first load: the old Ollama-vs-generic heuristic (`/api/generate` suffix) decides which provider the old endpoint becomes, and the single legacy keyring secret moves to that provider's account.

## Testing

```
npm run test
```

Runs the full suite (Vitest) against every provider adapter (request building, response/SSE/NDJSON stream parsing including chunk-boundary splits, model-list parsing, error classification), the HTTP/streaming client (mocked `invoke`/`listen`, no network calls), and settings load/migration — no API keys or live network access required.

## Configuration Files

- `src-tauri/tauri.conf.json`: app metadata, bundling targets, window settings.
- `src-tauri/capabilities/default.json`: Tauri capability permissions for the main window.
- `src/main.ts`: frontend logic, settings UI wiring, and the AI rewrite/streaming flow.
- `src/providers/`: provider adapters, registry, HTTP/streaming client.
- `src/settings.ts`: settings persistence, legacy migration, per-provider secret helpers.

## Recommended IDE Setup

- VS Code + Tauri extension + rust-analyzer

## Contributing

See `CONTRIBUTING.md` for setup and PR guidelines.

## Code of Conduct

See `CODE_OF_CONDUCT.md`.

## Security

See `SECURITY.md`.

## License

MIT. See `LICENSE`.
