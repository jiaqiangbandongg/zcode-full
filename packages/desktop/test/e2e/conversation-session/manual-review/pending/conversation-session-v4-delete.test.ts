// Manual review pending：旧 v4 header 删除入口已按产品边界移除；
// 后续只允许从左侧 task 列表既有生命周期入口重写本 case。
// 证据层 L3：建立 session → 点删除 → deleteSession 命令 → v4-bridge closeSession
//（卸载 + dispose gateway 会话 + 清事件日志）→ pane 回到 draft（shell 起新草稿）。
// 证明会话删除全链路（closeSession 桥接 + onSessionDeleted 导航；真删 record 属 M5）。
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  clickV4DeleteSession,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

describe("v4 M4 门禁：deleteSession", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("建立 session → 删除 → pane 回到 draft", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_DELETE_SEED 建立会话");
    await waitForV4TimelineContaining("V4_DELETE_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "会话没有建立",
      45000,
    );

    // 删除会话 → pane 回到 draft
    await clickV4DeleteSession();
    await waitForV4Pane(
      (s) => s.sessionId === "draft",
      "删除后 pane 没有回到 draft",
      30000,
    );
  });
});
