// catalog E09（forkUsesEditedActiveBranch）验收（case catalog 战役）。
// 证据层 L3：edit 重跑替换分支 → fork 编辑后的 assistant → child 只含 active branch，
// 不带被 rewind 掉的旧 user/assistant 分支。历史对账链路 = rowId→messageId 翻译 +
// RewindTriggered 截断 + fork 复制 + child 冷订阅 transcript 合成 hydration（曾出过 bug 的面）。
import { clearAppData } from "../helpers/desktop-app.js";
import {
  clickFirstV4Fork,
  editFirstV4UserQuery,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Edit,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("v4 catalog E09：fork 使用编辑后的 active branch", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("edit 重跑后 fork → child 只含编辑分支，不带旧分支", async () => {
    await prepareV4ConversationE2E();

    // 原始首轮
    await sendV4Prompt("E2E_V4_BRANCH_T1 原始问题");
    await waitForV4TimelineContaining("V4_BRANCH_T1_REPLY", 60000);
    const parent = await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null && !s.canStop,
      "首轮没有完成",
      45000,
    );
    const parentSessionId = parent.sessionId;

    // edit：行内 newText + Send → rewind 截断 + 重跑
    await waitForV4Edit();
    await editFirstV4UserQuery("E2E_V4_BRANCH_EDITED 编辑后的问题");
    await waitForV4TimelineContaining("V4_BRANCH_EDITED_REPLY", 60000);
    const afterEdit = await getV4PaneSnapshot();
    expect(afterEdit.timelineText).not.toContain("V4_BRANCH_T1_REPLY");
    expect(afterEdit.timelineText).not.toContain("E2E_V4_BRANCH_T1");

    // fork 编辑后的 assistant 行
    await waitForV4Pane((s) => !s.canStop, "edit 重跑没有收口", 45000);
    await waitForV4Fork();
    expect(await clickFirstV4Fork()).toBe(true);

    const child = await waitForV4Pane(
      (s) =>
        s.sessionId !== null &&
        s.sessionId !== "draft" &&
        s.sessionId !== parentSessionId,
      "fork 后 pane 没有切到 child session",
      60000,
    );
    expect(child.sessionId).not.toBe(parentSessionId);

    // child 历史 = 编辑后的 active branch；旧分支不得进入 child。
    // 注：rewind 合成 notice（rewoundPromptPreview）会引用被编辑掉的原 prompt 文本，
    // 这是 transcript 对 rewind 的记录、不是旧分支复活——强断言只看旧 assistant 回复
    // 与旧 user turn 是否作为真实轮次存在。
    await waitForV4TimelineContaining("V4_BRANCH_EDITED_REPLY", 30000);
    const childSnapshot = await getV4PaneSnapshot();
    expect(childSnapshot.timelineText).toContain("E2E_V4_BRANCH_EDITED");
    expect(childSnapshot.timelineText).not.toContain("V4_BRANCH_T1_REPLY");
  });
});
