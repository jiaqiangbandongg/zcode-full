import { dirname } from "node:path";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  setInputValueByTestIdDom,
} from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  UPSTREAM_THOUGHT_LEVEL,
  ensureUpstreamModelForE2E,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
  waitForUpstreamModelSelected,
} from "../../../helpers/upstream-provider.js";
import {
  E2E_REPLY_TOKEN,
  clickChatStop,
  clickQueueEdit,
  getMessages,
  getQueueItems,
  prepareConversationE2E,
  selectTaskById,
  sendPrompt,
  startNewTask,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequest,
  waitForQueueContaining,
  waitForQueueCount,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";
import { getPassiveAgentStartupWorkspacePaths } from "../../../helpers/passive-agent-startup-fixture.js";
import {
  openWorkspaceDraftFromSidebar,
  waitForActiveWorkspacePath,
  waitForRestoredWorkspaceItems,
} from "../../../helpers/workspace-agent-warmup.js";
import { restartIntoWorkspacePreservingProfile } from "../../../helpers/model-provider-restart.js";

/**
 * 目录里没有被既有正式用例完整覆盖的组合。
 *
 * 每个测试都走真实的选择器、composer、Queue 和重启路径；provider fixture 只负责把
 * 在途窗口和确定性回复固定下来。双主窗口场景仍保持 pending，因为产品没有用户入口，
 * 不能用 Electron 内部造窗冒充真实 E2E。
 */
describe("Model Provider 回归目录缺口 E2E", () => {
  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it.skip("F-APP-003: 两个主窗口同时操作同一 workspace 的冲突规则", async function () {
    this.timeout(30000);
    // 当前产品没有“新建主窗口”的用户入口；入口确定后必须补真实双窗口操作。
  });

  it("F-APP-002/F-APP-005/F-HISTORY-001: 切换 workspace 后模型选择与历史不串", async function () {
    this.timeout(240000);
    await prepareConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);

    const workspacePaths = getPassiveAgentStartupWorkspacePaths(dirname(DEFAULT_WORKSPACE), 2);
    await waitForRestoredWorkspaceItems(workspacePaths, 60000);
    const workspaceA = DEFAULT_WORKSPACE;
    const workspaceB = workspacePaths[0];
    if (!workspaceB) throw new Error("workspace fixture 不完整");

    await openWorkspaceDraftFromSidebar(workspaceA);
    await waitForActiveWorkspacePath(workspaceA);
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
    const markerA = `E2E_CATALOG_WORKSPACE_A_${Date.now()}`;
    const promptA = `${markerA}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(promptA);
    await waitForUserMessageContaining(markerA);
    const taskA = await waitForChatState(
      (snapshot) => Boolean(snapshot.taskId),
      "workspace A 首发后没有绑定持久化 task",
    );
    if (!taskA.taskId) throw new Error("workspace A 首发后 taskId 为空");
    assertUpstreamRequestCapture(await waitForUpstreamNetworkCapture(markerA), {
      expectedText: promptA,
      model: UPSTREAM_MODEL,
    });

    await openWorkspaceDraftFromSidebar(workspaceB);
    await waitForActiveWorkspacePath(workspaceB);
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    const markerB = `E2E_CATALOG_WORKSPACE_B_${Date.now()}`;
    const promptB = `${markerB}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(promptB);
    await waitForUserMessageContaining(markerB);
    assertUpstreamRequestCapture(await waitForUpstreamNetworkCapture(markerB), {
      expectedText: promptB,
      model: UPSTREAM_SECONDARY_MODEL,
    });

    await openWorkspaceDraftFromSidebar(workspaceA);
    await waitForActiveWorkspacePath(workspaceA);
    await selectTaskById(taskA.taskId, {
      timeout: 30000,
      timeoutMsg: `返回 workspace A 后没有找到 task ${taskA.taskId}`,
    });
    await waitForUserMessageContaining(markerA);
    const messagesA = await getMessages("user");
    expect(messagesA.map((message) => message.text).join("\n")).toContain(markerA);
    expect(messagesA.map((message) => message.text).join("\n")).not.toContain(markerB);
  });

  it("F-DRAFT-002/F-DRAFT-004: 预热和页面往返期间草稿选择以最后一次选择为准", async function () {
    this.timeout(220000);
    await prepareConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await startNewTask();

    await Promise.allSettled([
      selectUpstreamModelById(UPSTREAM_MODEL),
      selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL),
    ]);
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await waitForUpstreamModelSelected(UPSTREAM_SECONDARY_MODEL);

    const settingsButton = await $(`[data-testid="task-settings-button"]`);
    if (await settingsButton.isExisting()) {
      await settingsButton.click();
      await browser.waitUntil(async () => await $(`[data-testid="settings-page"]`).isDisplayed(), {
        timeout: 15000,
        timeoutMsg: "模型草稿 case 设置页没有打开",
      });
      const back = await $(`[data-testid="settings-back-button"]`);
      if (await back.isExisting()) await back.click();
    }
    await waitForUpstreamModelSelected(UPSTREAM_SECONDARY_MODEL);

    const marker = `E2E_CATALOG_DRAFT_PREWARM_${Date.now()}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(prompt);
    await waitForComposerText("", "草稿预热首发后输入框没有清空");
    assertUpstreamRequestCapture(await waitForUpstreamNetworkCapture(marker), {
      expectedText: prompt,
      model: UPSTREAM_SECONDARY_MODEL,
    });
  });

  it("F-SESSION-004/F-SESSION-006: 快速切换和重复选择收敛到最后一次模型", async function () {
    this.timeout(220000);
    // 连续 case 可能把上一个测试的 active session 留在当前 workspace；先进入
    // 空草稿，再初始化 provider，确保本次模型切换作用于同一个新 session。
    await prepareConversationE2E({ resetDraftBeforeProvider: true });
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);

    // 三次连续的真实下拉选择模拟用户快速点 A → B → A；每次都等待 UI
    // 把已提交的选择投影回来，避免并发 WebDriver 点击本身制造非用户行为的
    // 菜单竞争。
    await selectUpstreamModelById(UPSTREAM_MODEL, { includePlainModelFallback: false });
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL, { includePlainModelFallback: false });
    await selectUpstreamModelById(UPSTREAM_MODEL, { includePlainModelFallback: false });
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    // 思考深度与模型选择分别由 F-SESSION-003 和其他正式用例覆盖；本 case
    // 只验证快速模型选择的最终身份，避免把两个独立异步状态合并后掩盖竞态。

    const marker = `E2E_CATALOG_SELECTION_CONVERGENCE_${Date.now()}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(prompt);
    const capture = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(capture, {
      expectedText: prompt,
      model: UPSTREAM_SECONDARY_MODEL,
    });
  });

  it("F-APP-004/F-SESSION-002/F-USAGE-001: 生成中退出不会重发，恢复后保留明确会话", async function () {
    this.timeout(260000);
    await prepareConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await startNewTask();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    const marker = `E2E_CATALOG_EXIT_DURING_STREAM_${Date.now()}`;
    const prompt = `E2E_SLOW_STREAM ${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(prompt);
    await waitForUpstreamRequest({ includes: [marker] }, "退出前没有进入 provider 请求");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "退出前没有进入 streaming",
    );
    await waitForUserMessageContaining(marker);
    const beforeMessages = await getMessages("user");
    const beforeRestart = await waitForChatState(
      (snapshot) => Boolean(snapshot.taskId),
      "退出前没有绑定可恢复的会话",
    );
    if (!beforeRestart.taskId) throw new Error("退出前 taskId 为空");
    await restartIntoWorkspacePreservingProfile();
    // 重启 helper 已等待原 workspace 恢复；不要再调用 prepareConversationE2E，
    // 因为它会主动新建 draft，反而把待恢复的用户会话切走。
    await selectTaskById(beforeRestart.taskId, {
      timeout: 60000,
      timeoutMsg: `重启后没有找到待恢复会话 ${beforeRestart.taskId}`,
    });
    await waitForChatState(
      (snapshot) =>
        snapshot.taskId === beforeRestart.taskId &&
        snapshot.state !== "submitting" &&
        snapshot.state !== "streaming",
      "重启后会话没有恢复到稳定状态",
      60000,
    );
    await waitForUserMessageContaining(marker);
    const afterRestart = await getMessages("user");
    expect(afterRestart.filter((message) => message.text.includes(marker))).toHaveLength(1);
    expect(afterRestart.length).toBeGreaterThanOrEqual(beforeMessages.length);
  });

  it("F-QUEUE-006: 多条 Queue 维持顺序，编辑动作只删除目标项并保留另一条", async function () {
    this.timeout(260000);
    await prepareConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await startNewTask();
    await selectUpstreamModelById(UPSTREAM_MODEL);

    const runId = Date.now();
    const running = `E2E_QUEUE_CATALOG_RUNNING_${runId}`;
    await sendPrompt(
      `E2E_SLOW_STREAM ${running}: keep streaming before replying ${E2E_REPLY_TOKEN}`,
    );
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "Queue running turn 没有开始",
    );
    await waitForUpstreamRequest({ includes: [running] }, "Queue running turn 没有进入 provider");

    const first = `E2E_QUEUE_CATALOG_FIRST_${runId}`;
    const second = `E2E_QUEUE_CATALOG_SECOND_${runId}`;
    const firstPrompt = `${first}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const secondPrompt = `${second}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(firstPrompt);
    await sendPrompt(secondPrompt);
    await waitForQueueContaining(first);
    await waitForQueueContaining(second);
    expect(await waitForQueueCount(2)).toHaveLength(2);

    await clickChatStop();
    await waitForChatState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 2,
      "Queue running turn stop 后没有保留两条待消费消息",
    );
    const queueBeforeEdit = await getQueueItems();
    const firstItem = queueBeforeEdit.find((item) => item.content.includes(first));
    if (!firstItem) throw new Error("Queue 中没有找到待编辑的第一条消息");
    await clickQueueEdit(firstItem.id);
    const edited = `${first}_EDITED`;
    // V4 的编辑动作会把 queue 内容恢复到 composer，而不是在 queue row 内嵌输入框；
    // 这里先断言目标项已从 Queue 移除，再把新文本写回真实 composer。重新发送的
    // queueItemId 与请求断言由正式的 v4 queue spec 覆盖，避免把“停止后立即发送”
    // 与“运行中重新入队”两种产品状态混在一个不稳定 case 里。
    await waitForComposerText(firstPrompt, "Queue 编辑后 composer 没有恢复原消息");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, edited);
    await waitForComposerText(edited, "Queue 编辑后的 composer 没有写入新文本");
    const queueAfterEdit = await getQueueItems();
    expect(queueAfterEdit.some((item) => item.content.includes(first))).toBe(false);
    expect(queueAfterEdit.some((item) => item.content.includes(second))).toBe(true);
  });
});

async function stopIfBusy() {
  const snapshot = await waitForChatState(() => true, "读取 chat 状态失败", 5000).catch(() => null);
  if (snapshot?.state === "streaming" || snapshot?.state === "submitting") {
    await clickChatStop().catch(() => undefined);
    await waitForChatState(
      (candidate) => candidate.state !== "streaming" && candidate.state !== "submitting",
      "清理 running session 失败",
      30000,
    ).catch(() => undefined);
  }
}
