import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import { UPSTREAM_MODEL } from "../../../helpers/upstream-provider.js";
import {
  E2E_REPLY_TOKEN,
  buildReadonlyToolPrompt,
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
  getQueueItems,
  prepareConversationE2E,
  sendPrompt,
  waitForChatState,
  waitForCompactMarkerStatus,
  waitForComposerText,
  waitForQueueContaining,
  waitForQueueCount,
} from "../../../helpers/conversation-session.js";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";

describe("会话区手动 Compact 与 Held Queue E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("held queue 存在时手动 compact 应保留 queue 且不自动消费", async function () {
    this.timeout(180000);

    await prepareConversationE2E();

    const runId = Date.now();
    const prepPromptOne = `E2E_COMPACT_PREP_ONE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(prepPromptOne);
    await waitForUpstreamNetworkCapture(`E2E_COMPACT_PREP_ONE_${runId}`);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle",
      "第一轮 compact 预置消息没有完成",
      30000,
    );

    const prepPromptTwo = buildReadonlyToolPrompt(
      `E2E_COMPACT_PREP_TWO_${runId}`,
    );
    await sendPrompt(prepPromptTwo);
    await waitForUpstreamNetworkCapture(`E2E_COMPACT_PREP_TWO_${runId}`);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle",
      "第二轮 compact 预置消息没有完成",
      30000,
    );
    const readySnapshot = await waitForChatState(
      (snapshot) =>
        Boolean(snapshot.taskId) &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.activeInputId === null,
      "manual compact held queue 预置 task 没有进入 idle completed",
      30000,
    );
    const taskId = readySnapshot.taskId;
    if (!taskId) {
      throw new Error(
        `manual compact held queue 缺少 taskId: ${JSON.stringify(readySnapshot)}`,
      );
    }

    const queuedPrompt = `E2E_COMPACT_QUEUE_HELD_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const injectedQueue = await injectRendererHeldQueuePromptForE2E(
      taskId,
      queuedPrompt,
    );
    await waitForQueueContaining(`E2E_COMPACT_QUEUE_HELD_${runId}`);
    const heldQueue = await waitForQueueCount(1);
    const heldQueueItemId = heldQueue[0]?.id;
    expect(heldQueueItemId).toBeTruthy();
    expect(heldQueueItemId).toBe(injectedQueue.promptId);
    await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.activeInputId === null &&
        snapshot.queueCount === 1 &&
        snapshot.stopRequested,
      // 修复原因：该 case 验证 manual compact 与 held queue 的交互；
      // 用 renderer 测试桥构造 idle held queue，避免 replay 慢流 stop 后请求长时间 pending 误伤 compact。
      "没有构造出 idle held queue 状态",
      30000,
    );

    const queuedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_COMPACT_QUEUE_HELD_${runId}`,
    );
    await sendPrompt("/compact");
    await waitForComposerText("", "/compact 发送后输入框没有清空");
    const startedMarker = await waitForCompactMarkerStatus("started", "manual");
    expect(startedMarker.inputId).toBeTruthy();
    expect(await getQueueItems()).toHaveLength(1);
    expect((await getQueueItems())[0]?.id).toBe(heldQueueItemId);

    const compactRecord = await waitForUpstreamNetworkCapture(
      COMPACT_REQUEST_SENTINEL,
    );
    assertUpstreamRequestCapture(compactRecord, {
      expectedText: COMPACT_REQUEST_SENTINEL,
      model: UPSTREAM_MODEL,
    });

    const completedMarker = await waitForCompactMarkerStatus(
      "completed",
      "manual",
      startedMarker.inputId,
    );
    expect(completedMarker.operationId).toBeTruthy();
    const finalQueue = await waitForQueueCount(1);
    expect(finalQueue[0]?.id).toBe(heldQueueItemId);
    expect(
      await countUpstreamRequestsContaining(`E2E_COMPACT_QUEUE_HELD_${runId}`),
    ).toBe(queuedRequestsBefore);

    const appendPrompt = `E2E_COMPACT_QUEUE_APPEND_AFTER_SUCCESS_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const appendRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_COMPACT_QUEUE_APPEND_AFTER_SUCCESS_${runId}`,
    );
    await sendPrompt(appendPrompt);
    await waitForComposerText(
      "",
      "completed held queue 下发送普通文本后输入框没有清空",
    );
    await waitForQueueContaining(
      `E2E_COMPACT_QUEUE_APPEND_AFTER_SUCCESS_${runId}`,
    );
    const appendedQueue = await waitForQueueCount(2);
    expect(appendedQueue[0]?.id).toBe(heldQueueItemId);
    expect(appendedQueue[1]?.content).toContain(
      `E2E_COMPACT_QUEUE_APPEND_AFTER_SUCCESS_${runId}`,
    );
    await expectNoUpstreamRequestForTextWithin(
      `E2E_COMPACT_QUEUE_APPEND_AFTER_SUCCESS_${runId}`,
      800,
    );
    expect(
      await countUpstreamRequestsContaining(
        `E2E_COMPACT_QUEUE_APPEND_AFTER_SUCCESS_${runId}`,
      ),
    ).toBe(appendRequestsBefore);
  });
});

interface RendererHeldQueueInjectionResult {
  ok: boolean;
  promptId?: string;
  reason?: string;
  workspaceIdentity?: string | null;
  workspacePath?: string | null;
}

async function injectRendererHeldQueuePromptForE2E(
  taskId: string,
  content: string,
): Promise<RendererHeldQueueInjectionResult & { promptId: string }> {
  const result = (await browser.execute(
    (taskIdArg, contentArg) => {
      type RendererTaskMeta = {
        taskId?: string;
        workspaceIdentity?: string;
        workspacePath?: string;
      };
      type RendererWorkspace = {
        activeTaskId?: string | null;
        optimisticTaskListByTaskId?: Record<string, RendererTaskMeta>;
        taskListCache?: RendererTaskMeta[];
      };
      type RendererStore = {
        getState?: () => {
          enqueueTaskQueuedPrompt?: (
            workspacePath: string,
            taskId: string,
            prompt: {
              content: string;
              id: string;
              kind: "text";
              prompt: string;
              timestamp: number;
            },
            workspaceIdentity?: string,
          ) => void;
          setTaskStopRequested?: (
            workspacePath: string,
            taskId: string,
            requested: boolean,
            workspaceIdentity?: string,
          ) => void;
          workspaces?: Record<string, RendererWorkspace>;
        };
      };

      const storeApi = (
        window as Window & { __zcodeSessionStoreE2E?: RendererStore }
      ).__zcodeSessionStoreE2E;
      const state = storeApi?.getState?.();
      if (!state?.enqueueTaskQueuedPrompt || !state.setTaskStopRequested) {
        return { ok: false, reason: "store-api-missing" };
      }

      const workspaceEntry = Object.entries(state.workspaces ?? {}).find(
        ([, workspace]) =>
          workspace.activeTaskId === taskIdArg ||
          Boolean(workspace.optimisticTaskListByTaskId?.[taskIdArg]) ||
          Boolean(
            workspace.taskListCache?.some((task) => task.taskId === taskIdArg),
          ),
      );
      if (!workspaceEntry) {
        return { ok: false, reason: "task-workspace-not-found" };
      }

      const [workspaceKey, workspace] = workspaceEntry;
      const task =
        workspace.optimisticTaskListByTaskId?.[taskIdArg] ??
        workspace.taskListCache?.find((item) => item.taskId === taskIdArg);
      const workspacePath = task?.workspacePath ?? workspaceKey;
      const workspaceIdentity = task?.workspaceIdentity;
      const promptId = `queued-e2e-compact-manual-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;

      state.enqueueTaskQueuedPrompt(
        workspacePath,
        taskIdArg,
        {
          content: contentArg,
          id: promptId,
          kind: "text",
          prompt: contentArg,
          timestamp: Date.now(),
        },
        workspaceIdentity,
      );
      state.setTaskStopRequested(
        workspacePath,
        taskIdArg,
        true,
        workspaceIdentity,
      );

      return {
        ok: true,
        promptId,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      };
    },
    taskId,
    content,
  )) as RendererHeldQueueInjectionResult;

  if (!result.ok || !result.promptId) {
    throw new Error(
      `manual compact held queue 注入失败: ${result.reason ?? "unknown"}`,
    );
  }
  return result as RendererHeldQueueInjectionResult & { promptId: string };
}
