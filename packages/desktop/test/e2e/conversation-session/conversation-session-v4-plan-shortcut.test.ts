// `/plan` Composer E2E：覆盖 draft 空命令、任务发送、Plan noop 组合和附件拒绝。
import { clearAppData, setInputValueByTestIdDom } from "../helpers/desktop-app.js";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import {
  assertVisibleV4UserMessagesNotContaining,
  clickV4Send,
  getV4ComposerAttachments,
  getV4ConfigProjection,
  getV4Messages,
  pasteV4ComposerImageAttachment,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  switchV4Mode,
  waitForV4ComposerText,
  waitForV4Pane,
  waitForV4TimelineContaining,
  waitForV4UserMessageContaining,
} from "../helpers/v4-conversation.js";
import {
  countUpstreamTitleRequestsContaining,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "../helpers/conversation-session-network.js";

const SEED_PROMPT = "E2E_V4_PLAN_SHORTCUT_SEED 建立已有会话";
const SEED_REPLY = "V4_PLAN_SHORTCUT_SEED_OK";
const TASK_ONE = "E2E_V4_PLAN_SHORTCUT_TASK_ONE 列出实现步骤";
const TASK_ONE_REPLY = "V4_PLAN_SHORTCUT_TASK_ONE_OK";
const TASK_TWO = "E2E_V4_PLAN_SHORTCUT_TASK_TWO 已处于 Plan 继续发送";
const TASK_TWO_REPLY = "V4_PLAN_SHORTCUT_TASK_TWO_OK";

async function waitForPlanMode() {
  await browser.waitUntil(async () => (await getV4ConfigProjection()).planEnabled, {
    timeout: 30000,
    timeoutMsg: "`/plan` 后输入框的 Plan 标记没有开启",
  });
}

async function establishBuildSession() {
  await prepareV4ConversationE2E();
  // 每个组合都从 build 起步，避免前一个 case 的 draft preference 影响当前 mode CAS 断言。
  await switchV4Mode("build");
  const titleCountBefore = await countUpstreamTitleRequestsContaining(SEED_PROMPT);
  await sendV4Prompt(SEED_PROMPT);
  await waitForV4TimelineContaining(SEED_REPLY, 45000);
  await waitForV4Pane(
    (snapshot) =>
      !snapshot.canStop && snapshot.sessionId !== "draft" && snapshot.sessionId !== null,
    "`/plan` E2E seed 没有回到已有 idle session",
    45000,
  );
  // 首轮结束后标题请求仍会异步发出；先等待种子会话的标题请求，避免计入空 /plan。
  await browser.waitUntil(
    async () => (await countUpstreamTitleRequestsContaining(SEED_PROMPT)) > titleCountBefore,
    { timeout: 30000, timeoutMsg: "种子会话的标题请求未发出" },
  );
}

async function waitForReadyComposerAttachment(filename: string) {
  await browser.waitUntil(
    async () => {
      const attachments = await getV4ComposerAttachments();
      // Bug 原因：图片卡按设计只显示缩略图，filename 不保证是可见文本；本 case
      // 只有一个附件，数量与 ready 状态才是稳定的发送前契约。
      return attachments.length === 1 && attachments[0]?.uploadStatus === "ready";
    },
    { timeout: 30000, timeoutMsg: `附件没有进入 ready：${filename}` },
  );
}

describe("v4 `/plan` Composer shortcut", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("draft `/PLAN` 空命令只切换模式，不创建 user row 或 provider request", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    await startNewV4Draft();
    await switchV4Mode("build");
    const requestCountBefore = await getUpstreamRequestRecordCount();

    await sendV4Prompt("  /PLAN   ");
    await waitForV4ComposerText("", "空 `/plan` 消费后 composer 没有清空");
    await waitForPlanMode();

    expect(await getV4Messages("user")).toHaveLength(0);
    expect(await getUpstreamRequestRecordCount()).toBe(requestCountBefore);
  });

  it("existing session `/plan` 空命令只切换模式，不新增 user row 或 provider request", async function () {
    this.timeout(120000);
    await establishBuildSession();
    const userMessagesBefore = await getV4Messages("user");
    const requestCountBefore = await getUpstreamRequestRecordCount();

    await sendV4Prompt("/plan");
    await waitForV4ComposerText("", "已有会话空 `/plan` 消费后 composer 没有清空");
    await waitForPlanMode();

    expect(await getV4Messages("user")).toHaveLength(userMessagesBefore.length);
    expect(await getUpstreamRequestRecordCount()).toBe(requestCountBefore);
  });

  it("任务命令先切 Plan 再发送正文，且 Plan noop 后仍可继续发送", async function () {
    this.timeout(180000);
    await establishBuildSession();

    await sendV4Prompt(`/plan ${TASK_ONE}`);
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [TASK_ONE],
        lastUserMessageExcludes: ["/plan"],
      },
      "`/plan <task>` provider request 没有只发送任务正文",
      60000,
    );
    await waitForV4TimelineContaining(TASK_ONE_REPLY, 60000);
    await waitForPlanMode();
    await waitForV4UserMessageContaining(TASK_ONE);

    // 当前 session 已经是 Plan；第二次 shortcut 的 mode CAS 应 noop，但仍需发送普通文本。
    await sendV4Prompt(`/plan ${TASK_TWO}`);
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [TASK_TWO],
        lastUserMessageExcludes: ["/plan"],
      },
      "Plan noop 后 `/plan <task>` 没有继续发送正文",
      60000,
    );
    await waitForV4TimelineContaining(TASK_TWO_REPLY, 60000);
    await waitForV4UserMessageContaining(TASK_TWO);
    await assertVisibleV4UserMessagesNotContaining("/plan");
  });

  it("附件拒绝时保留 `/plan <task>` 草稿、附件和当前模式", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    await startNewV4Draft();
    await switchV4Mode("build");
    const modeBefore = (await getV4ConfigProjection()).mode;
    const requestCountBefore = await getUpstreamRequestRecordCount();
    const attachmentName = "e2e-plan-shortcut-rejected.png";
    const draft = "/plan plan-shortcut-attachment-reject";

    await pasteV4ComposerImageAttachment(attachmentName);
    await waitForReadyComposerAttachment(attachmentName);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, draft, {
      timeout: 15000,
      timeoutMsg: "附件拒绝 case 没有写入 `/plan` 草稿",
    });
    await waitForV4ComposerText(draft, "附件拒绝 case 没有写入 `/plan` 草稿");

    await clickV4Send();
    await waitForV4ComposerText(draft, "附件拒绝后 composer 草稿没有保留");
    expect((await getV4ConfigProjection()).mode).toBe(modeBefore);
    expect(await getUpstreamRequestRecordCount()).toBe(requestCountBefore);
    expect(await getV4ComposerAttachments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uploadStatus: "ready",
        }),
      ]),
    );
  });
});
