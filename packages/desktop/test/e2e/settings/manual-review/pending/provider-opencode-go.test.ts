import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON,
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_BASE_URL_INPUT,
  TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import {
  restartIntoWorkspace,
  seedReplayProvider,
} from "../../../helpers/model-provider-restart.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

describe("Todo149 OpenCode Go 模板创建", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("G149-01：按协议创建并保存假 Key，保留成员和个人身份", async function () {
    this.timeout(150_000);
    const repository = new NodePersonalProviderConfigRepository({
      filePath: getE2EAppDataPaths().configFile,
      pollingIntervalMs: false,
    });
    try {
      await prepareV4ConversationE2E({ skipProvider: true });
      await restartIntoWorkspace({
        afterElectronProcessExit: () =>
          seedReplayProvider({
            id: "e2e-go-seed",
            name: "E2E Go seed",
            apiKey: "E2E_GO_FAKE",
            baseURL: "https://e2e.invalid/v1",
            models: [],
          }),
      });
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      for (const [templateId, format, first, count] of [
        ["opencode-go-chat", /Chat Completions/i, "glm-5.3-flash", 15],
        ["opencode-go-messages", /Anthropic Messages/i, "minimax-m3", 8],
        ["opencode-go-responses", /Responses/i, "gpt-5.6-luna", 2],
      ] as const) {
        const before = new Set((await repository.read()).providers.keys());
        await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON);
        const card = $(
          `[data-provider-template-group="other"] [data-testid="${testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, templateId)}"]`,
        );
        await card.waitForExist({ timeout: 15_000 });
        await card.scrollIntoView({ block: "center" });
        await card.click();
        let providerId = "";
        await browser.waitUntil(
          async () => {
            providerId =
              (await repository.read()).providers.keys().find((id) => !before.has(id)) ?? "";
            return providerId !== "";
          },
          { timeout: 15_000 },
        );
        await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
        await browser.waitUntil(
          async () =>
            (await $(`[data-testid="${TID_MODEL_PROVIDER_BASE_URL_INPUT}"]`).getValue()) ===
            "https://opencode.ai/zen/go/v1",
          { timeout: 15_000 },
        );
        expect(
          await $(`[data-testid="${TID_MODEL_PROVIDER_API_FORMAT_TRIGGER}"]`).getText(),
        ).toMatch(format);
        await $(`[data-model-provider-model-id="${first}"]`).waitForExist({ timeout: 15_000 });
        expect(await $$("[data-model-provider-model-id]").length).toBe(count);
        expect(
          await $$(
            '//button[normalize-space(.)="获取 API Key" or normalize-space(.)="Get API Key"]',
          ).length,
        ).toBe(1);
        const key = $(`[data-testid="${TID_MODEL_PROVIDER_API_KEY_INPUT}"]`);
        await key.setValue("E2E_GO_FAKE_KEY");
        await browser.keys("Tab");
        await browser.waitUntil(
          async () => {
            const access = (await repository.read()).providers.get(providerId)?.access;
            return access?.type === "api-key" && access.apiKey === "E2E_GO_FAKE_KEY";
          },
          { timeout: 15_000 },
        );
        expect((await repository.read()).providers.getRule(providerId)?.templateId).toBe(
          templateId,
        );
        // 假 Key 只验证创建与保存，不点击连接测试或发送聊天；协议 wire 由离线 Adapter 用例验证。
      }
    } finally {
      repository.dispose();
    }
  });
});
