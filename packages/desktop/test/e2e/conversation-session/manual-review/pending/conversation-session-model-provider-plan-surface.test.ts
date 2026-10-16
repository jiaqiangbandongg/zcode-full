import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_CREATE_MENU,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATIONS_LIST,
  TID_AUTOMATIONS_OPEN,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_AUTOMATION_FREQUENCY_OPTION,
  encodeCustomModelValue,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import {
  E2E_BIGMODEL_PLAN_PROVIDER_ID,
  E2E_BIGMODEL_START_PROVIDER_ID,
  E2E_PLAN_DEFAULT_MODEL,
  E2E_PLAN_NON_DEFAULT_MODEL,
  restartIntoWorkspace,
  restartIntoWorkspacePreservingProfile,
  seedBigModelOAuthCredential,
  seedBigModelConnectionSelection,
  seedBigModelStartPlanCredential,
  seedPersistedModelSelection,
  seedReplayProvider,
  waitForSelectedModel,
} from "../../../helpers/model-provider-restart.js";
import { prepareConversationE2E, startNewTask } from "../../../helpers/conversation-session.js";
import { sel } from "../../../helpers/selectors.js";

const PLAN_PROVIDER_ID = E2E_BIGMODEL_PLAN_PROVIDER_ID;
const PLAN_MODEL = "GLM-5.2";
const START_PROVIDER_ID = E2E_BIGMODEL_START_PROVIDER_ID;
const START_MODEL = "GLM-5.2";
const PLAN_MODEL_VALUE = encodeCustomModelValue(PLAN_PROVIDER_ID, PLAN_MODEL);
const START_MODEL_VALUE = encodeCustomModelValue(START_PROVIDER_ID, START_MODEL);
/**
 * 定时任务的模型选择是 task-local 记录，不能因为聊天默认计划改变而被重写。
 * 这里用服务端下发的 BigModel Coding/Start Plan provider，并从只读任务索引对账
 * 完整 providerId/modelId；运行时请求由已有 Cron E2E 覆盖。
 */
describe("Automation 在 Start/Coding Plan 间保存模型身份 E2E", () => {
  afterEach(async () => {
    await setCatalogMode("full").catch(() => undefined);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("F-AUTOMATION-004/F-AUTOMATION-005/F-AUTOMATION-006/F-PLAN-004/F-PLAN-008: 两种计划分别保存，任务记录不跟随默认值漂移", async function () {
    this.timeout(180000);

    await prepareConversationE2E({ skipProvider: true });
    await seedBigModelOAuthCredential();
    await seedBigModelStartPlanCredential();
    await seedBigModelConnectionSelection({
      kind: "team-coding-plan",
      productId: "product-team-a",
      organizationId: "org-team-a",
      projectId: "proj-team-a",
    });
    await seedReplayProvider({
      id: PLAN_PROVIDER_ID,
      models: [PLAN_MODEL],
      name: "BigModel Coding Plan E2E",
    });
    await seedReplayProvider({
      id: START_PROVIDER_ID,
      models: [START_MODEL],
      name: "BigModel Start Plan E2E",
    });
    await restartIntoWorkspace();
    // 先走正式 上游 provider 初始化，确保 Automation 表单的本地 Host
    // 已有可执行模型；随后再从真实下拉菜单切到两个 case-local 计划 provider。
    await prepareConversationE2E();

    const codingTitle = `E2E_AUTOMATION_CODING_PLAN_${Date.now()}`;
    await createAutomation(codingTitle, "固定 Coding Plan 模型", PLAN_MODEL_VALUE);
    const codingRecord = await waitForAutomationModel(codingTitle);
    expect(codingRecord).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: PLAN_MODEL,
    });
    // 编辑与模型无关的 prompt 后重新读取持久化值，覆盖“保存其他字段不会
    // 清掉模型身份”的路径；先编辑第一张卡片，避免同时创建第二张卡片后列表排序
    // 让用户点击落到另一张任务上。
    await editAutomationPrompt(codingTitle, "只修改 prompt，不修改模型");
    expect(await readAutomationModel(codingTitle)).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: PLAN_MODEL,
    });

    // 两个计划 provider 都是真实模型菜单项；这里直接在 Automation 表单中切换，
    // 验证任务保存的是完整 providerId，而不是把同名 GLM-5.2 按当前聊天连接重写。
    // Family 连接选择与 Automation 的显式模型选择是两个正交事实；本 case 只验证
    // Automation 保存完整 Provider/Model 身份，避免把产品状态耦合成不可诊断的失败。
    const startTitle = `E2E_AUTOMATION_START_PLAN_${Date.now()}`;
    await createAutomation(startTitle, "固定 Start Plan 模型", START_MODEL_VALUE);
    const startRecord = await waitForAutomationModel(startTitle);
    expect(startRecord).toEqual({
      providerId: START_PROVIDER_ID,
      modelId: START_MODEL,
    });

    // 创建第二个任务并不会改写第一个任务；这是“同名模型按完整计划身份区分”的关键断言。
    expect(await readAutomationModel(codingTitle)).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: PLAN_MODEL,
    });

    // 同一个用户在聊天草稿中切换连接时，菜单必须保留完整 provider 身份，不能只按
    // 模型名称去重；Automation 的两个已保存值也必须继续保持不变。
    await startNewTask();
    await selectAutomationModel(START_MODEL_VALUE);
    expect(
      await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value"),
    ).toBe(START_MODEL_VALUE);
    await selectAutomationModel(PLAN_MODEL_VALUE);
    expect(
      await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value"),
    ).toBe(PLAN_MODEL_VALUE);
    // 当前连接切回 Coding Plan 后，之前保存的 Start Plan 任务仍保留原身份；
    // 这也是任务等待期间套餐失效时“不静默改绑另一计划”的最小可观察边界。
    expect(await readAutomationModel(startTitle)).toEqual({
      providerId: START_PROVIDER_ID,
      modelId: START_MODEL,
    });
  });

  it("F-PLAN-005: 套餐目录暂时不可用时保留当前选择，恢复后仍可继续使用", async function () {
    this.timeout(220000);
    await prepareBigModelCatalogWorkspace(E2E_PLAN_DEFAULT_MODEL);
    await setCatalogMode("unavailable");
    await restartIntoWorkspacePreservingProfile();
    await prepareConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, PLAN_MODEL);

    // 目录不可用期间只保留当前选择，不把草稿静默改成 上游；目录恢复后
    // 再重启一次，验证同一个选择仍可继续作为下一次发送的初始配置。
    await setCatalogMode("full");
    await restartIntoWorkspacePreservingProfile();
    await prepareConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, PLAN_MODEL);
  });

  it("F-PLAN-006: 服务端只返回部分目录时不覆盖已有模型事实", async function () {
    this.timeout(220000);
    await prepareBigModelCatalogWorkspace(E2E_PLAN_NON_DEFAULT_MODEL);
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
    await setCatalogMode("partial");
    await restartIntoWorkspacePreservingProfile();
    await prepareConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
  });
});

async function prepareBigModelCatalogWorkspace(model: string): Promise<void> {
  await prepareConversationE2E({ skipProvider: true });
  await seedBigModelOAuthCredential();
  await seedBigModelConnectionSelection({
    kind: "team-coding-plan",
    productId: "product-team-a",
    organizationId: "org-team-a",
    projectId: "proj-team-a",
  });
  await seedReplayProvider({
    id: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    models: [PLAN_MODEL, E2E_PLAN_NON_DEFAULT_MODEL],
    name: "BigModel Coding Plan E2E",
  });
  await seedPersistedModelSelection({
    modelId: model,
    providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    reasoningLevel: "max",
  });
  await setCatalogMode("full");
  await restartIntoWorkspace();
  await prepareConversationE2E({ skipProvider: true });
  await selectAutomationModel(encodeCustomModelValue(E2E_BIGMODEL_PLAN_PROVIDER_ID, model));
  // 选择动作本身更新草稿态；为“重启后恢复最近模型”准备已落盘的用户偏好，
  // 等待目录状态切换后由真正的应用启动逻辑读取并断言，而不是在测试里直接改
  // 重启后的运行时状态。
  await seedPersistedModelSelection({
    modelId: model,
    providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    reasoningLevel: "max",
  });
}

async function setCatalogMode(mode: "full" | "partial" | "unavailable"): Promise<void> {
  const baseUrl = process.env.ZCODE_CODING_PLAN_TEAM_MOCK_BASE_URL?.trim();
  if (!baseUrl) throw new Error("Coding Plan mock URL 未配置，无法切换模型目录状态");
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/catalog-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`模型目录状态切换失败：${response.status}`);
}

async function createAutomation(title: string, prompt: string, modelValue: string): Promise<void> {
  await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeout: 15000 });
  await clickTestIdByWebDriver(TID_AUTOMATION_CREATE_MENU, { timeout: 15000 });
  await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY, { timeout: 15000 });
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, title);
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, prompt);
  await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, { timeout: 15000 });
  await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"), {
    timeout: 15000,
  });
  await selectAutomationModel(modelValue);
  await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, { timeout: 15000 });
  await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
    timeout: 30000,
    timeoutMsg: `Automation ${title} 保存后没有回到列表`,
  });
}

async function selectAutomationModel(modelValue: string): Promise<void> {
  const decoded = decodeModelValue(modelValue);
  const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 15000 });
  // 当前模型不会重复出现在菜单项里；Automation 新建表单继承聊天默认模型时，
  // 已命中目标就是有效的用户态结果，不应把“菜单里没有当前项”误判成失败。
  if ((await trigger.getAttribute("data-model-current-value")) === modelValue) {
    return;
  }
  await clickTestIdByWebDriver(TID_CHAT_MODEL_SELECT_TRIGGER, {
    timeout: 15000,
    timeoutMsg: "Automation 表单没有模型选择器",
  });
  const itemTestId = testId(TID_CHAT_MODEL_SELECT_ITEM, modelValue);
  const groupTestId = testId(
    TID_CHAT_MODEL_SELECT_GROUP,
    `registry-provider:${decoded.providerId}`,
  );
  await browser.waitUntil(
    async () =>
      browser.execute(
        (itemId, groupId) =>
          Boolean(
            document.querySelector(`[data-testid="${itemId}"]`) ||
            document.querySelector(`[data-testid="${groupId}"]`),
          ),
        itemTestId,
        groupTestId,
      ),
    { timeout: 30000, timeoutMsg: `Automation 模型菜单没有出现 ${modelValue}` },
  );
  if (!(await $(sel(itemTestId)).isExisting())) {
    await $(sel(groupTestId)).click();
    await $(sel(itemTestId)).waitForDisplayed({ timeout: 15000 });
  }
  await $(sel(itemTestId)).click();
  await browser.waitUntil(
    async () =>
      (await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value")) ===
      modelValue,
    { timeout: 15000, timeoutMsg: `Automation 模型没有切换到 ${modelValue}` },
  );
}

function decodeModelValue(value: string): { providerId: string } {
  const encoded = value.slice("custom:".length);
  const separator = encoded.indexOf(":");
  return { providerId: decodeURIComponent(separator < 0 ? encoded : encoded.slice(0, separator)) };
}

async function editAutomationPrompt(title: string, prompt: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (cardTestId, expectedTitle) => {
          const card = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (element) =>
              element.dataset.testid === cardTestId && element.textContent?.includes(expectedTitle),
          );
          if (!card) return false;
          card.click();
          return true;
        },
        TID_AUTOMATION_CARD,
        title,
      ),
    { timeout: 30000, timeoutMsg: `没有打开 Automation 详情：${title}` },
  );
  await waitForTestIdByDom(TID_AUTOMATION_FORM_PROMPT, {
    timeout: 15000,
    timeoutMsg: "Automation 详情没有 prompt 输入框",
  });
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, prompt);
  await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, { timeout: 15000 });
  await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
    timeout: 30000,
    timeoutMsg: "Automation 编辑后没有回到列表",
  });
}

async function waitForAutomationModel(title: string) {
  await browser.waitUntil(async () => (await readAutomationModel(title)) !== null, {
    timeout: 15000,
    timeoutMsg: `没有在任务索引中找到 ${title} 的模型配置`,
  });
  const model = await readAutomationModel(title);
  if (!model) throw new Error(`任务索引中的模型配置为空：${title}`);
  return model;
}

async function readAutomationModel(title: string) {
  const database = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT model_selection FROM automations WHERE title = ?")
      .get(title) as { model_selection: string | null } | undefined;
    if (!row?.model_selection) return null;
    const selection = JSON.parse(row.model_selection) as {
      modelId?: string;
      providerId?: string;
    };
    return selection.providerId && selection.modelId
      ? { modelId: selection.modelId, providerId: selection.providerId }
      : null;
  } finally {
    database.close();
  }
}
