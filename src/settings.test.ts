import { describe, expect, it, vi } from "vitest";
import {
  buildMigratedSettings,
  defaultSettings,
  hostOf,
  isLoopbackHost,
  loadSettings,
  needsHostTrustWarning,
  saveSettings,
  type StoreLike,
} from "./settings";

function fakeStore(initial: Record<string, unknown> = {}): StoreLike & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    async get(key: string) {
      return data[key] as never;
    },
    async set(key: string, value: unknown) {
      data[key] = value;
    },
    async save() {
      // no-op for the in-memory fake
    },
  };
}

describe("buildMigratedSettings", () => {
  it("detects the legacy Ollama heuristic (/api/generate + ?model=)", () => {
    const { settings, migratedProviderId } = buildMigratedSettings({
      apiEndpoint: "http://localhost:11434/api/generate?model=llama3",
      customPrompt: "Be terse.",
    });
    expect(migratedProviderId).toBe("ollama");
    expect(settings.activeProviderId).toBe("ollama");
    expect(settings.providers.ollama).toEqual({ baseUrl: "http://localhost:11434", model: "llama3" });
  });

  it("falls back to the custom OpenAI-compatible provider for any other endpoint shape", () => {
    const { settings, migratedProviderId } = buildMigratedSettings({
      apiEndpoint: "https://example.com/rewrite",
      customPrompt: "",
    });
    expect(migratedProviderId).toBe("openai_compatible");
    expect(settings.providers.openai_compatible.baseUrl).toBe("https://example.com");
  });

  it("keeps the default prompt when none was stored", () => {
    const { settings } = buildMigratedSettings({});
    expect(settings.customPrompt).toBe(defaultSettings().customPrompt);
  });

  it("reports no migration target when there was no legacy endpoint (fresh install)", () => {
    const { migratedProviderId } = buildMigratedSettings({ customPrompt: "hi" });
    expect(migratedProviderId).toBeNull();
  });
});

describe("loadSettings", () => {
  it("migrates a legacy store exactly once and persists version:2", async () => {
    const store = fakeStore({ apiEndpoint: "http://localhost:11434/api/generate?model=qwen3:4b" });
    const migrateLegacyApiKey = vi.fn().mockResolvedValue(true);

    const settings = await loadSettings({ store, migrateLegacyApiKey });

    expect(settings.activeProviderId).toBe("ollama");
    expect(settings.providers.ollama.model).toBe("qwen3:4b");
    expect(store.data.version).toBe(2);
    expect(migrateLegacyApiKey).toHaveBeenCalledWith("ollama");
  });

  it("does not attempt key migration on a fresh install with no legacy endpoint", async () => {
    const store = fakeStore({});
    const migrateLegacyApiKey = vi.fn().mockResolvedValue(false);

    await loadSettings({ store, migrateLegacyApiKey });

    expect(migrateLegacyApiKey).not.toHaveBeenCalled();
  });

  it("loads an already-migrated (version: 2) store as-is without re-migrating", async () => {
    const store = fakeStore({
      version: 2,
      activeProviderId: "openai",
      providers: { openai: { model: "gpt-4.1-mini" } },
      customPrompt: "custom",
      trustedHosts: ["example.com"],
    });
    const migrateLegacyApiKey = vi.fn();

    const settings = await loadSettings({ store, migrateLegacyApiKey });

    expect(settings.activeProviderId).toBe("openai");
    expect(settings.providers.openai.model).toBe("gpt-4.1-mini");
    expect(settings.trustedHosts).toEqual(["example.com"]);
    expect(migrateLegacyApiKey).not.toHaveBeenCalled();
  });

  it("preserves every other provider's config when loading version:2 (switching providers never drops settings)", async () => {
    const store = fakeStore({
      version: 2,
      activeProviderId: "openai",
      providers: { openai: { model: "gpt-4.1-mini" }, anthropic: { model: "claude-sonnet-4-5" } },
      customPrompt: "custom",
      trustedHosts: [],
    });
    const settings = await loadSettings({ store, migrateLegacyApiKey: vi.fn() });
    expect(settings.providers.anthropic.model).toBe("claude-sonnet-4-5");
    expect(settings.providers.ollama).toEqual({ model: "" });
  });

  it("defaults customUseCases to an empty list when absent (older version:2 store, pre-use-case feature)", async () => {
    const store = fakeStore({ version: 2, activeProviderId: "ollama", providers: {}, customPrompt: "", trustedHosts: [] });
    const settings = await loadSettings({ store, migrateLegacyApiKey: vi.fn() });
    expect(settings.customUseCases).toEqual([]);
  });

  it("loads stored custom use cases", async () => {
    const store = fakeStore({
      version: 2,
      activeProviderId: "ollama",
      providers: {},
      customPrompt: "",
      trustedHosts: [],
      customUseCases: [{ id: "1", label: "Slack Message", prompt: "Rewrite as a casual Slack message." }],
    });
    const settings = await loadSettings({ store, migrateLegacyApiKey: vi.fn() });
    expect(settings.customUseCases).toEqual([{ id: "1", label: "Slack Message", prompt: "Rewrite as a casual Slack message." }]);
  });
});

describe("saveSettings round-trip", () => {
  it("round-trips through the store", async () => {
    const store = fakeStore();
    const settings = defaultSettings();
    settings.activeProviderId = "groq";
    settings.providers.groq = { model: "llama-3.3-70b-versatile" };
    settings.trustedHosts = ["my-proxy.internal"];
    settings.customUseCases = [{ id: "1", label: "Slack Message", prompt: "Rewrite as a casual Slack message." }];

    await saveSettings(store, settings);
    const reloaded = await loadSettings({ store, migrateLegacyApiKey: vi.fn() });

    expect(reloaded).toEqual(settings);
  });
});

describe("host trust warning", () => {
  it("never warns for loopback hosts even with a key configured", () => {
    expect(needsHostTrustWarning("http://localhost:1234", true, [])).toBe(false);
    expect(needsHostTrustWarning("http://127.0.0.1:8080", true, [])).toBe(false);
  });

  it("never warns when no API key is configured", () => {
    expect(needsHostTrustWarning("https://sketchy.example.com", false, [])).toBe(false);
  });

  it("warns for a non-loopback host with a key, until the host is trusted", () => {
    expect(needsHostTrustWarning("https://my-proxy.internal", true, [])).toBe(true);
    expect(needsHostTrustWarning("https://my-proxy.internal", true, ["my-proxy.internal"])).toBe(false);
  });

  it("hostOf extracts host:port, ignoring the scheme and path", () => {
    expect(hostOf("https://my-proxy.internal:9999/v1/chat")).toBe("my-proxy.internal:9999");
  });

  it("isLoopbackHost recognizes localhost, 127.0.0.1, and ::1", () => {
    expect(isLoopbackHost("localhost:1234")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:8080")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});
