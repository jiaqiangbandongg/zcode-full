import { TID_V4_SUBAGENT_OPEN_SIDE_PANE } from "@zcode/shared";
import { clearAppData } from "../helpers/desktop-app.js";
import { waitForUpstreamRequest } from "../helpers/conversation-session-network.js";
import {
  expandAssistantHistoriesWithContent,
  waitForToolCallBlockByToolCallId,
} from "../helpers/conversation-session-tool.js";
import { getToolCallDiagnostics } from "../helpers/conversation-session-tool-diagnostics.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";
import {
  beginConversationTelemetryCapture,
  readConversationReportRequests,
  waitForConversationReportInventory,
} from "../helpers/conversation-telemetry-parity-capture.js";

const BG26_TIMEOUT_MS = 240000;
const PARENT_MARKER = "E2E_BACKGROUND_SUBAGENT_RATE_LIMIT_PARENT";
const PARENT_DONE = "E2E_BACKGROUND_SUBAGENT_RATE_LIMIT_PARENT_DONE";
const CHILD_MARKER = "E2E_BACKGROUND_SUBAGENT_RATE_LIMIT_CHILD";
const TOOL_CALL_ID = "toolu_e2e_background_subagent_rate_limit_agent";
const PROVIDER_ERROR =
  "Requests are too frequent. Please reduce your request frequency, wait a short moment, and retry your request. Request id: e2e-background-subagent-rate-limit";

describe("会话区 background subagent 429 错误展示 E2E", () => {
  before(async function () {
    this.timeout(BG26_TIMEOUT_MS);
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BG26: 429 原始错误进入 subagent result、失败 hover 和 restore snapshot", async function () {
    this.timeout(BG26_TIMEOUT_MS);

    const telemetryCapture = await beginConversationTelemetryCapture();
    const prompt = `${PARENT_MARKER}: launch one background Agent and finish after its failed task notification with ${PARENT_DONE}.`;
    // Bug 原因：v4 已删除 chat-input/chat-view，旧 formal case 在 before hook 等待
    // legacy composer，真实场景从未执行。发送、timeline、session 切换统一走 v4 contract。
    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(PARENT_MARKER, 60000);
    await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 60000);

    // Bug 根因：旧断言直接等待 parent notification；失败时无法判断 child 物理请求
    // 是否到达 replay server。先建立 child request 屏障，让 shard 日志明确区分网络
    // 发送停滞与 429 terminal/notification 投影停滞。
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [CHILD_MARKER] },
      "background subagent child 请求没有到达 replay server",
      60000,
    );
    await waitForUpstreamRequest(
      {
        includes: [
          `<tool-use-id>${TOOL_CALL_ID}</tool-use-id>`,
          "<status>failed</status>",
          `<error>${PROVIDER_ERROR}</error>`,
          `failed. ${PROVIDER_ERROR}`,
        ],
      },
      "background subagent failed notification 没有透传 provider 原始错误",
      90000,
    );
    await waitForV4TimelineContaining(PARENT_DONE, 90000);
    await waitForConversationReportInventory(telemetryCapture, {
      message_completion: 2,
    });
    const reports = await readConversationReportRequests(telemetryCapture);
    // 早期 staging 断言没有后台 step；后续首终态结算已要求失败也报告零用量 Agent 汇总。
    // 请求返回 429 没有 usage，不能把失败调用计成已确认的计费用量。
    expect(
      reports.filter(
        (report) =>
          report.element_name === "agent_step" &&
          (report.event_extra_detail as Record<string, unknown> | undefined)?.agent_role ===
            "background subagent",
      ),
    ).toEqual([
      expect.objectContaining({
        event_extra_detail: expect.objectContaining({
          agent_role: "background subagent",
          tool_name: "Agent",
          status: "fail",
          error_msg: expect.stringContaining(PROVIDER_ERROR),
          model_request_count: "0",
          token_usage_scope: "",
          total_tokens: "0",
        }),
      }),
    ]);
    expect(
      reports.filter(
        (report) =>
          report.element_name === "message_completion" &&
          ["child_session_id", "parent_tool_call_id"].some((key) =>
            Object.hasOwn(
              (report.event_extra_detail as Record<string, unknown> | undefined) ?? {},
              key,
            ),
          ),
      ),
    ).toHaveLength(0);
    const idleSnapshot = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "background subagent 429 notification 后父会话没有回到 idle",
      60000,
    );
    if (!idleSnapshot.sessionId || idleSnapshot.sessionId === "draft") {
      throw new Error(`background subagent 429 case 缺少 taskId: ${JSON.stringify(idleSnapshot)}`);
    }

    const sourceTaskId = idleSnapshot.sessionId;
    await assertFailedAgentSurface("live");

    await startNewV4Draft();
    await selectV4TaskById(sourceTaskId);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sourceTaskId && !snapshot.canStop,
      "background subagent 429 case 切回后没有完成原 task snapshot restore",
      30000,
    );
    await waitForV4TimelineContaining(PARENT_DONE, 60000);

    await assertFailedAgentSurface("restored");
  });
});

async function assertFailedAgentSurface(stage: "live" | "restored") {
  // Bug 原因：child 429 与 parent failed notification 已持久化成功，但 v4 Agent
  // 卡片投影仍保留 completed。这里直接约束用户可见状态，避免继续依赖已删除的
  // legacy renderer store 投影而掩盖真实产品回归。
  let latestDiagnostics: Awaited<ReturnType<typeof getToolCallDiagnostics>> | null = null;
  try {
    await browser.waitUntil(
      async () => {
        // Bug 根因：恢复后的 completed turn 默认折叠，失败 Agent 行尚未挂载；旧断言
        // 先查 block 再展开 history，因而把已持久化的 429 状态误报为 restore 丢失。
        await expandAssistantHistoriesWithContent();
        latestDiagnostics = await getToolCallDiagnostics({
          type: "toolCallId",
          value: TOOL_CALL_ID,
        });
        return latestDiagnostics.matchedBlock?.status === "failed";
      },
      {
        timeout: 30000,
        timeoutMsg: `${stage} Agent 卡没有进入 failed`,
      },
    );
  } catch (error) {
    throw new Error(
      `${stage} Agent 卡没有进入 failed; latest=${JSON.stringify(latestDiagnostics)}`,
      { cause: error },
    );
  }

  const blockSnapshot = await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 30000);
  // Bug 根因：Agent 卡产品合同已改成“父对话单行摘要 + 右侧 child session”，
  // canToggle=false，不再渲染可展开的 tool-summary-trigger。旧 E2E 继续展开必然
  // 假失败；429 原始错误由 provider request 与失败状态 tooltip 两层证据约束。
  const sidePaneAction = await $(`[data-testid="${blockSnapshot.testId}"]`).$(
    `[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`,
  );
  await sidePaneAction.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: `${stage} Agent 卡没有右侧 child session 入口`,
  });
  // tooltip trigger 可能只渲染图标而没有可读文本；可见文案以整张 Agent 卡为准。
  expect(["执行失败", "Failed"].some((label) => blockSnapshot.text.includes(label))).toBe(true);
  const block = await $(`[data-testid="${blockSnapshot.testId}"]`);
  const failedStatus = await block.$('[data-slot="tooltip-trigger"]');
  await failedStatus.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: `${stage} Agent 卡没有失败 tooltip trigger`,
  });
  // E2E 的系统语言跟随 runner；两种受支持语言都必须保留既有失败文案与同一 hover 交互。
  await hoverFailedAgentStatus(blockSnapshot.testId, stage);
  await $('[data-testid^="v4-session-pane-"]').moveTo({
    xOffset: 20,
    yOffset: 20,
  });

  const current = await getV4PaneSnapshot();
  expect(current.canStop).toBe(false);
}

async function hoverFailedAgentStatus(
  blockTestId: string,
  stage: "live" | "restored",
  attempt = 1,
): Promise<void> {
  // Bug 根因：卡片展开和流式收口会让 Radix trigger 重挂载；长批次里单次 moveTo
  // 可能落在旧节点上，或者指针仍在相同坐标而没有新的 pointerenter。每次都从当前
  // DOM 重新取 trigger，先移出卡片再做真实 hover，并只接受当前可见的 tooltip。
  const pane = await $('[data-testid^="v4-session-pane-"]');
  await pane.moveTo({ xOffset: 20, yOffset: 20 });
  const currentBlock = await $(`[data-testid="${blockTestId}"]`);
  const currentTrigger = await currentBlock.$('[data-slot="tooltip-trigger"]');
  await currentTrigger.waitForDisplayed({ timeout: 3000 });
  await currentTrigger.moveTo();

  let latestTooltipText: string | null = null;
  const opened = await browser
    .waitUntil(
      async () => {
        latestTooltipText = await browser.execute(() => {
          const visibleTooltip = Array.from(
            document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"]'),
          ).find((element) => {
            const style = window.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0 &&
              element.getClientRects().length > 0
            );
          });
          return visibleTooltip?.innerText ?? null;
        });
        // Radix 会同时维护展示内容和可访问性镜像，innerText 在部分 Chromium
        // 时序下会返回两份相同文案；产品约束是可见 tooltip 完整包含原始错误。
        return normalizeText(latestTooltipText ?? "").includes(normalizeText(PROVIDER_ERROR));
      },
      {
        interval: 100,
        timeout: 3000,
        timeoutMsg: `${stage} 执行失败 hover 没有显示匹配的可见 tooltip`,
      },
    )
    .then(() => true)
    .catch(() => false);
  if (opened) {
    return;
  }
  if (attempt >= 3) {
    throw new Error(
      `${stage} 执行失败 hover 没有显示可见 tooltip; latest=${JSON.stringify(latestTooltipText)}`,
    );
  }
  await hoverFailedAgentStatus(blockTestId, stage, attempt + 1);
}

function normalizeText(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
