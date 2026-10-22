import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_TOOL_SEARCH_OPTION,
  TID_SETTINGS_TOOL_SEARCH_SELECT,
  TID_TASK_SETTINGS_BUTTON,
  TID_TOOL_SUMMARY_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { seedCustomAnthropicMessagesProvider } from "#e2e/helpers/custom-openai-provider";
import { restartIntoWorkspace } from "#e2e/helpers/model-provider-restart";
import {
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  readSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  selectUpstreamProviderModelById,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import {
  clickV4Stop,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE_NAME = "conversation-session-tool-discovery-card";
const MODEL_ID = "e2e-tool-discovery-card-model";
let replay: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;

describe("ToolSearch 不可展开卡片", () => {
  before(async function () {
    this.timeout(240_000);
    replay = await startConversationModelProviderReplayServer(CASE_NAME);
    // 工作区 helper 通过 Escape 退出新 profile 引导，避免旧跳过按钮路径等待隐藏元素。
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    const providerId = "e2e-tool-discovery-card-provider";
    const providerName = "Tool discovery card E2E";
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedCustomAnthropicMessagesProvider({
          baseURL: replay.baseUrl,
          modelId: MODEL_ID,
          providerId,
          providerName,
        });
      },
    });
    await prepareV4ConversationE2E({ skipProvider: true });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
    const select = await browser.$(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`);
    await select.scrollIntoView();
    await select.click();
    await clickTestIdByDom(testId(TID_SETTINGS_TOOL_SEARCH_OPTION, "local"));
    await browser.waitUntil(async () => (await readSettings()).toolSearchMode === "local", {
      timeout: 15_000,
      timeoutMsg: "Local 模式未保存",
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await prepareV4ConversationE2E({ skipProvider: true, skipShellReady: true });
    // 新草稿有独立模型偏好；在最终草稿上选模型，避免后续初始化重新采用默认模型。
    await selectUpstreamProviderModelById(MODEL_ID, {
      includePlainModelFallback: false,
      providerId,
      providerName,
    });
    await waitForUpstreamModelSelected(MODEL_ID, {
      includePlainModelFallback: false,
      providerId,
    });
  });

  after(async () => {
    await replay?.stop();
  });

  it("TS14-SUMMARY：空输入、单选、多选、关键词、无匹配及失败只显示摘要", async function () {
    this.timeout(180_000);
    await sendV4Prompt("E2E_TOOL_DISCOVERY_CARD_SUMMARY 搜索工具并检查卡片，不执行目标工具。");
    // fixture 先提交正文，越过原有可重试前奏缓冲，再观察真实工具占位并释放参数。
    try {
      await expectCard("card_single", /^(搜索工具|Search tools)$/u, "pending");
    } finally {
      await releaseControlledReplay("tool-discovery-card-summary");
    }
    await waitForV4AssistantMessageContaining("E2E_TOOL_DISCOVERY_CARD_DONE");
    await waitForV4Pane((pane) => !pane.canStop, "搜索轮次未结束", 30_000);

    for (const [id, query] of [
      ["card_single", "TodoWrite"],
      ["card_multi", "Read, TodoWrite, WebFetch"],
      ["card_keyword", "checklist"],
      ["card_none", "zztoolcardnomatch987654321"],
      ["card_invalid", "TodoWrite"],
    ] as const) {
      await expectCard(
        id,
        new RegExp(`(?:搜索工具：|Search tools: )${query}`),
        id === "card_invalid" ? "failed" : "completed",
      );
      const result = await getLatestUpstreamToolResultByToolCallId(id);
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(id === "card_invalid");
      if (id === "card_invalid") expect(result!.content).toContain("max_results");
      else if (id === "card_none")
        expect(result!.content).toContain("No matching deferred tools found");
      else expect(result!.content).toContain("<functions>");
    }

    for (const locale of ["zh-CN", "en-US"] as const) {
      for (const theme of ["zai-light", "zai-dark"] as const) {
        await setPresentation(locale, theme);
        const label = locale === "zh-CN" ? "搜索工具：" : "Search tools: ";
        await expectCard(
          "card_multi",
          new RegExp(`${label}Read, TodoWrite, WebFetch`),
          "completed",
        );
        await expectCard("card_invalid", new RegExp(`${label}TodoWrite`), "failed");
      }
    }
  });

  it("TS14-STOP：参数流式生成时停止，卡片不展示部分 JSON 或结果", async function () {
    this.timeout(90_000);
    await sendV4Prompt("E2E_TOOL_DISCOVERY_CARD_STOP 搜索工具，在参数未完成时停止。");
    await expectCard("card_stopped", /搜索工具|Search tools/u, "pending");
    await clickV4Stop();
    await waitForV4Pane((pane) => !pane.canStop, "停止后会话仍在运行", 30_000);
    await expectCard("card_stopped", /搜索工具|Search tools/u, "stopped");
    expect(await getLatestUpstreamToolResultByToolCallId("card_stopped")).toBeNull();
    // 用户停止会关闭 HTTP 连接并取消测试 gate，无需再释放已取消的流。
  });
});

async function expectCard(callId: string, label: RegExp, status: string) {
  const snapshot = await waitForToolCallBlockByToolCallId(callId, 30_000);
  const block = await browser.$(`[data-testid="${snapshot.testId}"]`);
  await browser.waitUntil(async () => (await block.getAttribute("data-status")) === status, {
    timeout: 15_000,
    timeoutMsg: `${callId} 未变为 ${status}`,
  });
  const summary = await block.$(`[data-testid="${testId(TID_TOOL_SUMMARY_TRIGGER, callId)}"]`);
  await expect(summary).toHaveText(label);
  expect(await summary.getAttribute("role")).not.toBe("button");
  expect(await summary.getAttribute("aria-expanded")).toBeNull();
  await summary.scrollIntoView();
  await summary.click();
  expect(await summary.getAttribute("aria-expanded")).toBeNull();
  expect(await block.$("pre").isExisting()).toBe(false);
  expect(await block.getText()).not.toMatch(
    /select:|max_results|<functions>|inputSchema|Tool loaded\./u,
  );
}

async function setPresentation(locale: "zh-CN" | "en-US", theme: "zai-light" | "zai-dark") {
  const changed = await browser.execute(
    (nextLocale, nextTheme) => {
      const actions = (window as typeof window & { __testActions?: Record<string, unknown> })
        .__testActions;
      if (typeof actions?.setLocale !== "function" || typeof actions.setTheme !== "function")
        return false;
      (actions.setLocale as (value: string) => void)(nextLocale);
      (actions.setTheme as (value: string) => void)(nextTheme);
      return true;
    },
    locale,
    theme,
  );
  expect(changed).toBe(true);
  await browser.waitUntil(
    async () =>
      (await browser.$("html").getAttribute("class"))?.split(" ").includes(`theme-${theme}`),
    {
      timeout: 10_000,
      timeoutMsg: "主题未更新",
    },
  );
}
