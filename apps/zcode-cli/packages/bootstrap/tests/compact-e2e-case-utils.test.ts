import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as provider from "@zcode/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, writeProviderConfig } from "../../../e2e/compact-microcompact/case-utils.mjs";

describe("Compact E2E App admission", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-compact-helper-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    { kind: "openai-compatible", apiFormat: "openai-chat-completions", field: "max_tokens" },
    { kind: "anthropic", apiFormat: "anthropic-messages", field: "max_tokens" },
    { kind: "openai", apiFormat: "openai-responses", field: "max_output_tokens" },
  ])(
    "preserves case limits in an executable $apiFormat Registry",
    async ({ kind, apiFormat, field }) => {
      const configPath = join(root, "config.json");
      await writeProviderConfig(configPath, {
        kind,
        providerId: "continue-fixture",
        model: "fixture-model",
        apiKey: "fixture-key",
        baseURL: "https://fixture.invalid/v1",
        contextWindow: 100_000,
        maxOutputTokens: 16_000,
        storageDir: root,
      });
      const createZCodeApp = vi.fn(async (options) => options);
      const options = await createApp({
        configPath,
        modules: { provider, createZCodeApp },
        runtimeConfig: { workingDirectory: root },
        storageDir: root,
      });
      const selection = options.configuredDefaultModelSelection;
      const registry = options.providerRegistry as provider.ProviderRegistry;
      const providerConfig = registry.getProvider("continue-fixture")!.config;
      const modelConfig = registry.getModel("continue-fixture", "fixture-model")!.config;

      expect(selection).toEqual({
        providerId: "continue-fixture",
        modelId: "fixture-model",
        options: { reasoningLevel: "disabled" },
      });
      expect(registry.validateSelection(selection)).toEqual({ ok: true });
      expect(providerConfig.api).toMatchObject({
        type: apiFormat,
        baseUrl: "https://fixture.invalid/v1",
      });
      expect(providerConfig.validateComplete()).toEqual([]);
      expect(modelConfig.validateComplete()).toEqual([]);
      expect(modelConfig.properties.contextWindow).toBe(100_000);
      expect(modelConfig.optionSpecs.maxOutputTokens).toEqual({
        max: 16_000,
        map: `{"${field}":maxOutputTokens}`,
      });
      expect(createZCodeApp).toHaveBeenCalledOnce();
    },
  );

  it("forwards the original session identity to cold App creation", async () => {
    const configPath = join(root, "config.json");
    await writeProviderConfig(configPath, {
      providerId: "continue-fixture",
      model: "fixture-model",
      baseURL: "https://fixture.invalid/v1",
      storageDir: root,
    });
    const createZCodeApp = vi.fn(async (options) => options);
    const options = await createApp({
      configPath,
      modules: { provider, createZCodeApp },
      runtimeConfig: { workingDirectory: root },
      storageDir: root,
      resume: true,
      sessionId: "original-session",
    });

    // 只验证请求不含 Continue 会让“误建新 session”空过，必须保护真实恢复入口。
    expect(options).toMatchObject({ resume: true, sessionId: "original-session" });
  });
});
