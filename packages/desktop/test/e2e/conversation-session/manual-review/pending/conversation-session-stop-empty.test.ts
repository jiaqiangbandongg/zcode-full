import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "../../../helpers/upstream-capture.js";
import { ensureToolCrossProductFullAccessMode } from "../../../helpers/conversation-session-tool-cross-product.js";
import {
  E2E_REPLY_TOKEN,
  clickChatStop,
  prepareConversationE2E,
  sendPrompt,
  waitForChatState,
  waitForComposerText,
  waitForToolCallBlockByToolCallId,
} from "../../../helpers/conversation-session.js";

describe("会话区 Stop Empty Queue E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("stop 后 queue=0 应退出 running，之后普通文本应立即开始下一轮", async function () {
    this.timeout(150000);

    await prepareConversationE2E();

    const runId = Date.now();
    const firstPrompt = `E2E_SLOW_STREAM E2E_STOP_EMPTY_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(firstPrompt);
    await waitForComposerText("", "空队列 stop 首轮发送后输入框没有清空");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming" && snapshot.queueCount === 0,
      "空队列 stop 首轮没有进入 streaming",
      30000,
    );
    await waitForUpstreamNetworkRequestStarted(`E2E_STOP_EMPTY_RUNNING_${runId}`);

    await clickChatStop();
    await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.queueCount === 0 &&
        snapshot.runtimeStatus === "completed" &&
        !snapshot.stopRequested,
      "空队列 stop 后没有退出 running completed 态",
      30000,
    );

    const nextPrompt = `E2E_STOP_EMPTY_NEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(nextPrompt);
    await waitForComposerText("", "空队列 stop 后下一轮发送没有清空输入框");
    await waitForUpstreamNetworkCapture(`E2E_STOP_EMPTY_NEXT_${runId}`);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "空队列 stop 后下一轮没有完成并保持 queue=0",
      90000,
    );
  });

  it("tool call 运行中 stop 后 queue=0，之后普通文本应立即开始下一轮", async function () {
    this.timeout(150000);

    await prepareConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    const runId = Date.now();
    const toolPrompt = `E2E_STOP_EMPTY_TOOLCALL_RUNNING_${runId}: Start a long Bash tool call, then wait.`;
    await sendPrompt(toolPrompt);
    await waitForComposerText("", "toolcall stop 首轮发送后输入框没有清空");
    await waitForUpstreamNetworkRequestStarted(`E2E_STOP_EMPTY_TOOLCALL_RUNNING_${runId}`);
    await waitForToolCallBlockByToolCallId("toolu_e2e_stop_empty_toolcall_bash", 30000);
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming" && snapshot.queueCount === 0,
      "toolcall stop 首轮没有保持 streaming 且 queue=0",
      30000,
    );

    await clickChatStop();
    await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.queueCount === 0 &&
        snapshot.runtimeStatus === "completed" &&
        !snapshot.stopRequested,
      "toolcall stop 后没有退出 running completed 态",
      30000,
    );

    const nextPrompt = `E2E_STOP_EMPTY_TOOLCALL_NEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(nextPrompt);
    await waitForComposerText("", "toolcall stop 后下一轮发送没有清空输入框");
    await waitForUpstreamNetworkCapture(`E2E_STOP_EMPTY_TOOLCALL_NEXT_${runId}`);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "toolcall stop 后下一轮没有完成并保持 queue=0",
      90000,
    );
  });
});
