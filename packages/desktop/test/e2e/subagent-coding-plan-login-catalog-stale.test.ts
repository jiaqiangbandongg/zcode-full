import {
  BUILTIN_MODEL_PROVIDER_IDS,
  BUILTIN_PROVIDER_TEMPLATE_IDS,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_LOGIN_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_OAUTH_LOGIN_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_ROW,
  TID_TASK_SETTINGS_BUTTON,
  decodeCustomModelValue,
  encodeCustomModelValue,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForTestIdByDom,
} from "./helpers/desktop-app.js";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "./helpers/upstream-provider.js";
import { sel } from "./helpers/selectors.js";

const CASE_TIMEOUT_MS = 240_000;
const CUSTOM_MODEL = encodeCustomModelValue(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
const CODING_PLAN_MODEL = encodeCustomModelValue(
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  "GLM-5.2",
);
const GENERAL_PURPOSE_SCOPE = sel(testId(TID_SUBAGENT_ROW, "general-purpose"));

interface WorkspaceCatalogSnapshot {
  models: Array<{
    defaultThoughtLevel: string | null;
    providerId: string | null;
    thoughtLevels: string[] | null;
    value: string;
  }>;
  status: string | null;
}

describe("BigModel 登录后 Subagent runtime catalog 滞后", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("AUTH-04 / BSM-19: 登录后 Coding Plan reasoning effort 应立即可用", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    const openExternalMock = await browser.electron.mock("shell", "openExternal");
    await openExternalMock.mockResolvedValue(undefined);

    const loginSurface = await waitForInitialLoginSurface();
    if (loginSurface === "workspace") {
      const seededRuntime = await waitForWorkspaceCatalogSeeded();
      expect(
        findWorkspaceModel(seededRuntime, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL),
      ).not.toBeNull();
      expect(
        findWorkspaceModel(
          seededRuntime,
          BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          "GLM-5.2",
        ),
      ).toBeNull();
      await markSeededWorkspaceCatalogReady();
      const runtimeBeforeLogin = await waitForWorkspaceCatalogReady();
      expect(
        findWorkspaceModel(runtimeBeforeLogin, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL),
      ).not.toBeNull();
      expect(
        findWorkspaceModel(
          runtimeBeforeLogin,
          BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          "GLM-5.2",
        ),
      ).toBeNull();
      await startBigModelLoginFromSettings();
    } else {
      await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    }

    const authorizationUrl = await waitForBigModelAuthorizationUrl(openExternalMock);
    const state = new URL(authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    await deliverOAuthCallback(`zcode://oauth/callback?state=${state}&authCode=e2e-auth-code`);

    await waitForTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 60_000,
      timeoutMsg: "BigModel OAuth callback 后没有进入已登录工作区",
    });

    const runtimeAfterOAuth = await waitForWorkspaceCatalogSeeded();
    expect(
      findWorkspaceModel(runtimeAfterOAuth, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL),
    ).not.toBeNull();
    await markSeededWorkspaceCatalogReady();
    await openSubagentSettings();
    const runtimeBeforeSelection = await waitForWorkspaceCatalogReady();
    expect(
      findWorkspaceModel(runtimeBeforeSelection, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL),
    ).toEqual(expect.objectContaining({ thoughtLevels: expect.arrayContaining(["high", "max"]) }));
    await selectModelInScope(GENERAL_PURPOSE_SCOPE, CUSTOM_MODEL);
    await waitForReasoningControl("supported");

    try {
      await selectModelInScope(GENERAL_PURPOSE_SCOPE, CODING_PLAN_MODEL);
    } catch (error) {
      const requests = await readCodingPlanMockRequests().catch(() => []);
      throw new Error(
        `登录后 Subagent 模型菜单没有 Coding Plan; requests=${JSON.stringify(requests)}`,
        { cause: error },
      );
    }

    try {
      await waitForReasoningControl("supported");
    } catch (error) {
      const runtime = await readWorkspaceCatalogSnapshot();
      throw new Error(
        `登录后 Coding Plan reasoning effort 应立即可用；workspaceCatalog=${JSON.stringify(runtime)}`,
        { cause: error },
      );
    }

    const runtimeAfterSelection = await readWorkspaceCatalogSnapshot();
    expect(runtimeAfterSelection.status).toBe("ready");
    expect(
      findWorkspaceModel(
        runtimeAfterSelection,
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        "GLM-5.2",
      ),
    ).toEqual(expect.objectContaining({ thoughtLevels: expect.arrayContaining(["high", "max"]) }));
  });
});

async function readCodingPlanMockRequests(): Promise<unknown[]> {
  const baseUrl = process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim();
  if (!baseUrl) {
    return [];
  }
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/requests`);
  const payload = (await response.json()) as { requests?: unknown[] };
  return payload.requests ?? [];
}

async function waitForInitialLoginSurface(): Promise<"welcome" | "workspace"> {
  let latest: {
    body: string;
    hasLoginTrigger: boolean;
    hasOAuthButton: boolean;
    testIds: string[];
  } | null = null;
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (oauthLoginButtonId, loginTriggerId) => {
          const hasOAuthButton = Boolean(
            document.querySelector(`[data-testid="${oauthLoginButtonId}"]`),
          );
          const hasLoginTrigger = Boolean(
            document.querySelector(`[data-testid="${loginTriggerId}"]`),
          );
          const testIds = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
            .map((element) => element.dataset.testid ?? "")
            .filter(Boolean)
            .slice(0, 60);
          return {
            body: document.body.textContent?.replace(/\s+/g, " ").trim().slice(0, 800) ?? "",
            hasLoginTrigger,
            hasOAuthButton,
            testIds,
          };
        },
        TID_OAUTH_LOGIN_BUTTON,
        TID_LOGIN_TRIGGER,
      );
      return latest.hasOAuthButton || latest.hasLoginTrigger;
    },
    {
      timeout: 60_000,
      timeoutMsg: `冷启动没有进入登录页或工作区: ${JSON.stringify(latest)}`,
    },
  );

  const hasOAuthButton = await browser.execute((oauthLoginButtonId) => {
    return Boolean(document.querySelector(`[data-testid="${oauthLoginButtonId}"]`));
  }, TID_OAUTH_LOGIN_BUTTON);
  return hasOAuthButton ? "welcome" : "workspace";
}

async function startBigModelLoginFromSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 20_000,
    timeoutMsg: "未登录工作区没有展示设置入口",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, {
    timeout: 20_000,
    timeoutMsg: "没有打开设置页",
  });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 20_000,
    timeoutMsg: "设置页没有模型供应商分区入口",
  });
  await clickTestIdByDom(
    testId(TID_MODEL_PROVIDER_NAV_ITEM, `preset:${BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel}`),
    {
      timeout: 20_000,
      timeoutMsg: "模型供应商设置没有 BigModel Coding Plan 入口",
    },
  );

  let latestButtons: string[] = [];
  await browser.waitUntil(
    async () => {
      const result = await browser.execute(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
        const labels = buttons
          .map((button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .filter(Boolean);
        const connectButton = buttons.find((button) => {
          const label = button.textContent?.replace(/\s+/g, " ").trim() ?? "";
          return /BigModel/iu.test(label) && /Connect|连接/iu.test(label) && !button.disabled;
        });
        connectButton?.click();
        return { clicked: Boolean(connectButton), labels };
      });
      latestButtons = result.labels;
      return result.clicked;
    },
    {
      timeout: 30_000,
      timeoutMsg: `BigModel Coding Plan 未登录卡片没有连接按钮: ${latestButtons.join(" / ")}`,
    },
  );
}

async function waitForBigModelAuthorizationUrl(
  openExternalMock: Awaited<ReturnType<typeof browser.electron.mock>>,
): Promise<string> {
  let authorizationUrl = "";
  await browser.waitUntil(
    async () => {
      await openExternalMock.update();
      authorizationUrl =
        openExternalMock.mock.calls
          .map((call) => call[0])
          .find(
            (value): value is string =>
              typeof value === "string" && value.includes("/login?") && value.includes("state="),
          ) ?? "";
      return Boolean(authorizationUrl);
    },
    {
      timeout: 15_000,
      timeoutMsg: "点击 BigModel 登录后没有捕获 openExternal OAuth URL",
    },
  );
  return authorizationUrl;
}

async function deliverOAuthCallback(callbackUrl: string): Promise<void> {
  const delivered = await browser.electron.execute((electron, url) => {
    electron.app.emit(
      "open-url",
      {
        preventDefault() {},
      } as never,
      url,
    );
    return true;
  }, callbackUrl);
  expect(delivered).toBe(true);
}

async function openSubagentSettings(): Promise<void> {
  const settingsPageOpen = await browser.execute((settingsPageId) => {
    return Boolean(document.querySelector(`[data-testid="${settingsPageId}"]`));
  }, TID_SETTINGS_PAGE);
  if (!settingsPageOpen) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "登录后没有找到设置入口",
    });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, {
      timeout: 15_000,
      timeoutMsg: "登录后设置页没有渲染",
    });
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "subagents"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有 Subagents 分区入口",
  });
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "general-purpose"), {
    timeout: 15_000,
    timeoutMsg: "Subagents 页面没有 general-purpose 行",
  });
}

async function waitForWorkspaceCatalogReady(): Promise<WorkspaceCatalogSnapshot> {
  let latest: WorkspaceCatalogSnapshot = { models: [], status: null };
  await browser.waitUntil(
    async () => {
      latest = await readWorkspaceCatalogSnapshot();
      return (
        latest.status === "ready" &&
        findWorkspaceModel(latest, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL) !== null
      );
    },
    {
      timeout: 60_000,
      timeoutMsg: `workspace runtime catalog 未就绪或缺少自定义模型: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function waitForWorkspaceCatalogSeeded(): Promise<WorkspaceCatalogSnapshot> {
  let latest: WorkspaceCatalogSnapshot = { models: [], status: null };
  await browser.waitUntil(
    async () => {
      latest = await readWorkspaceCatalogSnapshot();
      return findWorkspaceModel(latest, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL) !== null;
    },
    {
      timeout: 60_000,
      timeoutMsg: `登录前 workspace catalog 快照缺少自定义模型: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function markSeededWorkspaceCatalogReady(): Promise<void> {
  const updated = await browser.execute((workspacePath) => {
    const state = (
      window as typeof window & {
        __zcodeSessionStoreE2E?: {
          getState?: () => {
            setConfigOptionsStatus?: (path: string, status: "ready") => void;
          };
        };
      }
    ).__zcodeSessionStoreE2E?.getState?.();
    if (!state?.setConfigOptionsStatus) return false;
    // E2E 启动夹具已预置真实 Agent catalog 内容，但不会同步 ready 标记；
    // 本 case 只补齐“登录前 catalog 已稳定”的前置状态，不改模型目录本身。
    state.setConfigOptionsStatus(workspacePath, "ready");
    return true;
  }, DEFAULT_WORKSPACE);
  expect(updated).toBe(true);
}

async function readWorkspaceCatalogSnapshot(): Promise<WorkspaceCatalogSnapshot> {
  return browser.execute((workspacePath) => {
    type BrowserModelOption = {
      modelDefaultThoughtLevel?: string;
      modelProviderId?: string;
      modelThoughtLevels?: string[];
      value?: string;
    };
    type BrowserConfigOption = {
      category?: string;
      id?: string;
      options?: BrowserModelOption[];
      type?: string;
    };
    const store = (
      window as typeof window & {
        __zcodeSessionStoreE2E?: {
          getState?: () => {
            getWorkspaceState?: (path: string) => {
              configOptions?: BrowserConfigOption[] | null;
              configOptionsStatus?: string;
            };
          };
        };
      }
    ).__zcodeSessionStoreE2E;
    const workspace = store?.getState?.().getWorkspaceState?.(workspacePath);
    const modelOption = workspace?.configOptions?.find(
      (option) =>
        option.type === "select" && (option.category === "model" || option.id === "model"),
    );
    return {
      models: (modelOption?.options ?? []).map((option) => ({
        defaultThoughtLevel: option.modelDefaultThoughtLevel ?? null,
        providerId: option.modelProviderId ?? null,
        thoughtLevels: option.modelThoughtLevels ?? null,
        value: option.value ?? "",
      })),
      status: workspace?.configOptionsStatus ?? null,
    };
  }, DEFAULT_WORKSPACE);
}

function findWorkspaceModel(
  snapshot: WorkspaceCatalogSnapshot,
  providerId: string,
  modelId: string,
): WorkspaceCatalogSnapshot["models"][number] | null {
  return (
    snapshot.models.find(
      (model) =>
        model.providerId === providerId &&
        (model.value === `${providerId}/${modelId}` || model.value.endsWith(`/${modelId}`)),
    ) ?? null
  );
}

async function selectModelInScope(scope: string, model: string): Promise<void> {
  const decodedModel = decodeCustomModelValue(model);
  if (!decodedModel) {
    throw new Error(`无法解析 Subagent E2E 模型值: ${model}`);
  }
  const itemTestId = testId(TID_CHAT_MODEL_SELECT_ITEM, model);
  const groupTestId = testId(
    TID_CHAT_MODEL_SELECT_GROUP,
    `registry-provider:${decodedModel.providerId}`,
  );
  const trigger = $(scope).$(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 15_000 });
  await trigger.click();

  await browser.waitUntil(
    () =>
      browser.execute(
        (currentItemTestId, currentGroupTestId) =>
          Boolean(
            document.querySelector(`[data-testid="${currentItemTestId}"]`) ||
            document.querySelector(`[data-testid="${currentGroupTestId}"]`),
          ),
        itemTestId,
        groupTestId,
      ),
    { timeout: 15_000, timeoutMsg: `模型菜单没有出现 ${model}` },
  );

  const itemVisible = await browser.execute(
    (currentItemTestId) => Boolean(document.querySelector(`[data-testid="${currentItemTestId}"]`)),
    itemTestId,
  );
  if (!itemVisible) {
    await browser.execute((currentGroupTestId) => {
      const group = document.querySelector<HTMLElement>(`[data-testid="${currentGroupTestId}"]`);
      if (!group) return;
      group.focus();
      for (const eventName of ["pointerenter", "mouseenter", "mousemove"] as const) {
        group.dispatchEvent(
          new MouseEvent(eventName, {
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
      }
      group.click();
    }, groupTestId);
  }
  await browser.waitUntil(
    () =>
      browser.execute(
        (currentItemTestId) =>
          Boolean(document.querySelector(`[data-testid="${currentItemTestId}"]`)),
        itemTestId,
      ),
    { timeout: 15_000, timeoutMsg: `模型菜单没有展开到目标项 ${model}` },
  );
  await browser.execute((currentItemTestId) => {
    document.querySelector<HTMLElement>(`[data-testid="${currentItemTestId}"]`)?.click();
  }, itemTestId);
  await browser.waitUntil(
    async () => (await trigger.getAttribute("data-model-current-value")) === model,
    { timeout: 15_000, timeoutMsg: `Subagent 模型没有切换到 ${model}` },
  );
}

async function waitForReasoningControl(expected: "supported" | "unavailable"): Promise<string> {
  let latest = { label: "", loading: false, supported: false, unavailable: false };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (scope, thoughtTriggerTestId) => {
          const row = document.querySelector<HTMLElement>(scope);
          const unavailable = row?.querySelector<HTMLElement>(
            '[data-subagent-thought-level-unavailable="true"]',
          );
          return {
            label: unavailable?.getAttribute("aria-label") ?? unavailable?.innerText.trim() ?? "",
            loading: Boolean(row?.querySelector('[data-subagent-thought-level-loading="true"]')),
            supported: Boolean(row?.querySelector(`[data-testid="${thoughtTriggerTestId}"]`)),
            unavailable: Boolean(unavailable),
          };
        },
        GENERAL_PURPOSE_SCOPE,
        TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
      );
      return expected === "supported"
        ? latest.supported && !latest.loading && !latest.unavailable
        : latest.unavailable && !latest.loading && !latest.supported;
    },
    {
      timeout: 15_000,
      timeoutMsg: `reasoning 控件没有进入 ${expected}: ${JSON.stringify(latest)}`,
    },
  );
  return latest.label;
}
