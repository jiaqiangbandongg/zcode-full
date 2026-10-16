import { describe, expect, it, vi } from "vitest";
import type { ProviderSettingsView } from "@zcode/services";
import {
  loadProviderApiKey,
  persistProviderApiKey,
  resolveSettingsProviderApiKey,
  resolveSettingsProviderApiKeyManagementUrl,
} from "@/lib/providerApiKeyPersistence.js";

function createSettingsView(): ProviderSettingsView {
  return {
    revision: 1,
    addableProviders: [],
    providerOrder: [],
    providers: [
      {
        providerId: "zai-api",
        enabled: true,
        executable: true,
        accessAllowed: true,
        personalConfig: { label: "My Z.ai" },
        effectiveConfig: {
          label: "My Z.ai",
          access: {
            type: "api-key",
            apiKey: "old-key",
            apiKeyManagementUrl: "https://api.z.ai/keys",
          },
          api: { baseUrl: "https://api.z.ai" },
          builtinModelIds: ["glm-5"],
        },
        issues: [],
        models: [],
      },
    ],
  };
}

describe("Provider API Key Personal persistence", () => {
  it("恢复手动套餐 Key 保留类型，不要求账号连接", async () => {
    const view = createSettingsView();
    view.providers[0]!.effectiveConfig.access = {
      type: "zhipu-coding-plan-api-key",
      apiKey: "old",
    };
    const save = vi.fn();
    expect(resolveSettingsProviderApiKey(view, "zai-api")).toBe("old");
    await persistProviderApiKey({
      providerId: "zai-api",
      apiKey: "new",
      providerSettingsService: { getView: async () => view, savePersonalProviderOverlay: save },
    });
    expect(save).toHaveBeenCalledWith("zai-api", {
      label: "My Z.ai",
      access: { type: "zhipu-coding-plan-api-key", apiKey: "new" },
    });
  });
  it("只覆盖 Personal API Key，不复制 Official Effective 字段", async () => {
    const calls: string[] = [];
    const savePersonalProviderOverlay = vi.fn(async () => {
      calls.push("personal");
      return createSettingsView();
    });
    await persistProviderApiKey({
      providerId: "zai-api",
      apiKey: "new-key",
      providerSettingsService: {
        getView: async () => createSettingsView(),
        savePersonalProviderOverlay,
      },
    });

    expect(calls).toEqual(["personal"]);
    expect(savePersonalProviderOverlay).toHaveBeenCalledWith("zai-api", {
      label: "My Z.ai",
      access: { type: "api-key", apiKey: "new-key" },
    });
  });

  it("新 Settings View 不含目标 Provider 时拒绝回写旧事实源", async () => {
    await expect(
      persistProviderApiKey({
        providerId: "zai-api",
        apiKey: "new-key",
        providerSettingsService: {
          getView: async () => ({
            revision: 1,
            addableProviders: [],
            providerOrder: [],
            providers: [],
          }),
          savePersonalProviderOverlay: vi.fn(),
        },
      }),
    ).rejects.toThrow("Provider Settings View 中不存在 API Provider zai-api");
  });

  it("从 Settings Effective Config 读取当前 API Key", () => {
    expect(resolveSettingsProviderApiKey(createSettingsView(), "zai-api")).toBe("old-key");
    expect(resolveSettingsProviderApiKey(createSettingsView(), "missing")).toBeNull();
  });

  it("从 Settings Effective Config 读取 API Key 管理链接", () => {
    expect(resolveSettingsProviderApiKeyManagementUrl(createSettingsView(), "zai-api")).toBe(
      "https://api.z.ai/keys",
    );
    expect(
      resolveSettingsProviderApiKeyManagementUrl(createSettingsView(), "missing"),
    ).toBeUndefined();
  });

  it("读取时优先使用 Settings View，不触发旧 Provider 列表", async () => {
    await expect(
      loadProviderApiKey({
        providerId: "zai-api",
        providerSettingsService: { getView: async () => createSettingsView() },
      }),
    ).resolves.toBe("old-key");
  });

  it("Settings Service 已装配但读取失败时不回退旧 Provider 列表", async () => {
    await expect(
      loadProviderApiKey({
        providerId: "zai-api",
        providerSettingsService: {
          getView: async () => {
            throw new Error("settings unavailable");
          },
        },
      }),
    ).rejects.toThrow("settings unavailable");
  });
});
