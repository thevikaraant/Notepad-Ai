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

## App Settings and AI Requests

- Settings storage: API endpoint + custom prompt are stored in `settings.json` via `@tauri-apps/plugin-store`.
- API key storage: stored securely in the OS keyring via Tauri commands, never written in plaintext.
- AI request shape: POST to the configured endpoint with JSON:
```
{ "text": "<input>", "prompt": "<customPrompt>" }
```
- Response parsing supports `{text}`, `{output}`, `{result}`, `{response}`, or OpenAI-style `choices[0].message.content` / `choices[0].text`.
- Network requests are executed in the Tauri backend (Rust) to avoid WebView CORS restrictions in packaged apps.

## Configuration Files

- `src-tauri/tauri.conf.json`: app metadata, bundling targets, window settings.
- `src-tauri/capabilities/default.json`: Tauri capability permissions for the main window.
- `src/main.ts`: frontend logic and AI rewrite flow.

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
