import { invoke } from "@tauri-apps/api/core";
import { PROVIDER_ORDER } from "./providers/registry";
import type { ProviderConfig, ProviderId } from "./providers/types";

export const DEFAULT_PROMPT = "Make this clearer and more concise while preserving meaning.";

export type CustomUseCase = {
  id: string;
  label: string;
  prompt: string;
};

export type AppSettings = {
  version: 2;
  activeProviderId: ProviderId;
  providers: Record<ProviderId, ProviderConfig>;
  customPrompt: string;
  trustedHosts: string[];
  customUseCases: CustomUseCase[];
};

/** Minimal surface of `@tauri-apps/plugin-store`'s Store, so settings logic can be unit tested with an in-memory fake instead of the real plugin. */
export type StoreLike = {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

function emptyProviders(): Record<ProviderId, ProviderConfig> {
  return Object.fromEntries(PROVIDER_ORDER.map((id) => [id, { model: "" }])) as Record<ProviderId, ProviderConfig>;
}

export function defaultSettings(): AppSettings {
  return {
    version: 2,
    activeProviderId: "ollama",
    providers: emptyProviders(),
    customPrompt: DEFAULT_PROMPT,
    trustedHosts: [],
    customUseCases: [],
  };
}

type LegacyDetection = { id: ProviderId; baseUrl?: string; model: string };

/** Mirrors the pre-multi-provider heuristic: a URL ending in /api/generate was Ollama, anything else was a generic custom endpoint. */
function detectLegacyProvider(endpoint: string): LegacyDetection {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { id: "openai_compatible", model: "" };
  }
  if (url.pathname.endsWith("/api/generate")) {
    return {
      id: "ollama",
      baseUrl: `${url.protocol}//${url.host}`,
      model: url.searchParams.get("model") || "",
    };
  }
  // The old generic path posted an arbitrary {text, prompt} body to the exact
  // URL entered. The new custom provider always posts OpenAI-style chat
  // completions to "<baseUrl>/v1/chat/completions", so only the origin can be
  // carried forward safely — the model and exact path need re-entry.
  return { id: "openai_compatible", baseUrl: `${url.protocol}//${url.host}`, model: "" };
}

export type LegacyStoreShape = {
  apiEndpoint?: string;
  customPrompt?: string;
};

export function buildMigratedSettings(legacy: LegacyStoreShape): {
  settings: AppSettings;
  migratedProviderId: ProviderId | null;
} {
  const settings = defaultSettings();
  settings.customPrompt = legacy.customPrompt?.trim() || DEFAULT_PROMPT;

  if (!legacy.apiEndpoint) {
    return { settings, migratedProviderId: null };
  }

  const detected = detectLegacyProvider(legacy.apiEndpoint);
  settings.activeProviderId = detected.id;
  settings.providers[detected.id] = {
    ...settings.providers[detected.id],
    baseUrl: detected.baseUrl,
    model: detected.model,
  };
  return { settings, migratedProviderId: detected.id };
}

export async function saveSettings(store: StoreLike, settings: AppSettings): Promise<void> {
  await store.set("version", settings.version);
  await store.set("activeProviderId", settings.activeProviderId);
  await store.set("providers", settings.providers);
  await store.set("customPrompt", settings.customPrompt);
  await store.set("trustedHosts", settings.trustedHosts);
  await store.set("customUseCases", settings.customUseCases);
  await store.save();
}

export type SettingsIO = {
  store: StoreLike;
  /** Moves the single legacy keyring secret to the per-provider account. Returns true if a legacy secret existed and was moved. */
  migrateLegacyApiKey: (targetProvider: ProviderId) => Promise<boolean>;
};

/**
 * Loads settings, migrating the pre-multi-provider schema (a single
 * `apiEndpoint` + `customPrompt`, no `version` key) exactly once. On a fresh
 * install there's no legacy endpoint, so this just produces defaults.
 */
export async function loadSettings(io: SettingsIO): Promise<AppSettings> {
  const version = await io.store.get<number>("version");
  if (version === 2) {
    const [activeProviderId, providers, customPrompt, trustedHosts, customUseCases] = await Promise.all([
      io.store.get<ProviderId>("activeProviderId"),
      io.store.get<Record<ProviderId, ProviderConfig>>("providers"),
      io.store.get<string>("customPrompt"),
      io.store.get<string[]>("trustedHosts"),
      io.store.get<CustomUseCase[]>("customUseCases"),
    ]);
    return {
      version: 2,
      activeProviderId: activeProviderId || "ollama",
      providers: { ...emptyProviders(), ...(providers || {}) },
      customPrompt: customPrompt || DEFAULT_PROMPT,
      trustedHosts: trustedHosts || [],
      customUseCases: customUseCases || [],
    };
  }

  const [apiEndpoint, customPrompt] = await Promise.all([
    io.store.get<string>("apiEndpoint"),
    io.store.get<string>("customPrompt"),
  ]);
  const { settings, migratedProviderId } = buildMigratedSettings({
    apiEndpoint: apiEndpoint ?? undefined,
    customPrompt: customPrompt ?? undefined,
  });
  await saveSettings(io.store, settings);
  if (migratedProviderId) {
    await io.migrateLegacyApiKey(migratedProviderId);
  }
  return settings;
}

// --- Per-provider secret storage (OS keyring via Rust), and trusted-host warnings ---

export async function getProviderApiKey(providerId: ProviderId): Promise<string | null> {
  try {
    return (await invoke<string | null>("get_api_key", { provider: providerId })) || null;
  } catch {
    return null;
  }
}

export async function setProviderApiKey(providerId: ProviderId, key: string): Promise<void> {
  await invoke("set_api_key", { provider: providerId, key });
}

export async function deleteProviderApiKey(providerId: ProviderId): Promise<void> {
  await invoke("delete_api_key", { provider: providerId });
}

export async function migrateLegacyApiKey(targetProvider: ProviderId): Promise<boolean> {
  try {
    return await invoke<boolean>("migrate_legacy_api_key", { targetProvider });
  } catch {
    return false;
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.split(":")[0];
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "[::1]";
}

/** Whether to show the "you're about to send your API key to <host>" confirmation before this request. */
export function needsHostTrustWarning(baseUrl: string, hasApiKey: boolean, trustedHosts: string[]): boolean {
  if (!hasApiKey) return false;
  const host = hostOf(baseUrl);
  if (!host || isLoopbackHost(host)) return false;
  return !trustedHosts.includes(host);
}
