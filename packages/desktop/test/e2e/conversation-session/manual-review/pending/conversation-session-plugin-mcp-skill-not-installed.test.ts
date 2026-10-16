// 状态 A：插件 MCP skill 未安装基线。
// 证明：用户从未导入/安装 e2e-plugin-mcp-ping 插件时，agent 不会把
// `mcp__plugin_e2e-plugin-mcp-ping_ping__ping` 写入模型请求 tools 数组，模型也调不到它。
// wdio 启动前会清空 E2E home；该状态不写 plugin 安装记录。
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  getToolCallBlockByToolName,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequestContaining,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";
import {
  PLUGIN_MCP_TOOL_NAME,
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
} from "../../../helpers/plugin-mcp-skill.js";

const NOT_INSTALLED_TIMEOUT_MS = 180000;

describe("会话区 插件 MCP Skill 生命周期 E2E / 未安装基线", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("plugin 未安装时：请求 tools 数组不含 mcp__plugin_e2e-plugin-mcp-ping_ping__ping，chat 也不出现该工具 block", async function () {
    this.timeout(NOT_INSTALLED_TIMEOUT_MS);

    await prepareConversationE2E();
    await startNewTask();

    const runId = Date.now();
    const marker = `E2E_PLUGIN_MCP_PING_NOT_INSTALLED_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendPrompt(prompt);
    await waitForComposerText("", "未安装基线 首发后输入框没有清空");
    await waitForUserMessageContaining(prompt);
    await waitForUpstreamRequestContaining(marker, 60000);

    const requestRecord = await findUpstreamRequestContaining(marker, 60000);
    expect(requestRecord).not.toBeNull();
    if (!requestRecord) return;
    // 强证据：模型请求的 tools 数组里不能有 plugin MCP 工具。
    expect(
      captureArtifactAdvertisesToolName(
        requestRecord.requestJson,
        PLUGIN_MCP_TOOL_NAME,
      ),
    ).toBe(false);

    // 软证据：chat 端没有任何该工具的 tool-call block（normal text 轮次）。
    const block = await getToolCallBlockByToolName(PLUGIN_MCP_TOOL_NAME);
    expect(block).toBeNull();

    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "未安装基线 完成后会话没有回到 idle",
      90000,
    );
  });
});
