import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequest,
  waitForToolCallBlockByToolCallId,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";
import { getToolCallDiagnostics } from "../../../helpers/conversation-session-tool-diagnostics.js";

const PARENT_MARKER = "E2E_TOOL_ERROR_SURFACE_PARENT";
const STALE_CHILD_MARKER = "E2E_TOOL_ERROR_SURFACE_STALE_CHILD";
const HEALTHY_CHILD_MARKER = "E2E_TOOL_ERROR_SURFACE_HEALTHY_CHILD";
const HEALTHY_CHILD_DONE = "E2E_TOOL_ERROR_SURFACE_HEALTHY_OK";
const PARENT_DONE = "E2E_TOOL_ERROR_SURFACE_PARENT_DONE";
const STALE_AGENT_TYPE = "e2e-stale-error-reviewer";
const HEALTHY_AGENT_TYPE = "e2e-healthy-error-reviewer";
const STALE_PROVIDER_ID = "e2e-stale-provider";
const STALE_MODEL_ID = "e2e-stale-model";
const STALE_ERROR_TEXT = `Model provider is not configured: ${STALE_PROVIDER_ID}`;
const GENERIC_TURN_ERROR_TEXT = "Turn execution failed";
const STALE_AGENT_TOOL_CALL_ID = "toolu_e2e_tool_error_surface_stale_agent";
const HEALTHY_AGENT_TOOL_CALL_ID = "toolu_e2e_tool_error_surface_healthy_agent";

describe("会话区 toolcall 错误展示 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Z01: Agent 失败工具卡展示真实 provider 根因且不阻断同轮 sibling Agent", async function () {
    this.timeout(180000);

    await prepareConversationE2E();

    const runId = Date.now();
    const marker = `${PARENT_MARKER}_${runId}`;
    const prompt = [
      `${marker}: launch two Agent tools in the same assistant response.`,
      `One must use subagent_type "${STALE_AGENT_TYPE}" for ${STALE_CHILD_MARKER}.`,
      `The other must use subagent_type "${HEALTHY_AGENT_TYPE}" for ${HEALTHY_CHILD_MARKER}.`,
      `After both tool results return, reply with exactly ${PARENT_DONE}.`,
    ].join(" ");

    await sendPrompt(prompt);
    await waitForComposerText("", "tool error surface 首发后输入框没有清空");
    await waitForUserMessageContaining(marker);

    await waitForToolCallBlockByToolCallId(STALE_AGENT_TOOL_CALL_ID, 60000);
    await waitForToolCallBlockByToolCallId(HEALTHY_AGENT_TOOL_CALL_ID, 60000);

    const staleTool = await waitForRendererStoreToolCall(
      STALE_AGENT_TOOL_CALL_ID,
      (toolCall) =>
        toolCall.status === "failed" &&
        toolCall.error?.includes(STALE_ERROR_TEXT) === true,
      "没有等到 failed Agent 工具卡携带真实 provider 错误",
    );
    expect(staleTool.toolName).toBe("Agent");
    expect(staleTool.error).toContain(STALE_ERROR_TEXT);
    expect(staleTool.error).not.toContain(GENERIC_TURN_ERROR_TEXT);
    expect(staleTool.rawErrorMessage ?? "").toContain(STALE_ERROR_TEXT);
    expect(staleTool.rawErrorDetail ?? "").toContain(GENERIC_TURN_ERROR_TEXT);
    expect(staleTool.rawErrorDetail ?? "").toContain(STALE_PROVIDER_ID);
    expect(staleTool.rawErrorDetail ?? "").toContain(STALE_MODEL_ID);

    const healthyTool = await waitForRendererStoreToolCall(
      HEALTHY_AGENT_TOOL_CALL_ID,
      (toolCall) => toolCall.status === "completed",
      "同轮 healthy Agent 没有在 stale Agent 失败后继续完成",
    );
    expect(healthyTool.toolName).toBe("Agent");
    expect(healthyTool.error).toBeNull();

    await waitForToolBlockStatus(STALE_AGENT_TOOL_CALL_ID, "failed");
    await waitForToolBlockStatus(HEALTHY_AGENT_TOOL_CALL_ID, "completed");

    await waitForUpstreamRequest(
      {
        excludes: [GENERIC_TURN_ERROR_TEXT],
        includes: [
          marker,
          STALE_AGENT_TOOL_CALL_ID,
          HEALTHY_AGENT_TOOL_CALL_ID,
          STALE_ERROR_TEXT,
          HEALTHY_CHILD_DONE,
        ],
      },
      "父 continuation 没有同时收到真实失败 tool_result 和 sibling Agent 成功结果",
      60000,
    );

    await waitForAssistantMessageContaining(PARENT_DONE);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "tool error surface case 完成后没有回到 idle",
      60000,
    );
  });
});

interface RendererStoreToolCallSnapshot {
  error: string | null;
  rawErrorDetail: string | null;
  rawErrorMessage: string | null;
  status: string | null;
  toolId: string | null;
  toolName: string | null;
}

async function waitForRendererStoreToolCall(
  toolCallId: string,
  predicate: (toolCall: RendererStoreToolCallSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 60000,
) {
  let latest: RendererStoreToolCallSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readRendererStoreToolCall(toolCallId);
      return latest !== null && predicate(latest);
    },
    {
      timeout,
      timeoutMsg: `${timeoutMsg}; latest=${JSON.stringify(latest)}`,
    },
  );

  const result = await readRendererStoreToolCall(toolCallId);
  if (!result) {
    throw new Error(`renderer store 中没有 toolCallId=${toolCallId}`);
  }
  return result;
}

async function waitForToolBlockStatus(
  toolCallId: string,
  status: string,
  timeout = 60000,
) {
  let latestStatus: string | null = null;
  await browser.waitUntil(
    async () => {
      const diagnostics = await getToolCallDiagnostics({
        type: "toolCallId",
        value: toolCallId,
      });
      latestStatus = diagnostics.matchedBlock?.status ?? null;
      return latestStatus === status;
    },
    {
      timeout,
      timeoutMsg: `toolCallId=${toolCallId} 没有进入 ${status}; latestStatus=${latestStatus}`,
    },
  );
}

async function readRendererStoreToolCall(toolCallId: string) {
  const diagnostics = await getToolCallDiagnostics(null);
  for (const message of diagnostics.rendererStore.messages) {
    const match = message.toolCalls.find(
      (toolCall) =>
        toolCall.toolId === toolCallId ||
        toolCall.toolId?.startsWith(`${toolCallId}:`) === true,
    );
    if (match) {
      return match;
    }
  }
  return null;
}
