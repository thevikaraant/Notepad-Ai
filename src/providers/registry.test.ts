import { describe, expect, it } from "vitest";
import { PROVIDERS, PROVIDER_ORDER, getProviderDefinition, resolveEffectiveConfig } from "./registry";

describe("registry", () => {
  it("defines all 18 providers from the spec exactly once", () => {
    expect(PROVIDER_ORDER).toHaveLength(18);
    expect(new Set(PROVIDER_ORDER).size).toBe(18);
  });

  it("gives every cloud provider a fixed, non-editable base URL", () => {
    for (const id of PROVIDER_ORDER) {
      const def = PROVIDERS[id];
      if (def.category === "cloud") {
        expect(def.baseUrlEditable).toBe(false);
        expect(def.defaultBaseUrl).toBeTruthy();
      }
    }
  });

  it("gives every local provider an editable base URL", () => {
    for (const id of PROVIDER_ORDER) {
      const def = PROVIDERS[id];
      if (def.category === "local") {
        expect(def.baseUrlEditable).toBe(true);
      }
    }
  });

  it("only OpenAI supports organization/project fields", () => {
    for (const id of PROVIDER_ORDER) {
      expect(PROVIDERS[id].supportsOrgProject).toBe(id === "openai");
    }
  });

  it("Perplexity has no model-list support (no official endpoint)", () => {
    expect(PROVIDERS.perplexity.adapter.supportsModelList).toBe(false);
  });

  it("every other provider supports model listing", () => {
    for (const id of PROVIDER_ORDER) {
      if (id === "perplexity") continue;
      expect(PROVIDERS[id].adapter.supportsModelList).toBe(true);
    }
  });

  it("throws for an unknown provider id", () => {
    // @ts-expect-error intentionally invalid id for the error-path test
    expect(() => getProviderDefinition("not-a-provider")).toThrow(/Unknown provider/);
  });
});

describe("resolveEffectiveConfig", () => {
  it("keeps the user's own base URL when set", () => {
    const resolved = resolveEffectiveConfig("ollama", { baseUrl: "http://192.168.1.50:11434", model: "m" });
    expect(resolved.baseUrl).toBe("http://192.168.1.50:11434");
  });

  it("falls back to the provider default when unset", () => {
    const resolved = resolveEffectiveConfig("ollama", { model: "m" });
    expect(resolved.baseUrl).toBe("http://localhost:11434");
  });

  it("fills in the fixed cloud base URL regardless of what's stored", () => {
    const resolved = resolveEffectiveConfig("openai", { model: "gpt-4.1-mini" });
    expect(resolved.baseUrl).toBe("https://api.openai.com");
  });

  it("leaves baseUrl undefined for the custom provider with nothing configured", () => {
    const resolved = resolveEffectiveConfig("openai_compatible", { model: "m" });
    expect(resolved.baseUrl).toBeUndefined();
  });
});
