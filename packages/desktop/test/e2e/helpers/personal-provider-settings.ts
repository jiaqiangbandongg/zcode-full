import {
  TID_MODEL_PROVIDER_API_FORMAT_ITEM,
  TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON,
  TID_MODEL_PROVIDER_BASE_URL_INPUT,
  TID_MODEL_PROVIDER_NAME_EDIT_BUTTON,
  TID_MODEL_PROVIDER_NAME_INPUT,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  testId,
} from "@zcode/shared";
import type { ProviderApiType } from "@zcode/provider";
import {
  clickTestIdByDom,
  clickTestIdByWebDriver,
  readModelProviders,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "./desktop-app.js";

export async function createAndConfigurePersonalProvider({
  apiFormat,
  apiKey,
  baseURL,
  providerName,
  templateId,
}: {
  apiFormat?: ProviderApiType;
  apiKey: string;
  baseURL: string;
  providerName: string;
  templateId?: string;
}) {
  const providerIdsBeforeCreate = templateId
    ? new Set((await readModelProviders()).map((provider) => provider.id))
    : null;
  // Template 选择只决定创建基线；点击具体卡片后才原子创建 Personal Provider。
  // 后续字段各自通过 blur / select 自动保存，不再存在第二个“添加供应商”提交动作。
  const addProviderClickOptions = {
    timeout: 30_000,
    timeoutMsg: templateId
      ? "设置页没有出现从模板添加供应商入口"
      : "设置页没有出现添加自定义模型供应商入口",
  };
  await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON, addProviderClickOptions);
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, templateId ?? "custom"), {
    timeout: 15_000,
    timeoutMsg: templateId
      ? `Provider Template 选择页没有出现 ${templateId}`
      : "Provider Template 选择页没有出现自定义供应商入口",
  });
  if (templateId) {
    let createdProviderId: string | undefined;
    await browser.waitUntil(
      async () => {
        createdProviderId = (await readModelProviders()).find(
          (provider) => !providerIdsBeforeCreate?.has(provider.id),
        )?.id;
        return Boolean(createdProviderId);
      },
      {
        timeout: 15_000,
        timeoutMsg: `选择 ${templateId} 后没有创建新的 Personal Provider 实例`,
      },
    );
    if (!createdProviderId) {
      throw new Error(`选择 ${templateId} 后缺少新 Provider ID`);
    }
    // Template 创建是异步写盘。旧详情卡在切换完成前仍然可编辑，若立即重命名会
    // 错改上一个实例；等待新身份出现后再精确选择新实例。
    await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${createdProviderId}`), {
      timeout: 15_000,
      timeoutMsg: `新建的 Template Provider 没有进入导航: ${createdProviderId}`,
    });
  }
  await waitForTestIdByDom("model-provider-actions-button", {
    timeout: 15_000,
    timeoutMsg: "原子创建后没有进入新供应商详情",
  });

  await $('[data-testid="model-provider-actions-button"]').click();
  await clickTestIdByDom(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON);
  await setInputValueByTestIdDom(TID_MODEL_PROVIDER_NAME_INPUT, providerName, {
    timeoutMsg: "新供应商名称输入框没有出现",
  });
  await browser.execute((testId) => {
    const input = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
    input?.focus();
    input?.blur();
  }, TID_MODEL_PROVIDER_NAME_INPUT);
  await browser.waitUntil(
    () =>
      browser.execute(
        (expectedName, customNavItemPrefix) => {
          // Provider ID 是稳定身份，重命名只更新 label；不能把展示名拼成导航 key。
          return Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid^="${customNavItemPrefix}"]`),
          ).some((item) => item.textContent?.trim() === expectedName);
        },
        providerName,
        testId(TID_MODEL_PROVIDER_NAV_ITEM, "custom:"),
      ),
    {
      timeout: 15_000,
      timeoutMsg: `新供应商没有完成原子重命名: ${providerName}`,
    },
  );

  await setInputValueByTestIdDom(TID_MODEL_PROVIDER_BASE_URL_INPUT, baseURL, {
    timeoutMsg: "新供应商 Base URL 输入框没有出现",
  });
  await setInputValueByTestIdDom(TID_MODEL_PROVIDER_API_KEY_INPUT, apiKey, {
    timeoutMsg: "新供应商 API Key 输入框没有出现",
  });

  if (apiFormat) {
    await clickTestIdByWebDriver(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER, {
      timeout: 15_000,
      timeoutMsg: "新供应商 API 格式下拉没有出现",
    });
    await clickTestIdByWebDriver(testId(TID_MODEL_PROVIDER_API_FORMAT_ITEM, apiFormat), {
      timeout: 15_000,
      timeoutMsg: `新供应商 API 格式选项没有出现: ${apiFormat}`,
    });
  }
}
