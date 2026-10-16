import {
  TID_CHAT_ASSISTANT_MESSAGE,
  TID_CHAT_SUMMARY_PANEL,
  TID_CHAT_TOOL_CALL_BLOCK,
  testId,
} from "@zcode/shared";

import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  expandAssistantHistoriesWithContent,
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForUpstreamRequest,
  waitForToolCallBlockByToolName,
  waitForToolCallBlockContaining,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

const PROMPT_MARKER = "E2E_PLAN_DIRECTORY_ORDER";
const ENTER_MARKER = "E2E_PLAN_DIRECTORY_ENTER";
const EXIT_MARKER = "E2E_PLAN_DIRECTORY_EXIT";
const PLAN_TITLE = "E2E_PLAN_DIRECTORY_TITLE";
const CONTINUATION_MARKER = "E2E_PLAN_DIRECTORY_CONTINUATION";

describe("conversation session plan directory and original tool order", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("keeps a completed plan at its tool row and opens it from the summary directory", async function () {
    this.timeout(120_000);
    await prepareConversationE2E();

    const prompt = [
      `${PROMPT_MARKER}: create a plan and request approval.`,
      `${ENTER_MARKER}: call EnterPlanMode first.`,
      `${EXIT_MARKER}: call ExitPlanMode with a Markdown H1 exactly named ${PLAN_TITLE}.`,
      `After approval, continue this same turn with the exact text ${CONTINUATION_MARKER}.`,
    ].join(" ");
    await sendPrompt(prompt);
    await waitForUserMessageContaining(PROMPT_MARKER);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ENTER_MARKER, EXIT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan directory initial request",
      60_000,
    );
    await waitForToolCallBlockByToolName("EnterPlanMode", 60_000);
    await waitForUpstreamRequest(
      {
        includes: [EXIT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan directory ExitPlanMode request",
      60_000,
    );
    const planBlock = await waitForToolCallBlockContaining(PLAN_TITLE, 60_000);
    const toolCallId = planBlock.toolCallId;
    if (!toolCallId) {
      throw new Error(`ExitPlanMode block 缺少 toolCallId: ${JSON.stringify(planBlock)}`);
    }

    expect(await hasPlanDirectoryEntry(toolCallId)).toBe(false);
    await waitForPlanApprovalDialog(60_000);
    await approvePlanWithoutFeedback();
    await waitForAssistantMessageContaining(CONTINUATION_MARKER);
    await expandAssistantHistoriesWithContent();
    await waitForPlanBeforeContinuation(toolCallId, CONTINUATION_MARKER, 30_000);

    await openPlanDirectoryEntry(toolCallId, 30_000);
    const detail = await $(`[data-plan-detail-tool-call-id="${toolCallId}"]`);
    await detail.waitForDisplayed({ timeout: 30_000 });
    expect(await detail.getText()).toContain(PLAN_TITLE);
  });
});

async function hasPlanDirectoryEntry(toolCallId: string): Promise<boolean> {
  return browser.execute(
    (id) => document.querySelector(`[data-plan-directory-tool-call-id="${id}"]`) !== null,
    toolCallId,
  );
}

async function waitForPlanApprovalDialog(timeoutMs: number) {
  await browser.waitUntil(
    async () => {
      const body = await $("[data-elicitation-dialog-body='true']");
      const footer = await $("[data-elicitation-dialog-footer='true']");
      if (!(await body.isExisting()) || !(await footer.isExisting())) return false;
      const text = `${await body.getText()}\n${await footer.getText()}`;
      return ["Approve", "批准"].some((candidate) => text.includes(candidate));
    },
    {
      timeout: timeoutMs,
      timeoutMsg: "没有出现 ExitPlanMode 计划审批弹窗",
    },
  );
}

async function approvePlanWithoutFeedback() {
  const approveButton = await $(
    "//button[contains(., 'Approve') or contains(., '批准')]",
  );
  await approveButton.waitForEnabled({ timeout: 30_000 });
  await approveButton.click();
}

async function waitForPlanBeforeContinuation(
  toolCallId: string,
  continuation: string,
  timeoutMs: number,
) {
  const planTestId = testId(TID_CHAT_TOOL_CALL_BLOCK, toolCallId);
  await browser.waitUntil(
    () =>
      browser.execute(
        (toolTestId, assistantPrefix, text) => {
          const plan = document.querySelector(`[data-testid="${toolTestId}"]`);
          const continuationMessage = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid^="${assistantPrefix}-"]`),
          ).find((element) => element.innerText.includes(text));
          if (!plan || !continuationMessage) return false;
          return Boolean(
            plan.compareDocumentPosition(continuationMessage) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          );
        },
        planTestId,
        TID_CHAT_ASSISTANT_MESSAGE,
        continuation,
      ),
    {
      timeout: timeoutMs,
      timeoutMsg: "ExitPlanMode 计划卡片没有保持在后续 assistant 正文之前",
    },
  );
}

async function openPlanDirectoryEntry(toolCallId: string, timeoutMs: number) {
  await browser.waitUntil(
    async () => {
      await browser.execute((panelTestId) => {
        const panel = document.querySelector<HTMLElement>(
          `[data-testid="${panelTestId}"]`,
        );
        if (panel?.dataset.state !== "collapsed") return;
        panel.querySelector<HTMLButtonElement>("button")?.click();
      }, TID_CHAT_SUMMARY_PANEL);
      return hasPlanDirectoryEntry(toolCallId);
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `终态计划没有进入摘要目录: ${toolCallId}`,
    },
  );
  const entry = await $(`[data-plan-directory-tool-call-id="${toolCallId}"]`);
  await entry.click();
}
