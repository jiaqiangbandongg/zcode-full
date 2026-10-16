// Manual review pending：旧 v4 header 重命名入口已按产品边界移除；
// 后续只允许从左侧 task 列表右键重命名入口重写本 case。
// 证据层 L3：建立 session → header 输入自定义标题 → 提交 → renameSession 命令 →
// v4-bridge → runtime setCustomSessionTitle → SessionTitleUpdated(source:custom) 事件 →
// reducer onSessionTitleUpdated → meta.title 更新（custom 粘性）→ 标题显示同步。
// 证明会话标题子系统（新 snapshot meta + 自动/自定义标题事件 + 8 层 op + 重命名 UI）。
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  getV4SessionTitle,
  prepareV4ConversationE2E,
  renameV4Session,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

describe("v4 M4 门禁：renameSession", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("建立 session → 重命名 → 标题投影更新为自定义值", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_RENAME_SEED 建立会话");
    await waitForV4TimelineContaining("V4_RENAME_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "会话没有建立",
      45000,
    );

    // header 重命名为自定义标题
    const customTitle = "E2E_V4_我的自定义会话";
    await renameV4Session(customTitle);

    // meta.title 投影更新为自定义值（custom 粘性，自动标题不再覆盖）
    await browser.waitUntil(
      async () => (await getV4SessionTitle()) === customTitle,
      { timeout: 30000, timeoutMsg: "会话标题没有更新为自定义值" },
    );
    expect(await getV4SessionTitle()).toBe(customTitle);
  });
});
