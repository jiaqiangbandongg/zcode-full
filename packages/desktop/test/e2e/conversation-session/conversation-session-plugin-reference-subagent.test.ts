// PLG16 formal E2E：Plugin 引用的 model-only system reminder 必须把该 Plugin
// 当前 Session 实际加载成功的 canonical Subagent identifier 一并发送给 provider；
// 不得注入 profile 描述、system prompt 或文件路径，也不得把 reminder 显示到时间线。
import { clearAppData } from "../helpers/desktop-app.js";
import { waitForUpstreamNetworkCapture } from "../helpers/upstream-capture.js";
import {
  PLUGIN_INLINE_ID,
  PLUGIN_INLINE_SUBAGENT_NAME,
  restartPluginLifecycleApp,
  seedInlineLifecyclePlugin,
} from "../helpers/plugin-management-lifecycle.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const PROMPT_MARKER = "E2E_PLUGIN_REFERENCE_SUBAGENT";
const REPLY_MARKER = "PLUGIN_REFERENCE_SUBAGENT_REPLY_OK";
const PLUGIN_REFERENCE_TAG = "<plugin_reference>";

describe("PLG16 Plugin 引用 reminder 包含对应 Subagent", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("provider 收到 live canonical Subagent identifier，UI 与 reminder 均不泄漏 profile 内容", async function () {
    this.timeout(240_000);

    await seedInlineLifecyclePlugin();
    await restartPluginLifecycleApp();
    await prepareV4ConversationE2E();
    await startNewV4Draft();

    const prompt =
      `${PROMPT_MARKER}: use [@${PLUGIN_INLINE_ID}](plugin://${PLUGIN_INLINE_ID}) ` +
      `and reply with exactly ${REPLY_MARKER}.`;
    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(REPLY_MARKER, 60_000);
    await waitForV4Pane(
      (state) =>
        !state.canStop &&
        Boolean(state.sessionId && state.sessionId !== "draft"),
      "Plugin Subagent 引用回合没有回到 idle",
      60_000,
    );

    const capture = await waitForUpstreamNetworkCapture(PROMPT_MARKER);
    const reminderMessages = readPluginReminderMessages(capture.requestJson);
    expect(reminderMessages).toHaveLength(1);
    const reminder = JSON.stringify(reminderMessages[0]);
    expect(reminder).toContain(PLUGIN_INLINE_ID);
    expect(reminder).toContain(
      `subagents: [\\"${PLUGIN_INLINE_SUBAGENT_NAME}\\"]`,
    );
    expect(reminder).not.toContain("E2E inline Plugin reviewer profile");
    expect(reminder).not.toContain("Review the requested files");
    expect(reminder).not.toContain("inline-reviewer.md");

    const timelineHasReminder = await browser.execute(
      (tag) => (document.body.textContent ?? "").includes(tag),
      PLUGIN_REFERENCE_TAG,
    );
    expect(timelineHasReminder).toBe(false);
  });
});

function readPluginReminderMessages(requestJson: unknown): unknown[] {
  if (
    !requestJson ||
    typeof requestJson !== "object" ||
    Array.isArray(requestJson)
  ) {
    throw new Error("Plugin Subagent provider request 不是 JSON object");
  }
  const messages = (requestJson as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    throw new Error("Plugin Subagent provider request 缺少 messages 数组");
  }
  return messages.filter((message) =>
    JSON.stringify(message).includes(PLUGIN_REFERENCE_TAG),
  );
}
