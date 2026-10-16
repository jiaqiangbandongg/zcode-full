import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  type ModelSelection,
  encodeCustomModelValue,
  BUILTIN_MODEL_PROVIDER_IDS,
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_AUTOMATIONS_OPEN,
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_CARD_MENU,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  waitForWorkspaceApp,
  clickTestIdByWebDriver,
  hoverTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import {
  E2E_PLAN_NON_DEFAULT_MODEL,
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
  readBigModelConnectionSelection,
  waitForDraftThoughtLevelState,
  waitForSelectedModel,
  waitForPlanModelIoRequest,
} from "../../../helpers/model-provider-restart.js";
import {
  getV4ComposerText,
  prepareV4ConversationE2E,
  setV4ComposerText,
  switchV4Model,
  sendV4PromptAndWaitAccepted,
  waitForV4TimelineContaining,
  E2E_REPLY_TOKEN,
} from "../../../helpers/v4-conversation.js";
import { sel } from "../../../helpers/selectors.js";
import { startNewTask } from "../../../helpers/conversation-session.js";

const individual = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
const team = BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;

describe("SR87 当前有效选择与原意图", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R95C-01: 旧关闭档位只读对应，发送后保存 disabled，实际请求关闭思考", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
        await seedBigModelOAuthCredential();
      },
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await selectConnection(`coding-plan:${individual}`);
    await switchV4Model(individual, "GLM-5.2", "disabled");
    await setV4ComposerText("E2E_R95C_LEGACY_DRAFT");
    await browser.waitUntil(
      async () =>
        await browser.execute((workspace) => {
          const value = JSON.parse(
            localStorage.getItem(`zcode-v4-composer-drafts:v1:${encodeURIComponent(workspace)}`) ??
              "{}",
          );
          return value.scopes?.__draft__?.text === "E2E_R95C_LEGACY_DRAFT";
        }, DEFAULT_WORKSPACE),
      { timeout: 10000 },
    );
    // 旧页面 beforeunload 会刷新内存草稿；在其后 pagehide 才注入旧存储，避免 fixture 被退出保存覆盖。
    const previousDocument = await browser.execute(() => performance.timeOrigin);
    await browser.execute(
      (workspace, providerId) => {
        const key = `zcode-v4-composer-drafts:v1:${encodeURIComponent(workspace)}`;
        window.addEventListener(
          "pagehide",
          () => {
            const value = JSON.parse(localStorage.getItem(key)!);
            value.scopes.__draft__.modelSelection = {
              providerId,
              modelId: "GLM-5.2",
              options: { reasoningLevel: "nothink" },
            };
            localStorage.setItem(key, JSON.stringify(value));
          },
          { once: true },
        );
        window.location.reload();
      },
      DEFAULT_WORKSPACE,
      individual,
    );
    await browser.waitUntil(
      async () => (await browser.execute(() => performance.timeOrigin)) !== previousDocument,
      { timeout: 15000, timeoutMsg: "旧选择 fixture 后 Renderer 未重新加载" },
    );
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await waitForSelectedModel(individual, "GLM-5.2");
    await waitForDraftThoughtLevelState({
      current: "disabled",
      values: ["disabled", "high", "max"],
    });
    const beforeEditing = await browser.execute(
      (workspace) =>
        JSON.parse(
          localStorage.getItem(`zcode-v4-composer-drafts:v1:${encodeURIComponent(workspace)}`) ??
            "{}",
        ).scopes?.__draft__?.modelSelection,
      DEFAULT_WORKSPACE,
    );
    expect(beforeEditing?.options?.reasoningLevel).toBe("nothink");
    await setV4ComposerText("E2E_R95C_EDIT_TEXT_ONLY");
    await browser
      .waitUntil(
        async () =>
          await browser.execute((workspace) => {
            const draft = JSON.parse(
              localStorage.getItem(
                `zcode-v4-composer-drafts:v1:${encodeURIComponent(workspace)}`,
              ) ?? "{}",
            ).scopes?.__draft__;
            return (
              draft?.text === "E2E_R95C_EDIT_TEXT_ONLY" &&
              draft.modelSelection?.options?.reasoningLevel === "nothink"
            );
          }, DEFAULT_WORKSPACE),
        { timeout: 10000, timeoutMsg: "只读解析或正文编辑改写了原档位" },
      )
      .catch(async (error) => {
        const persisted = await browser.execute(
          (workspace) =>
            localStorage.getItem(`zcode-v4-composer-drafts:v1:${encodeURIComponent(workspace)}`),
          DEFAULT_WORKSPACE,
        );
        throw new Error(
          `${String(error)}; beforeEditing=${JSON.stringify(beforeEditing)}; persisted=${persisted}`,
        );
      });
    await sendV4PromptAndWaitAccepted(
      "E2E_R95C_SEND: Reply briefly.",
      "E2E_R95C_SEND",
      "旧关闭档位发送未接纳",
      20000,
    );
    const request = await waitForPlanModelIoRequest("E2E_R95C_SEND");
    expect(request).toMatchObject({ model: "GLM-5.2", thinking: { type: "disabled" } });
    expect(request).not.toHaveProperty("output_config.effort");
    await waitForV4TimelineContaining("coding-plan-e2e-ok");
    await browser.waitUntil(
      async () =>
        await browser.execute((workspace) => {
          const scopes =
            JSON.parse(
              localStorage.getItem(
                `zcode-v4-composer-drafts:v1:${encodeURIComponent(workspace)}`,
              ) ?? "{}",
            ).scopes ?? {};
          return Object.values(scopes).some((value) => {
            const selection = (value as { modelSelection?: ModelSelection }).modelSelection;
            return (
              selection?.modelId === "GLM-5.2" && selection.options?.reasoningLevel === "disabled"
            );
          });
        }, DEFAULT_WORKSPACE),
      { timeout: 15000, timeoutMsg: "发送后未保存有效关闭档位" },
    );
  });

  it("SR87-01: 套餐切换只对应当前模型和档位，正文保存不覆盖原选择", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
        await seedBigModelOAuthCredential();
      },
    });
    const original = {
      providerId: individual,
      modelId: E2E_PLAN_NON_DEFAULT_MODEL,
      options: { reasoningLevel: "high" },
    };
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await selectConnection(`coding-plan:${individual}`);
    // 从真实选择入口建立用户意图，不在已挂载编辑器背后修改 localStorage。
    await switchV4Model(individual, original.modelId, "high");
    try {
      await waitForSelectedModel(individual, original.modelId);
    } catch (error) {
      const state = await browser.execute(() => ({
        text: document.body.innerText.slice(-5000),
        drafts: Object.fromEntries(
          Object.entries(localStorage).filter(([key]) =>
            key.startsWith("zcode-v4-composer-drafts:v1:"),
          ),
        ),
      }));
      throw new Error(`${String(error)}; initialState=${JSON.stringify(state)}`);
    }
    await setV4ComposerText("E2E_SR87_ACCOUNT_INTENT");

    await selectConnection("team:bigmodel:product-team-a:org-team-a:proj-team-a");

    await waitForSelectedModel(team, original.modelId);
    await waitForDraftThoughtLevelState({ current: "high", values: ["low", "high", "max"] });
    expect(await getV4ComposerText()).toBe("E2E_SR87_ACCOUNT_INTENT");
    await setV4ComposerText("E2E_SR87_ACCOUNT_INTENT_EDITED");
    let savedSelections: unknown[] = [];
    await browser.waitUntil(
      async () => {
        const draft = await browser.execute(
          (workspace) =>
            JSON.parse(
              localStorage.getItem(
                `zcode-v4-composer-drafts:v1:${encodeURIComponent(workspace)}`,
              ) ?? "{}",
            ).scopes?.__draft__,
          DEFAULT_WORKSPACE,
        );
        return draft?.text === "E2E_SR87_ACCOUNT_INTENT_EDITED";
      },
      { timeout: 10000, timeoutMsg: "正文没有保存" },
    );
    const saved = await browser.execute(
      (workspace) =>
        JSON.parse(
          localStorage.getItem(`zcode-v4-composer-drafts:v1:${encodeURIComponent(workspace)}`) ??
            "{}",
        ).scopes?.__draft__?.modelSelection,
      DEFAULT_WORKSPACE,
    );
    expect(saved).toEqual(original);
    try {
      await sendV4PromptAndWaitAccepted(
        `E2E_SR87_ACCOUNT_SEND: Reply with exactly "${E2E_REPLY_TOKEN}".`,
        "E2E_SR87_ACCOUNT_SEND",
        "账号对应后的首发未接纳",
        20000,
      );
    } catch (error) {
      const text = await browser.execute(() => document.body.innerText.slice(-5000));
      throw new Error(`${String(error)}; visible=${text}`);
    }
    // Account 请求走套餐 Mock 的 Endpoint，不经过 Personal 上游 回放代理。
    // 读取真实 Agent model-io，验证发出的最终请求而不是盯错代理造成假失败。
    const request = await waitForPlanModelIoRequest("E2E_SR87_ACCOUNT_SEND");
    expect(request).toMatchObject({
      model: original.modelId,
      thinking: { type: "enabled" },
      output_config: { effort: "high" },
    });
    // 等模型实际返回的固定回复，而不是正文中用户自己写入的 reply token。
    await waitForV4TimelineContaining("coding-plan-e2e-ok");
    await browser
      .waitUntil(
        async () => {
          const selections = await browser.execute((workspace) => {
            const scopes =
              JSON.parse(
                localStorage.getItem(
                  `zcode-v4-composer-drafts:v1:${encodeURIComponent(workspace)}`,
                ) ?? "{}",
              ).scopes ?? {};
            return Object.values(scopes).map(
              (value) => (value as { modelSelection?: unknown }).modelSelection,
            );
          }, DEFAULT_WORKSPACE);
          savedSelections = selections;
          return selections.some(
            (selection) =>
              (selection as ModelSelection | undefined)?.providerId === team &&
              (selection as ModelSelection).modelId === original.modelId &&
              (selection as ModelSelection).options?.reasoningLevel === "high",
          );
        },
        { timeout: 15000, timeoutMsg: "接纳后没有在会话草稿保存本次有效选择" },
      )
      .catch((error) => {
        throw new Error(`${String(error)}; selections=${JSON.stringify(savedSelections)}`);
      });
  });

  it("SR87-06 / SM96-02/05: 旧任务离线迁为个人意图，列表运行对应当前 Team", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    // 每条 case 自己准备账号，不依赖 SR87-01 先运行。
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
        await seedBigModelOAuthCredential();
      },
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await selectConnection(`coding-plan:${individual}`);
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN);
    await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY);
    await clickTestIdByWebDriver(TID_COMPOSER_WORKSPACE_TRIGGER);
    await browser.execute(() => {
      const item = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
      ).find((node) => node.innerText.trim() === "ZCodeProject");
      if (!item) throw new Error("缺少目标项目");
      item.click();
    });
    await clickTestIdByWebDriver(TID_CHAT_MODEL_SELECT_TRIGGER);
    await clickTestIdByWebDriver(
      testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${individual}`),
    );
    await clickTestIdByWebDriver(
      testId(
        TID_CHAT_MODEL_SELECT_ITEM,
        encodeCustomModelValue(individual, E2E_PLAN_NON_DEFAULT_MODEL),
      ),
    );
    await clickTestIdByWebDriver(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER);
    await clickTestIdByDom(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, "high"));
    await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD);
    await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"));
    const title = `E2E_SR87_AUTOMATION_${Date.now()}`;
    const prompt = `E2E_SR87_AUTOMATION_SEND: Reply with exactly "${E2E_REPLY_TOKEN}".`;
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, title);
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, prompt);
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT);
    await waitForTestIdByDom(TID_AUTOMATION_CARD);
    const original = readAutomationSelections(title).original;
    expect(original?.providerId).toBe(individual);

    await startNewTask();
    await selectConnection("team:bigmodel:product-team-a:org-team-a:proj-team-a");
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        // 只改本 case 的旧存储前置，不能通过设置页保存提前执行迁移或对应账号。
        const db = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"));
        try {
          const changed = db
            .prepare(
              "UPDATE automations SET model_selection = NULL, model = ?, provider = 'glm', thought_level = 'high' WHERE title = ?",
            )
            .run(`builtin:bigmodel-coding-plan/${E2E_PLAN_NON_DEFAULT_MODEL}`, title);
          expect(Number(changed.changes)).toBe(1);
        } finally {
          db.close();
        }
      },
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    expect((await readBigModelConnectionSelection())?.kind).toBe("team-coding-plan");
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN);
    await waitForTestIdByDom(TID_AUTOMATION_CARD);
    await browser.waitUntil(
      () => readAutomationSelections(title).original?.providerId === individual,
      {
        timeout: 15000,
        timeoutMsg: "旧选择未离线迁为个人身份，或错误依赖了当前 Team",
      },
    );
    expect(readAutomationSelections(title).original).toEqual(original);
    // 不能打开编辑页再保存，否则测试只证明 UI 提前改写，没有经过后台原意图解析。
    await hoverTestIdByWebDriver(TID_AUTOMATION_CARD);
    await clickTestIdByWebDriver(TID_AUTOMATION_CARD_MENU);
    await browser.execute(() => {
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (node) => /^(立即运行|Run now)$/u.test(node.innerText.trim()),
      );
      if (!item) throw new Error("卡片菜单没有立即运行");
      item.click();
    });
    await browser.waitUntil(() => readAutomationSelections(title).run?.providerId === team, {
      timeout: 45000,
      timeoutMsg: "后台未以当前 Team 身份固定 run",
    });
    expect(readAutomationSelections(title)).toEqual({
      original,
      run: { ...original, providerId: team },
    });
    const request = await waitForPlanModelIoRequest("E2E_SR87_AUTOMATION_SEND");
    expect(request).toMatchObject({
      model: E2E_PLAN_NON_DEFAULT_MODEL,
      output_config: { effort: "high" },
    });
    const db = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        db
          .prepare("SELECT model, provider, thought_level FROM automations WHERE title = ?")
          .get(title),
      ).toEqual({
        model: `builtin:bigmodel-coding-plan/${E2E_PLAN_NON_DEFAULT_MODEL}`,
        provider: "glm",
        thought_level: "high",
      });
    } finally {
      db.close();
    }
  });
});

function readAutomationSelections(title: string): {
  original?: ModelSelection;
  run?: ModelSelection;
} {
  const db = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const original = db
      .prepare("SELECT automation_id, model_selection FROM automations WHERE title = ?")
      .get(title) as { automation_id: string; model_selection: string | null } | undefined;
    const run =
      original &&
      (db
        .prepare(
          "SELECT model_selection FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(original.automation_id) as { model_selection: string | null } | undefined);
    return {
      original: original?.model_selection ? JSON.parse(original.model_selection) : undefined,
      run: run?.model_selection ? JSON.parse(run.model_selection) : undefined,
    };
  } finally {
    db.close();
  }
}

async function selectConnection(key: string) {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), { timeout: 15000 });
  await clickTestIdByDom(
    testId(TID_MODEL_PROVIDER_NAV_ITEM, `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`),
    { timeout: 30000 },
  );
  await clickTestIdByDom(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER, { timeout: 15000 });
  const option = await $(sel(testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, key)));
  await option.waitForDisplayed({ timeout: 30000 });
  await option.click();
  // 点击触发异步保存；用例先建立已保存连接，不能把旧设置当成后续选模的前提。
  const expectedKind = key.startsWith("team:") ? "team-coding-plan" : "individual-coding-plan";
  await browser.waitUntil(
    async () => (await readBigModelConnectionSelection())?.kind === expectedKind,
    {
      timeout: 15000,
      timeoutMsg: `连接方式尚未保存：${key}`,
    },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15000 });
}
