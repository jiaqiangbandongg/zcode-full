import { clearAppData } from "../helpers/desktop-app.js";
import {
  toggleLatestConversationToolGroup,
  waitForConversationToolGroup,
} from "../helpers/conversation-session-tool-groups.js";
import { ensureToolCrossProductFullAccessMode } from "../helpers/conversation-session-tool-cross-product.js";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";
import { expandAssistantHistoriesWithContent } from "../helpers/conversation-session-tool-diagnostics.js";
import { waitForToolCallBlockByToolCallId } from "../helpers/conversation-session-tool.js";

const FAILURE_MARKER = "E2E_TERMINAL_EXPANDED_FAILURE_STATUS";
const STOP_MARKER = "E2E_TERMINAL_EXPANDED_STOP_STATUS";

describe("TGE02 Terminal expanded details and status", () => {
  before(async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("展开时显示 child 详情，完成后汇总命令数", async function () {
    this.timeout(150000);
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      [
        `${FAILURE_MARKER}: Use Bash commands in order.`,
        `First run exactly: node -e "console.log('TGE02_SUCCESS_OUTPUT')"`,
        `Then run exactly: node -e "console.error('TGE02_FAILURE_OUTPUT'); process.exit(7)"`,
        `After receiving both results reply exactly "${E2E_REPLY_TOKEN}".`,
      ].join(" "),
    );

    await waitForConversationToolGroup(
      "ExecuteGroup",
      (group) => group.status === "in_progress",
      "Terminal 没有进入运行态",
      90000,
    );
    const expanded = await toggleLatestConversationToolGroup("ExecuteGroup", true);
    expect(expanded.summaryText).toMatch(/\b\d+ (command|commands)\b|\d+ 个命令/u);
    expect(expanded.summaryText).not.toContain("node -e");

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 120000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "Terminal 命令统计轮没有结束", 120000);
    await expandAssistantHistoriesWithContent();
    const completed = await waitForConversationToolGroup(
      "ExecuteGroup",
      (group) => group.status === "completed" && group.childCount === 2,
      "Terminal 没有收敛到两个 children",
    );
    expect(completed.summaryText).toMatch(/2 (commands|个命令)/u);
    expect(completed.summaryText).not.toMatch(/failed|失败/u);
    expect(completed.text).toContain("TGE02_SUCCESS_OUTPUT");
    expect(completed.text).toContain("TGE02_FAILURE_OUTPUT");
  });

  it("用户停止单个长命令后 Bash 卡片进入 stopped", async function () {
    this.timeout(150000);
    await startNewV4Draft();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      [
        `${STOP_MARKER}: Use Bash exactly once with this command:`,
        `node -e "setTimeout(() => console.log('TGE02_STOP_SHOULD_NOT_FINISH'), 60000)".`,
        "Do not call any other tool.",
      ].join(" "),
    );
    // 单个 Bash 不再生成 Terminal 父组；等待真实卡片，避免永远等不到父组而错过 Stop。
    const running = await waitForToolCallBlockByToolCallId("toolu_tge02_stopped");
    expect(running.status).toBe("in_progress");
    await clickV4Stop();
    await waitForV4Pane((snapshot) => !snapshot.canStop, "Stop 后工具轮没有结束", 60000);
    await expandAssistantHistoriesWithContent();
    const stopped = await waitForToolCallBlockByToolCallId("toolu_tge02_stopped");
    expect(stopped.status).toBe("stopped");
    expect(stopped.text).not.toContain("Running");
  });
});
