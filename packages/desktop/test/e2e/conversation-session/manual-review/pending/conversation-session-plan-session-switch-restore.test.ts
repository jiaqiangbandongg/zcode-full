import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  getChatRootSnapshot,
  prepareConversationE2E,
  selectTaskById,
  sendPrompt,
  startNewTask,
  waitForChatState,
  waitForUpstreamRequest,
  waitForToolCallBlockByToolCallId,
  waitForToolCallBlockByToolName,
  waitForToolCallBlockContaining,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

const PROMPT_MARKER = "E2E_PLAN_SESSION_SWITCH_RESTORE";
const ENTER_MARKER = "E2E_PLAN_SESSION_SWITCH_ENTER";
const EXIT_MARKER = "E2E_PLAN_SESSION_SWITCH_EXIT";
const PLAN_MARKER = "E2E_PLAN_SESSION_SWITCH_RESTORED_BODY";
const EXIT_TOOL_CALL_ID = "toolu_e2e_plan_session_switch_exit";

describe("conversation session ExitPlanMode session switch restore", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("切走期间完成 ExitPlanMode 参数后，切回无需 stop 即展示完整 plan", async function () {
    this.timeout(90_000);
    await prepareConversationE2E();

    const prompt = [
      `${PROMPT_MARKER}: enter plan mode and request approval.`,
      `${ENTER_MARKER}: call EnterPlanMode first.`,
      `${EXIT_MARKER}: then call ExitPlanMode with the proposed plan and include ${PLAN_MARKER}.`,
    ].join(" ");

    await sendPrompt(prompt);
    await waitForUserMessageContaining(PROMPT_MARKER);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ENTER_MARKER, EXIT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan session switch initial request",
      60_000,
    );
    await waitForToolCallBlockByToolName("EnterPlanMode", 60_000);
    await waitForUpstreamRequest(
      {
        includes: [EXIT_MARKER, "toolu_e2e_plan_session_switch_enter"],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan session switch ExitPlanMode request",
      60_000,
    );

    const sourceSnapshot = await getChatRootSnapshot();
    const sourceTaskId = sourceSnapshot.taskId;
    if (!sourceTaskId) {
      throw new Error(`ExitPlanMode 流式预览缺少 taskId: ${JSON.stringify(sourceSnapshot)}`);
    }
    const injection = await injectExitPlanStreamingPreview(sourceTaskId);
    expect(injection).toEqual({ ok: true });
    const streamingPreview = await waitForToolCallBlockByToolCallId(
      EXIT_TOOL_CALL_ID,
      30_000,
    );
    expect(streamingPreview.text).not.toContain(PLAN_MARKER);

    await startNewTask();
    // 受控 SSE 在 tool_input_start 后 8 秒才补完整 JSON；此时原 task 不活跃，
    // 用来稳定复现最终 tool_call 被 tombstone、缓存仍是空预览的窗口。
    await browser.pause(9_500);

    await selectTaskById(sourceTaskId);
    const restoredSnapshot = await waitForChatState(
      (snapshot) => snapshot.taskId === sourceTaskId && snapshot.state === "streaming",
      "切回后原 task 没有恢复到等待计划审批的运行态",
      30_000,
    );
    const restoredPlan = await waitForToolCallBlockContaining(PLAN_MARKER, 30_000);

    expect(restoredSnapshot.stopRequested).toBe(false);
    expect(restoredPlan.toolCallId).toBe(EXIT_TOOL_CALL_ID);
    expect(restoredPlan.toolName).toBe("ExitPlanMode");
    expect(restoredPlan.text).toContain(PLAN_MARKER);
    expect(restoredPlan.text).not.toContain("Unknown");
    await waitForPlanApprovalDialog(30_000);

    // 清理仍在等待审批的 turn；核心断言已在 stop 前完成。
    await browser.keys("Escape");
    await waitForChatState(
      (snapshot) => snapshot.taskId === sourceTaskId && snapshot.state !== "streaming",
      "拒绝计划审批后 task 没有退出运行态",
      30_000,
    );
  });
});

async function waitForPlanApprovalDialog(timeoutMs: number) {
  await browser.waitUntil(
    async () => {
      const body = await $("[data-elicitation-dialog-body='true']");
      if (!(await body.isExisting())) {
        return false;
      }
      const bodyText = await body.getText();
      return ["Approve", "批准", "Implementation plan", "实施计划"].some((text) =>
        bodyText.includes(text),
      );
    },
    {
      timeout: timeoutMs,
      timeoutMsg: "没有出现 ExitPlanMode 计划审批弹窗",
    },
  );
}

async function injectExitPlanStreamingPreview(taskId: string) {
  return browser.execute(
    (taskIdArg, toolIdArg) => {
      type RendererToolCall = {
        input?: unknown;
        kind?: string;
        raw?: unknown;
        status?: string;
        title?: string;
        toolId?: string;
        toolName?: string;
      };
      type RendererMessage = {
        id?: string;
        parts?: Array<{ type?: string; toolId?: string }>;
        role?: string;
        streaming?: boolean;
        thought?: string;
        toolCalls?: RendererToolCall[];
      };
      type RendererWorkspace = {
        activeTaskId?: string | null;
        taskMessagesByTaskId?: Record<string, RendererMessage[]>;
      };
      type RendererStoreState = {
        workspaces?: Record<string, RendererWorkspace>;
      };
      type RendererStore = {
        getState?: () => RendererStoreState;
        setState?: (partial: RendererStoreState) => void;
      };

      const storeApi = (
        window as Window & { __zcodeSessionStoreE2E?: RendererStore }
      ).__zcodeSessionStoreE2E;
      const state = storeApi?.getState?.();
      if (!state?.workspaces || !storeApi?.setState) {
        return { ok: false, reason: "store-api-missing" };
      }
      const workspaceEntry = Object.entries(state.workspaces).find(
        ([, workspace]) => workspace.activeTaskId === taskIdArg,
      );
      if (!workspaceEntry) {
        return { ok: false, reason: "task-workspace-not-found" };
      }
      const [workspaceKey, workspace] = workspaceEntry;
      const messages = workspace.taskMessagesByTaskId?.[taskIdArg] ?? [];
      const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
      const assistant = messages[assistantIndex];
      if (!assistant) {
        return { ok: false, reason: "assistant-message-not-found" };
      }

      const preview: RendererToolCall = {
        input: {},
        kind: "ExitPlanMode",
        raw: { kind: "tool_input_start", toolCallId: toolIdArg },
        status: "pending",
        title: "ExitPlanMode",
        toolId: toolIdArg,
        toolName: "ExitPlanMode",
      };
      const toolCalls = [...(assistant.toolCalls ?? [])];
      const existingToolIndex = toolCalls.findIndex((toolCall) => toolCall.toolId === toolIdArg);
      if (existingToolIndex >= 0) {
        toolCalls[existingToolIndex] = preview;
      } else {
        toolCalls.push(preview);
      }
      const parts = [...(assistant.parts ?? [])];
      if (!parts.some((part) => part.type === "tool-call" && part.toolId === toolIdArg)) {
        parts.push({ type: "tool-call", toolId: toolIdArg });
      }
      const nextMessages = messages.map((message, index) =>
        index === assistantIndex
          ? {
              ...assistant,
              parts,
              streaming: true,
              // 模拟真实事故中 renderer 比 running snapshot 更 rich，确保恢复走 metadata backfill。
              thought: "本地流式分析".repeat(800),
              toolCalls,
            }
          : message,
      );
      storeApi.setState({
        workspaces: {
          ...state.workspaces,
          [workspaceKey]: {
            ...workspace,
            taskMessagesByTaskId: {
              ...workspace.taskMessagesByTaskId,
              [taskIdArg]: nextMessages,
            },
          },
        },
      });
      return { ok: true };
    },
    taskId,
    EXIT_TOOL_CALL_ID,
  );
}
