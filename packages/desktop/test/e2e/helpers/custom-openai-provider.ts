import {
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  readModelProviders,
  resolveE2EProviderRuntimeBaseUrl,
  waitForWorkspaceApp,
  type E2EModelProviderSnapshot,
} from "./desktop-app.js";
import {
  resolveSeededReplayBaseUrl,
  seedCustomOpenAIChatCompletionsProvider,
} from "./custom-openai-provider-store.js";
import { getUpstreamApiKey } from "./upstream-provider.js";
import { reloadElectronSessionSafely } from "./e2e-electron-reload.js";
import { sel } from "./selectors.js";
import { createAndConfigurePersonalProvider } from "./personal-provider-settings.js";
import { saveProviderModelMetadataDialog } from "./provider-model-metadata-dialog.js";

export { seedCustomOpenAIChatCompletionsProvider, saveProviderModelMetadataDialog };

interface CreateCustomOpenAIProviderOptions {
  baseURL?: string;
  modelId: string;
  providerName: string;
}

interface SeedCustomOpenAIProviderOptions {
  inputModalities?: readonly ("text" | "image" | "video" | "audio" | "pdf")[];
  modelId: string;
  providerId: string;
  providerName: string;
}

export async function restartWithSeededOpenAIProviders(
  providers: readonly SeedCustomOpenAIProviderOptions[],
) {
  const seededProviders: E2EModelProviderSnapshot[] = [];
  await reloadElectronSessionSafely(browser, {
    afterElectronProcessExit: async () => {
      // Bug 根因：运行中的 Host 可能在测试写入期间刷新 Personal Config。
      // 每个 spec 已有独立 HOME，但同一 HOME 内仍必须等旧 Electron/Host/Agent 全退出，
      // 再原子地建立下一次启动读取的唯一 Personal Provider Config。
      for (const provider of providers) {
        seededProviders.push(await seedCustomOpenAIChatCompletionsProvider(provider));
      }
    },
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
  return seededProviders;
}

export async function createCustomOpenAIChatCompletionsProvider({
  baseURL: explicitBaseURL,
  modelId,
  providerName,
}: CreateCustomOpenAIProviderOptions) {
  const baseURL = explicitBaseURL?.trim() || (await resolveSeededReplayBaseUrl());
  if (!baseURL) {
    throw new Error(
      "没有找到已 seed 的 replay provider Base URL，无法新增 OpenAI-compatible provider",
    );
  }

  await openModelProviderSettings();
  await createAndConfigurePersonalProvider({
    apiFormat: "openai-chat-completions",
    apiKey: getUpstreamApiKey(),
    baseURL,
    providerName,
  });

  await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON, {
    timeout: 15000,
    timeoutMsg: "新增 provider 添加模型按钮没有出现",
  });
  await addModelThroughMetadataDialog(modelId);

  return waitForCreatedOpenAIProvider(providerName, baseURL, modelId);
}

export async function refreshSeededOpenAIProvidersThroughSettings(
  providerNames: readonly string[],
) {
  await openModelProviderSettings();
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (candidate) => {
            const label = candidate.getAttribute("aria-label")?.trim() ?? "";
            return label === "Refresh" || label === "刷新";
          },
        );
        if (!button || button.disabled || button.getAttribute("aria-busy") === "true") {
          return false;
        }
        button.click();
        return true;
      }),
    {
      timeout: 30000,
      timeoutMsg: "设置页模型供应商刷新按钮没有进入可点击状态",
    },
  );
  await browser.waitUntil(
    async () =>
      browser.execute((expectedNames) => {
        const bodyText = document.body?.innerText ?? "";
        return expectedNames.every((name) => bodyText.includes(name));
      }, providerNames),
    {
      timeout: 30000,
      timeoutMsg: `设置页没有刷新出 direct seed 的 provider: ${providerNames.join(", ")}`,
    },
  );
  // 修复原因：direct seed 修改的是 Personal Config 文件；进程 Registry 已经水合后，
  // 单纯进入设置页只会复用当前 View。必须走真实刷新按钮触发 Config/Registry 重读，
  // 不能依赖页面挂载时机碰运气。
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

async function openModelProviderSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });
}

async function addModelThroughMetadataDialog(modelId: string) {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        return Boolean(dialog?.querySelector("input"));
      }),
    {
      timeout: 15000,
      timeoutMsg: "新增 provider 模型 metadata 弹窗没有出现",
    },
  );

  const inputIndex = await browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) {
      return -1;
    }
    const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>("input"));
    return inputs.findIndex((input) => {
      const label = input.parentElement?.querySelector("label")?.textContent?.trim() ?? "";
      const placeholder = input.getAttribute("placeholder") ?? "";
      return [label, placeholder].some((text) => /^(模型 ID|Model ID)$/i.test(text.trim()));
    });
  });
  if (inputIndex < 0) {
    throw new Error("新增 provider 模型 metadata 弹窗没有模型 ID 输入框");
  }

  const inputs = await $$('[role="dialog"] input');
  const modelInput = inputs[inputIndex];
  if (!modelInput) {
    throw new Error(`新增 provider 模型 metadata 输入框索引失效: ${inputIndex}`);
  }
  await modelInput.waitForDisplayed({ timeout: 5000 });
  await modelInput.setValue(modelId);
  await browser.waitUntil(async () => (await modelInput.getValue()) === modelId, {
    timeout: 5000,
    timeoutMsg: `新增 provider 模型 ID 没有写入输入框: ${modelId}`,
  });

  await saveProviderModelMetadataDialog("provider");
}

async function waitForCreatedOpenAIProvider(
  providerName: string,
  baseURL: string,
  modelId: string,
) {
  let latestProviders: E2EModelProviderSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latestProviders = await readModelProviders();
      const provider = latestProviders.find((candidate) => candidate.name === providerName);
      return Boolean(
        provider &&
        provider.apiFormat === "openai-chat-completions" &&
        provider.defaultKind === "openai-compatible" &&
        provider.apiKey.trim() === getUpstreamApiKey() &&
        hasEndpoint(provider, baseURL) &&
        resolveE2EProviderRuntimeBaseUrl(provider) === baseURL &&
        hasModel(provider, modelId),
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `新增 provider 没有保存到本地配置: ${providerName}`,
    },
  );

  const provider = latestProviders.find((candidate) => candidate.name === providerName);
  if (!provider) {
    throw new Error(`新增 provider 等待后仍不存在: ${providerName}`);
  }
  return provider;
}

function hasEndpoint(provider: E2EModelProviderSnapshot, baseURL: string) {
  return Object.values(provider.endpoints ?? {}).some((value) => {
    if (typeof value !== "string") {
      return false;
    }
    return value.trim() === baseURL;
  });
}

function hasModel(provider: E2EModelProviderSnapshot, modelId: string) {
  return provider.models.some((model) =>
    typeof model === "string" ? model === modelId : model.id === modelId,
  );
}
