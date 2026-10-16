import {
  TID_TASK_ITEM,
  TID_WORKSPACE_TITLE,
  testId,
} from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  getTaskStoreSnapshot,
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

const PROMPT_MARKER = "E2E_TITLE_SIDECAR_TIMEOUT";
const SKILL_LINK =
  "[$e2e-case-lifecycle](/Users/dev/workspace/z-code/.agents/skills/e2e-case-lifecycle/SKILL.md)";
const FINAL_TOKEN = "e2e-title-timeout-ok";
const GENERATED_TITLE = "e2e-case-lifecycle 技能说明";

describe("conversation session title generation timeout", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("消息以技能链接开头且标题 sidecar 慢于 15s 但小于 60s 时仍应回写任务标题", async function () {
    this.timeout(120000);

    await prepareConversationE2E();

    const runId = Date.now();
    const prompt =
      `${SKILL_LINK} ${PROMPT_MARKER}_${runId}: 请用一句话回答，并且最终回答必须只包含 ${FINAL_TOKEN}`;
    await sendPrompt(prompt);
    await waitForComposerText("", "标题超时 case 首发后输入框没有清空");
    await waitForUserMessageContaining(PROMPT_MARKER);

    const runningSnapshot = await waitForChatState(
      (snapshot) => Boolean(snapshot.sessionId || snapshot.taskId),
      "标题超时 case 首发后没有创建 task",
      30000,
    );
    const taskId = runningSnapshot.sessionId || runningSnapshot.taskId;
    if (!taskId) {
      throw new Error("标题超时 case 缺少 taskId，无法断言标题回写");
    }

    await waitForAssistantMessageContaining(FINAL_TOKEN);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "标题超时 case 主回复完成后没有回到 idle",
      90000,
    );

    await waitForGeneratedTaskTitle(taskId);
    await waitForHeaderTitle(GENERATED_TITLE);
    await waitForTaskItemTitle(taskId, GENERATED_TITLE);
  });
});

async function waitForGeneratedTaskTitle(taskId: string) {
  let latestTitle: string | null = null;
  await browser.waitUntil(
    async () => {
      const snapshot = await getTaskStoreSnapshot(taskId);
      latestTitle = snapshot.taskMeta?.title ?? null;
      return latestTitle === GENERATED_TITLE;
    },
    {
      timeout: 70000,
      timeoutMsg: `标题 sidecar 没有在 60s timeout 内回写生成标题，latest=${latestTitle}`,
    },
  );
}

async function waitForHeaderTitle(expectedTitle: string) {
  await browser.waitUntil(
    async () =>
      browser.execute((titleTestId, title) => {
        const header = document.querySelector<HTMLElement>(
          `[data-testid="${titleTestId}"]`,
        );
        return (
          header?.innerText.includes(title) ||
          header?.getAttribute("title") === title
        );
      }, TID_WORKSPACE_TITLE, expectedTitle),
    {
      timeout: 10000,
      timeoutMsg: `WorkspaceHeader 没有展示生成标题: ${expectedTitle}`,
    },
  );
}

async function waitForTaskItemTitle(taskId: string, expectedTitle: string) {
  const taskItemTestId = testId(TID_TASK_ITEM, taskId);
  await browser.waitUntil(
    async () =>
      browser.execute((itemTestId, title) => {
        const item = document.querySelector<HTMLElement>(
          `[data-testid="${itemTestId}"]`,
        );
        return item?.innerText.includes(title) ?? false;
      }, taskItemTestId, expectedTitle),
    {
      timeout: 10000,
      timeoutMsg: `任务列表没有展示生成标题: ${expectedTitle}`,
    },
  );
}
