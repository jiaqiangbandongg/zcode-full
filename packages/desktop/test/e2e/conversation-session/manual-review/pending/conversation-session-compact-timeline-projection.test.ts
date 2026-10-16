import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_ASSISTANT_MESSAGE,
  TID_CHAT_COMPACT_MARKER,
  TID_CHAT_MESSAGES,
  TID_CHAT_USER_MESSAGE,
  TID_CHAT_VIEW,
} from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  assertVisibleUserMessagesNotContaining,
  countUpstreamRequestsContainingAll,
  expandAssistantHistoriesWithContent,
  expectNoUpstreamRequestForTextWithin,
  getChatRootSnapshot,
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequest,
  waitForUpstreamRequestContaining,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

const PROJECTION_MARKER = "E2E_COMPACT_TIMELINE_PROJECTION";
const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const SEED_REPLY_TOKEN = "upstream-e2e-seed-ok";
const PENDING_REPLY_TOKEN = "upstream-e2e-pending-ok";
const AUTO_COMPACT_OBSERVABLE_STATUSES = [
  "started",
  "retrying",
  "completed",
  "skipped",
] as const;

describe("会话区 Compact Timeline Projection E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("auto compact 横线不会切开、吞掉或重复 pending assistant", async function () {
    this.timeout(180000);

    await prepareConversationE2E();

    const runId = Date.now();
    const seedPrompt =
      `${PROJECTION_MARKER}_SEED_${runId}: Reply with exactly "${SEED_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(seedPrompt);
    await waitForComposerText("", "compact timeline projection seed 发送后输入框没有清空");
    await waitForUpstreamRequestContaining(`${PROJECTION_MARKER}_SEED_${runId}`);
    await waitForAssistantMessageContaining(SEED_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "compact timeline projection seed 没有回到 idle",
      90000,
    );

    await expandAssistantHistoriesWithContent();
    const beforeProjection = await readTimelineProjection();
    const beforeTopLevelAssistantCount = beforeProjection.assistantMessages.filter(
      (message) => !message.inAssistantHistory,
    ).length;
    const beforeHistoryCount = beforeProjection.historyTriggers.length;
    const compactRequestsBefore = await countUpstreamRequestsContainingAll([
      COMPACT_REQUEST_SENTINEL,
      PROJECTION_MARKER,
    ]);

    const pendingPrompt =
      `${PROJECTION_MARKER}_PENDING_${runId}: Reply with exactly "${PENDING_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(pendingPrompt);
    await waitForComposerText("", "compact timeline projection pending 发送后输入框没有清空");
    await waitForUserMessageContaining(pendingPrompt);

    const autoMarkerBeforePending = await waitForOptionalAutoCompactMarker(
      AUTO_COMPACT_OBSERVABLE_STATUSES,
      8000,
    );
    // 转正原因：case-local fixture 稳定触发 auto compact 决策；短历史下 no-op skipped 合法，
    // TP 只要求出现的 compact 横线仍属于 pending assistant 工作块。
    expect(autoMarkerBeforePending).not.toBeNull();
    let expectedCompactRequestCount = compactRequestsBefore;
    if (autoMarkerBeforePending?.status !== "skipped") {
      expectedCompactRequestCount = compactRequestsBefore + 1;
      await waitForCompactRequestCount(
        expectedCompactRequestCount,
        "compact timeline projection 没有捕获到 auto compact 请求",
      );

      const busySnapshot = await getChatRootSnapshot();
      if (busySnapshot.state !== "idle") {
        await sendPrompt("/compact");
        await waitForComposerText("", "auto compact/running 中重复 /compact 后输入框没有清空");
        await expectNoUpstreamRequestForTextWithin(COMPACT_REQUEST_SENTINEL, 800);
        expect(
          await countUpstreamRequestsContainingAll([
            COMPACT_REQUEST_SENTINEL,
            PROJECTION_MARKER,
          ]),
        ).toBe(expectedCompactRequestCount);
        await assertVisibleUserMessagesNotContaining("/compact");
      }
    }

    await waitForUpstreamRequest(
      {
        excludes: [COMPACT_REQUEST_SENTINEL],
        includes: [`${PROJECTION_MARKER}_PENDING_${runId}`],
      },
      "compact timeline projection 没有继续 pending 主请求",
      120000,
    );
    await waitForAssistantMessageContaining(PENDING_REPLY_TOKEN);
    expect(
      await countUpstreamRequestsContainingAll([
        COMPACT_REQUEST_SENTINEL,
        PROJECTION_MARKER,
      ]),
    ).toBe(expectedCompactRequestCount);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "compact timeline projection pending 完成后没有回到 idle",
      120000,
    );

    await expandAssistantHistoriesWithContent();
    const projection = await readTimelineProjection();
    const topLevelAssistantDelta =
      projection.assistantMessages.filter((message) => !message.inAssistantHistory).length -
      beforeTopLevelAssistantCount;
    const historyDelta = projection.historyTriggers.length - beforeHistoryCount;
    const topLevelAssistantMessages = projection.assistantMessages.filter(
      (message) => !message.inAssistantHistory,
    );

    expect(topLevelAssistantDelta).toBe(1);
    expect(historyDelta).toBe(1);
    expect(topLevelAssistantMessages.at(-1)?.text).toContain(PENDING_REPLY_TOKEN);

    const autoMarkers = projection.compactMarkers.filter(
      (marker) => marker.trigger === "auto",
    );
    expect(autoMarkers.length).toBeGreaterThan(0);
    expect(autoMarkers.filter((marker) => !marker.inAssistantHistory)).toEqual([]);
    expect(
      autoMarkers.some(
        (marker) =>
          marker.inAssistantHistory && isAutoCompactTerminalStatus(marker.status),
      ),
    ).toBe(true);

    const compactStoreMessages = projection.storeMessages.filter(
      (message) => message.timelineType === "context_compaction",
    );
    expect(compactStoreMessages.length).toBeGreaterThan(0);
    expect(
      compactStoreMessages.filter(
        (message) => message.thought.trim().length > 0 || message.toolCallCount > 0,
      ),
    ).toEqual([]);
    expect(
      compactStoreMessages.filter(
        (message) =>
          message.text.includes(SEED_REPLY_TOKEN) ||
          message.text.includes(PENDING_REPLY_TOKEN),
      ),
    ).toEqual([]);

    const seedAssistantMessages = projection.storeMessages.filter(
      (message) =>
        message.role === "assistant" &&
        message.timelineType === null &&
        message.text.includes(SEED_REPLY_TOKEN),
    );
    const pendingAssistantMessages = projection.storeMessages.filter(
      (message) =>
        message.role === "assistant" &&
        message.timelineType === null &&
        message.text.includes(PENDING_REPLY_TOKEN),
    );
    expect(seedAssistantMessages.length).toBeGreaterThanOrEqual(1);
    expect(pendingAssistantMessages.length).toBeGreaterThanOrEqual(1);
    expect(pendingAssistantMessages.at(-1)?.text).toContain(PENDING_REPLY_TOKEN);
  });

  it("manual compact failed 横线不会把同一轮已工作切成多段", async function () {
    this.timeout(120000);

    await prepareConversationE2E();

    const runId = Date.now();
    const seedPrompt =
      `${PROJECTION_MARKER}_MANUAL_SPLIT_SEED_${runId}: Reply with exactly "${SEED_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(seedPrompt);
    await waitForComposerText("", "manual split fixture seed 发送后输入框没有清空");
    await waitForUpstreamRequestContaining(`${PROJECTION_MARKER}_MANUAL_SPLIT_SEED_${runId}`);
    await waitForAssistantMessageContaining(SEED_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "manual split fixture seed 没有回到 idle",
      90000,
    );
    await waitForProjectionStoreStable("manual split fixture seed terminal snapshot 没有稳定");

    const prompt =
      `MR_GOAL_MANUAL_COMPACT_OUTCOME_SEED_${runId}: 只使用只读工具观察项目。`;
    const tailToken = `MANUAL_COMPACT_FAILED_TAIL_VISIBLE_${runId}`;
    await injectManualCompactFailedSplitFixture(prompt, tailToken);

    await browser.waitUntil(
      async () => {
        const projection = await readTimelineProjection();
        const topLevelAssistantMessages = projection.assistantMessages.filter(
          (message) => !message.inAssistantHistory,
        );
        return (
          projection.userMessages.some((message) => message.text.includes(prompt)) &&
          topLevelAssistantMessages.length === 1 &&
          topLevelAssistantMessages[0]?.historyTriggerCount === 1 &&
          topLevelAssistantMessages[0]?.text.includes(tailToken) === true
        );
      },
      {
        timeout: 15000,
        timeoutMsg: "manual compact failed fixture 没有渲染成单个顶层 assistant 工作块",
      },
    );

    await expandAssistantHistoriesWithContent();
    await browser.waitUntil(
      async () =>
        (await readTimelineProjection()).compactMarkers.some(
          (marker) =>
            marker.operationId === "op-manual-split-failed" &&
            marker.status === "failed" &&
            marker.trigger === "manual" &&
            marker.inAssistantHistory,
        ),
      {
        timeout: 15000,
        timeoutMsg: "manual compact failed marker 没有进入 assistant history",
      },
    );

    const projection = await readTimelineProjection();
    assertManualCompactFailedSplitProjection(projection, tailToken);

    await browser.pause(1500);
    await expandAssistantHistoriesWithContent();
    assertManualCompactFailedSplitProjection(await readTimelineProjection(), tailToken);
  });
});

interface TimelineProjectionSnapshot {
  assistantMessages: Array<{
    historyTriggerCount: number;
    id: string | null;
    inAssistantHistory: boolean;
    text: string;
  }>;
  compactMarkers: Array<{
    assistantMessageId: string | null;
    inAssistantHistory: boolean;
    operationId: string | null;
    phase: string | null;
    status: string | null;
    text: string;
    trigger: string | null;
  }>;
  historyTriggers: Array<{
    assistantMessageId: string | null;
    expanded: boolean;
    stateKey: string | null;
    text: string;
  }>;
  storeMessages: Array<{
    content: string;
    id: string | null;
    partTypes: string[];
    role: string | null;
    text: string;
    thought: string;
    timelineStatus: string | null;
    timelineTrigger: string | null;
    timelineType: string | null;
    toolCallCount: number;
  }>;
  taskId: string | null;
  userMessages: Array<{
    id: string | null;
    text: string;
  }>;
}

async function readTimelineProjection(): Promise<TimelineProjectionSnapshot> {
  const rootSnapshot = await getChatRootSnapshot();
  return browser.execute(
    (
      chatViewTestId,
      messagesTestId,
      userMessagePrefix,
      assistantMessagePrefix,
      historyTriggerPrefix,
      historyContentPrefix,
      compactMarkerPrefix,
      fallbackTaskId,
    ) => {
      const normalizeText = (value: string | undefined | null) =>
        (value ?? "").replace(/\u00a0/g, " ").trim();
      const closestAssistantId = (element: HTMLElement) =>
        element
          .closest<HTMLElement>(`[data-testid^="${assistantMessagePrefix}-"]`)
          ?.getAttribute("data-message-id") ?? null;
      const chatView = document.querySelector<HTMLElement>(
        `[data-testid="${chatViewTestId}"]`,
      );
      const taskId = chatView?.getAttribute("data-task-id") || fallbackTaskId;
      const root = document.querySelector<HTMLElement>(
        `[data-testid="${messagesTestId}"]`,
      );
      const assistantMessages = Array.from(
        root?.querySelectorAll<HTMLElement>(
          `[data-testid^="${assistantMessagePrefix}-"]`,
        ) ?? [],
      ).map((message) => ({
        historyTriggerCount: message.querySelectorAll(
          `[data-testid^="${historyTriggerPrefix}-"]`,
        ).length,
        id: message.getAttribute("data-message-id"),
        inAssistantHistory: Boolean(
          message.closest(`[data-testid^="${historyContentPrefix}-"]`),
        ),
        text: normalizeText(message.innerText),
      }));
      const userMessages = Array.from(
        root?.querySelectorAll<HTMLElement>(
          `[data-testid^="${userMessagePrefix}-"]`,
        ) ?? [],
      ).map((message) => ({
        id: message.getAttribute("data-message-id"),
        text: normalizeText(message.innerText),
      }));
      const historyTriggers = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${historyTriggerPrefix}-"]`,
        ),
      ).map((trigger) => ({
        assistantMessageId: closestAssistantId(trigger),
        expanded: trigger.getAttribute("aria-expanded") === "true",
        stateKey: trigger.getAttribute("data-history-state-key"),
        text: normalizeText(trigger.innerText),
      }));
      const compactMarkers = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${compactMarkerPrefix}-"]`,
        ),
      ).map((marker) => ({
        assistantMessageId: closestAssistantId(marker),
        inAssistantHistory: Boolean(
          marker.closest(`[data-testid^="${historyContentPrefix}-"]`),
        ),
        operationId: marker.getAttribute("data-operation-id"),
        phase: marker.getAttribute("data-phase"),
        status: marker.getAttribute("data-status"),
        text: normalizeText(marker.innerText),
        trigger: marker.getAttribute("data-trigger"),
      }));
      const storeApi = (
        window as Window & {
          __zcodeSessionStoreE2E?: {
            getState?: () => {
              workspaces?: Record<
                string,
                {
                  taskMessagesByTaskId?: Record<string, RendererStoreRawMessage[]>;
                }
              >;
            };
          };
        }
      ).__zcodeSessionStoreE2E;
      const state = storeApi?.getState?.();
      const rawMessages = Object.values(state?.workspaces ?? {}).flatMap(
        (workspace) => (taskId ? (workspace.taskMessagesByTaskId?.[taskId] ?? []) : []),
      );
      const storeMessages = rawMessages.map((message) => {
        const partTexts = (message.parts ?? [])
          .map((part) => normalizeText(part.content))
          .filter(Boolean);
        const content = normalizeText(message.content);
        const thought = normalizeText(message.thought);
        return {
          content,
          id: message.id ?? null,
          partTypes: (message.parts ?? []).map((part) => part.type ?? ""),
          role: message.role ?? null,
          text: [content, thought, ...partTexts].filter(Boolean).join("\n"),
          thought,
          timelineStatus: message.syntheticTimeline?.status ?? null,
          timelineTrigger: message.syntheticTimeline?.trigger ?? null,
          timelineType: message.syntheticTimeline?.type ?? null,
          toolCallCount: message.toolCalls?.length ?? 0,
        };
      });
      return {
        assistantMessages,
        compactMarkers,
        historyTriggers,
        storeMessages,
        taskId,
        userMessages,
      };
    },
    TID_CHAT_VIEW,
    TID_CHAT_MESSAGES,
    TID_CHAT_USER_MESSAGE,
    TID_CHAT_ASSISTANT_MESSAGE,
    TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
    TID_CHAT_ASSISTANT_HISTORY_CONTENT,
    TID_CHAT_COMPACT_MARKER,
    rootSnapshot.taskId,
  );
}

type CompactProjectionMarker = TimelineProjectionSnapshot["compactMarkers"][number];

async function waitForOptionalAutoCompactMarker(
  statuses: readonly string[],
  timeoutMs: number,
): Promise<CompactProjectionMarker | null> {
  let latestMarkers: CompactProjectionMarker[] = [];
  await browser
    .waitUntil(
      async () => {
        latestMarkers = (await readTimelineProjection()).compactMarkers.filter(
          (marker) =>
            marker.trigger === "auto" && statuses.includes(marker.status ?? ""),
        );
        return latestMarkers.length > 0;
      },
      {
        timeout: timeoutMs,
        timeoutMsg: "没有观察到 auto compact marker",
      },
    )
    .catch(() => undefined);

  return latestMarkers.at(-1) ?? null;
}

async function waitForCompactRequestCount(expectedCount: number, timeoutMsg: string) {
  await browser.waitUntil(
    async () =>
      (await countUpstreamRequestsContainingAll([
        COMPACT_REQUEST_SENTINEL,
        PROJECTION_MARKER,
      ])) === expectedCount,
    {
      timeout: 30000,
      timeoutMsg,
    },
  );
}

function isAutoCompactTerminalStatus(status: string | null) {
  return status === "completed" || status === "skipped";
}

async function waitForProjectionStoreStable(label: string, stableMs = 900, timeoutMs = 10000) {
  let lastSignature = "";
  let lastChangedAt = Date.now();
  await browser.waitUntil(
    async () => {
      const projection = await readTimelineProjection();
      const signature = JSON.stringify({
        messages: projection.storeMessages.map((message) => [
          message.id,
          message.role,
          message.text,
          message.timelineType,
          message.timelineStatus,
          message.toolCallCount,
        ]),
        taskId: projection.taskId,
      });
      const now = Date.now();
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastChangedAt = now;
        return false;
      }
      return now - lastChangedAt >= stableMs;
    },
    {
      timeout: timeoutMs,
      timeoutMsg: label,
    },
  );
}

function assertManualCompactFailedSplitProjection(
  projection: TimelineProjectionSnapshot,
  tailToken: string,
) {
  const topLevelAssistantMessages = projection.assistantMessages.filter(
    (message) => !message.inAssistantHistory,
  );
  const manualFailedMarkers = projection.compactMarkers.filter(
    (marker) => marker.operationId === "op-manual-split-failed",
  );

  expect(topLevelAssistantMessages).toHaveLength(1);
  expect(topLevelAssistantMessages[0]?.historyTriggerCount).toBe(1);
  expect(topLevelAssistantMessages[0]?.text).toContain(tailToken);
  expect(manualFailedMarkers).toHaveLength(1);
  expect(manualFailedMarkers[0]).toMatchObject({
    inAssistantHistory: true,
    status: "failed",
    trigger: "manual",
  });
  expect(projection.compactMarkers.filter((marker) => !marker.inAssistantHistory)).toEqual([]);
  // 修复原因：E2E locale 可能是 en-US，不能用中文文案判断失败横线是否在工作块里。
  expect(manualFailedMarkers[0]?.text.trim().length).toBeGreaterThan(0);
  expect(topLevelAssistantMessages[0]?.text).toContain(manualFailedMarkers[0]?.text);
}

async function injectManualCompactFailedSplitFixture(prompt: string, tailToken: string) {
  const rootSnapshot = await getChatRootSnapshot();
  if (!rootSnapshot.taskId) {
    throw new Error("manual compact failed split fixture 需要先创建真实 task");
  }

  const result = (await browser.execute(
    (taskIdArg, promptArg, tailTokenArg) => {
      const storeApi = (
        window as Window & {
          __zcodeSessionStoreE2E?: {
            getState?: () => {
              setTaskMessages?: (
                workspacePath: string,
                taskId: string,
                messages: RendererStoreRawMessage[],
                workspaceIdentity?: string,
              ) => void;
              setTaskRuntimeState?: (
                workspacePath: string,
                taskId: string,
                status: string,
                activeInputId?: string,
                workspaceIdentity?: string,
              ) => void;
              workspaces?: Record<
                string,
                {
                  activeTaskId?: string | null;
                  taskMessagesByTaskId?: Record<string, RendererStoreRawMessage[]>;
                }
              >;
            };
          };
        }
      ).__zcodeSessionStoreE2E;
      const state = storeApi?.getState?.();
      const workspaceEntry = Object.entries(state?.workspaces ?? {}).find(
        ([, workspace]) =>
          workspace.activeTaskId === taskIdArg ||
          Boolean(workspace.taskMessagesByTaskId?.[taskIdArg]),
      );
      if (!state || !workspaceEntry) {
        return {
          ok: false,
          reason: "task-workspace-not-found",
        };
      }

      const [workspacePath] = workspaceEntry;
      const now = Date.now();
      const messages: RendererStoreRawMessage[] = [
        {
          content: promptArg,
          id: "manual-split-user",
          role: "user",
          timestamp: now,
          turnIndex: 0,
        },
        {
          content: "",
          durationMs: 15000,
          id: "manual-split-assistant-before",
          parts: [
            { content: "思考过程 持续了几秒", type: "thought" },
            { toolId: "tool-manual-split-glob", type: "tool-call" },
          ],
          role: "assistant",
          thought: "思考过程 持续了几秒",
          timestamp: now + 1,
          toolCalls: [
            {
              input: { pattern: "**/package.json" },
              kind: "Glob",
              output: "package.json",
              status: "completed",
              title: "Glob",
              toolId: "tool-manual-split-glob",
              toolName: "Glob",
            },
          ],
          turnIndex: 0,
        },
        {
          content: "",
          id: "manual-split-compact-failed",
          role: "assistant",
          syntheticTimeline: {
            display: "separator",
            inputId: "input-manual-split-failed",
            kind: "synthetic",
            operationId: "op-manual-split-failed",
            phase: "mid_turn",
            reason: "E2E fixture manual compact failed",
            status: "failed",
            trigger: "manual",
            type: "context_compaction",
            version: 1,
          },
          timestamp: now + 2,
          turnIndex: 0,
        },
        {
          content: tailTokenArg,
          durationMs: 11000,
          id: "manual-split-assistant-tail",
          parts: [
            { content: "压缩失败后继续思考", type: "thought" },
            { content: tailTokenArg, type: "content" },
          ],
          role: "assistant",
          thought: "压缩失败后继续思考",
          timestamp: now + 3,
          turnIndex: 0,
        },
      ];

      state.setTaskMessages?.(workspacePath, taskIdArg, messages);
      state.setTaskRuntimeState?.(workspacePath, taskIdArg, "completed");
      return {
        ok: true,
        taskId: taskIdArg,
        workspacePath,
      };
    },
    rootSnapshot.taskId,
    prompt,
    tailToken,
  )) as ManualCompactFailedSplitFixtureResult;

  if (!result.ok) {
    throw new Error(`manual compact failed split fixture 注入失败: ${result.reason}`);
  }
}

interface RendererStoreRawMessage {
  content?: string;
  durationMs?: number;
  id?: string;
  parts?: Array<{
    content?: string;
    toolId?: string;
    type?: string;
  }>;
  role?: string;
  syntheticTimeline?: {
    display?: string;
    inputId?: string;
    kind?: string;
    operationId?: string;
    phase?: string;
    reason?: string;
    status?: string;
    trigger?: string;
    type?: string;
    version?: number;
  };
  timestamp?: number;
  thought?: string;
  toolCalls?: unknown[];
  turnIndex?: number;
}

type ManualCompactFailedSplitFixtureResult =
  | {
      ok: true;
      taskId: string;
      workspacePath: string;
    }
  | {
      ok: false;
      reason: string;
    };
