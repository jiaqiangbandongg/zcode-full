// 状态 C：插件 MCP skill 已安装但被禁用。
// 证明：把 e2e-plugin-mcp-ping 导入到 installed_plugins.json 后再通过
// config.json#plugins.enabledPlugins[id]=false 关闭，agent 不会把
// `mcp__plugin_e2e-plugin-mcp-ping_ping__ping` 注册到模型请求 tools 数组，模型也调不到它。
// 软证据：chat 端没有任何该工具的 tool-call block（normal text 轮次）。
// wdio 启动前已在 <E2E_HOME>/.zcode/cli/plugins/installed_plugins.json 写入带 installPath
// 的记录，并把 config.json#plugins.enabledPlugins[id] 显式置为 false。
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

const DISABLED_TIMEOUT_MS = 180000;

describe("会话区 插件 MCP Skill 生命周期 E2E / 已安装但禁用", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("plugin 已安装但禁用时：请求 tools 数组不含 mcp__plugin_e2e-plugin-mcp-ping_ping__ping，chat 也不出现该工具 block", async function () {
    this.timeout(DISABLED_TIMEOUT_MS);

    await prepareConversationE2E();
    await startNewTask();

    const runId = Date.now();
    const marker = `E2E_PLUGIN_MCP_PING_DISABLED_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendPrompt(prompt);
    await waitForComposerText("", "已禁用 首发后输入框没有清空");
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
      "已禁用 完成后会话没有回到 idle",
      90000,
    );
  });
});
