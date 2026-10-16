import {
  BUILTIN_PROVIDER_TEMPLATE_IDS,
  TID_CHAT_ERROR_BANNER,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_BACK_BUTTON,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  readModelProvider,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "./helpers/desktop-app.js";
import {
  PROVIDER_READINESS_HISTORY_ASSISTANT_TEXT,
  PROVIDER_READINESS_HISTORY_SESSION_ID,
  PROVIDER_READINESS_HISTORY_TITLE,
  PROVIDER_READINESS_HISTORY_USER_TEXT,
} from "./helpers/provider-readiness-history-fixture.js";
import {
  selectV4TaskById,
  startNewV4Draft,
  waitForV4TimelineContaining,
} from "./helpers/v4-conversation.js";
import {
  countAgentProcessRows,
  isMainRendererUrl,
  isResourceManagerUrl,
  openResourceManager,
  switchToElectronRendererTarget,
  waitForAgentProcessCount,
  waitForResourceManagerReady,
} from "./helpers/resource-manager.js";

const E2E_PROVIDER_API_KEY = "e2e-login-api-key";

describe("Provider/model readiness 只门禁模型执行", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I23/I24: 空配置只启动唯一只读 Agent，保存 API Key provider 后复用并水合草稿模型", async function () {
    this.timeout(120000);

    await waitForTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON, {
      timeout: 30000,
      timeoutMsg: "空 auth/provider 冷启动后没有展示 API Key 配置入口",
    });
    await clickTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON);
    await clickTestIdByDom(TID_LOGIN_API_KEY_SKIP_BUTTON, {
      timeout: 15000,
      timeoutMsg: "API Key 登录页没有可用的暂时跳过入口",
    });
    await waitForDefaultWorkspaceReady(30000);
    await waitForModelConfigMissingBanner();

    // 修复原因：只看 Process Monitor 只能证明 CLI 启动，不能证明用户真的拿到了历史。
    // fixture 同时预置 tasks-index membership 与 CLI session：前者负责侧栏 row，后者必须
    // 通过真实 sessions-index/conversation 只读订阅打开并展示正文。
    await waitForProviderReadinessHistory();
    await selectV4TaskById(PROVIDER_READINESS_HISTORY_SESSION_ID);
    await waitForV4TimelineContaining(PROVIDER_READINESS_HISTORY_USER_TEXT);
    await waitForV4TimelineContaining(PROVIDER_READINESS_HISTORY_ASSISTANT_TEXT);
    await startNewV4Draft();
    await waitForModelConfigMissingBanner();

    const blockedDraft = "这条草稿必须保留，不能进入 pending command";
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, blockedDraft, {
      timeout: 15000,
      timeoutMsg: "缺模型草稿页没有可输入的 composer",
    });
    await clickTestIdByDom(TID_V4_COMPOSER_SEND, {
      timeout: 15000,
      timeoutMsg: "缺模型草稿页发送按钮不可用",
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          (inputTestId, expected) => {
            const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`) as
              | (HTMLElement & {
                  __zcodeLexicalInputE2E?: { getText: () => string };
                })
              | null;
            return input?.__zcodeLexicalInputE2E?.getText() === expected;
          },
          TID_V4_COMPOSER_INPUT,
          blockedDraft,
        ),
      {
        timeout: 10000,
        interval: 100,
        timeoutMsg: "缺模型发送被拒后 composer 没有保留原文",
      },
    );
    expect(
      await browser.execute(() => window.localStorage.getItem("zcode-v4-pending-commands:v1")),
    ).toBeNull();
    await waitForModelConfigMissingBanner();

    await openResourceManager();
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();
    // 修复原因：sessions-index 是活动与详情的事实源。provider 未就绪时若完全禁止
    // workspace CLI 启动，已有 task-index row 也无法读取正文；这里只允许只读 topic，
    // 写路径仍由门禁拒绝。
    await waitForAgentProcessCount(1, { workspaceNameSuffix: "-zcodeproject" });

    await switchToElectronRendererTarget(isMainRendererUrl);
    await clickModelSettingsFromMissingBanner();
    await selectActiveFamilyApiKeyProvider();
    await setInputValueByTestIdDom(TID_MODEL_PROVIDER_API_KEY_INPUT, E2E_PROVIDER_API_KEY, {
      timeout: 15000,
      timeoutMsg: "缺模型横幅没有打开 API Key provider 配置",
    });
    const provider = await waitForSavedApiKeyProvider();
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "模型供应商设置页没有返回入口",
    });
    await waitForDefaultWorkspaceReady(30000);

    const hydratedModel = provider.models.find(
      (model) => typeof model === "object" && !model.deleted && !model.disabledReason,
    );
    expect(hydratedModel).toBeDefined();
    await waitForHydratedDraftModel(
      hydratedModel && typeof hydratedModel === "object"
        ? (hydratedModel.name ?? hydratedModel.id)
        : "",
    );
    await waitForModelConfigMissingBannerCleared();

    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForAgentProcessCount(1, { workspaceNameSuffix: "-zcodeproject" });

    // 修复原因：只读 sessions-index 已经启动 workspace CLI；provider 就绪只提升写能力，
    // 稳定窗口内仍只能有一个 Agent，防止 read→write 升级重复创建进程。
    await browser.pause(1500);
    expect(await countAgentProcessRows({ workspaceNameSuffix: "-zcodeproject" })).toBe(1);
  });
});

async function waitForProviderReadinessHistory() {
  const itemTestId = testId(TID_TASK_ITEM, PROVIDER_READINESS_HISTORY_SESSION_ID);
  await waitForTestIdByDom(itemTestId, {
    timeout: 30000,
    timeoutMsg: "provider 未就绪时预置 tasks-index 历史行没有出现在侧栏",
  });
  const title = await browser.execute((targetTestId) => {
    return document
      .querySelector<HTMLElement>(`[data-testid="${targetTestId}"]`)
      ?.innerText.replace(/\s+/g, " ")
      .trim();
  }, itemTestId);
  expect(title).toContain(PROVIDER_READINESS_HISTORY_TITLE);
}

async function clickModelSettingsFromMissingBanner() {
  await browser.waitUntil(
    () =>
      browser.execute((bannerTestId) => {
        const banner = document.querySelector<HTMLElement>(`[data-testid="${bannerTestId}"]`);
        const button = Array.from(banner?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
          (candidate) => candidate.querySelector("svg.lucide-settings"),
        );
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }, TID_CHAT_ERROR_BANNER),
    {
      timeout: 15000,
      interval: 100,
      timeoutMsg: "缺模型横幅没有可用的模型配置入口",
    },
  );
}

async function selectActiveFamilyApiKeyProvider() {
  // ProviderFamilyPlanModeSwitch 只展示当前 family 的连接方式；从缺模型横幅进入时
  // 默认会落在 BigModel Coding Plan，并按当前 OAuth family 隐藏 Z.ai。I23/I24 的
  // 业务目标是配置一个可用 API Key provider，不是跨 family 切换，因此在当前 family
  // 的连接方式下拉框选择 BigModel API Key，触发产品规定的 apiKey mode 持久化。
  const modelProviderSectionTestId = testId(TID_SETTINGS_SECTION_NAV, "modelProvider");
  await waitForTestIdByDom(modelProviderSectionTestId, {
    timeout: 15_000,
    timeoutMsg: "缺模型横幅没有打开模型设置页",
  });
  await clickTestIdByDom(modelProviderSectionTestId, {
    timeout: 15_000,
    timeoutMsg: "设置页没有模型设置分区入口",
  });
  await clickTestIdByDom(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER, {
    timeout: 15_000,
    timeoutMsg: "模型设置页没有当前 family 的连接方式选择器",
  });
  await clickTestIdByDom(
    testId(
      TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
      `preset:${BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel}`,
    ),
    {
      timeout: 15_000,
      timeoutMsg: "模型设置页没有 BigModel API Key 连接方式",
    },
  );
}

async function waitForSavedApiKeyProvider() {
  let latest = await readModelProvider(BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel);
  await browser.waitUntil(
    async () => {
      latest = await readModelProvider(BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel);
      const provider = latest;
      return Boolean(
        provider?.apiKey?.trim() &&
        provider.models.some(
          (model) => typeof model === "object" && !model.deleted && !model.disabledReason,
        ),
      );
    },
    {
      timeout: 15000,
      interval: 250,
      timeoutMsg: "API Key 登录后没有保存结构可用的 BigModel provider/model",
    },
  );
  if (!latest) {
    throw new Error("API Key 登录后没有读取到 BigModel provider");
  }
  return latest;
}

async function waitForHydratedDraftModel(modelName: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (testId, expectedModelName) => {
          const trigger = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
          const text = trigger?.textContent?.replace(/\s+/g, " ").trim() ?? "";
          return Boolean(trigger && expectedModelName && text.includes(expectedModelName));
        },
        TID_CHAT_MODEL_SELECT_TRIGGER,
        modelName,
      ),
    {
      timeout: 30000,
      interval: 250,
      timeoutMsg: `等待中的 workspace 启动后没有把草稿模型水合为 ${modelName}`,
    },
  );
}

async function waitForModelConfigMissingBanner() {
  await waitForTestIdByDom(TID_CHAT_ERROR_BANNER, {
    timeout: 15000,
    timeoutMsg: "未配置模型的草稿首页没有展示 modelConfigMissing banner",
  });
  const errorCode = await browser.execute((testId) => {
    return document
      .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      ?.getAttribute("data-error-code");
  }, TID_CHAT_ERROR_BANNER);
  expect(errorCode).toBe("model_config_missing");
}

async function waitForModelConfigMissingBannerCleared() {
  await browser.waitUntil(
    () =>
      browser.execute(
        (testId) => !document.querySelector(`[data-testid="${testId}"]`),
        TID_CHAT_ERROR_BANNER,
      ),
    {
      timeout: 15000,
      interval: 250,
      timeoutMsg: "草稿模型水合后 modelConfigMissing banner 没有清除",
    },
  );
}
