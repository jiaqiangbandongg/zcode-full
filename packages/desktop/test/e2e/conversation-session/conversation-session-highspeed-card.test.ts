import { clearAppData } from "../helpers/desktop-app.js";
import {
  prepareHighspeedDrawWorkspace,
  startHighspeedEntranceProbe,
  takeHighspeedEntranceProbe,
  waitForHighspeedComposer,
  waitForHighspeedComposerCleared,
  waitForHighspeedStatusTag,
} from "../helpers/highspeed-card.js";
import {
  getV4PaneSnapshot,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

// Host Mock 场景：hit-fast（按 spec 文件注入，见 helpers/highspeed-mock-env.ts）。
const HIT_REPLY_TOKEN = "hs-card-hit-done";

describe("Highspeed card E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HS-E2E-01: 抽卡命中后当前消息带 Highspeed 标识并完成，切回 Task 不重播激活动效", async function () {
    this.timeout(180000);

    await prepareHighspeedDrawWorkspace();

    // 发送前开始记录：draw 命中必须真的挂载扩散 Canvas，作为切回不重播断言的正向对照。
    await startHighspeedEntranceProbe();
    // Bug 根因：旧 prompt 内含回复标记，而 timelineText 包含用户消息，发送瞬间就会误判完成。
    // 回复标记只由数据面 fixture 返回（按 E2E_HIGHSPEED_CARD_HIT 命中）。
    await sendV4Prompt("E2E_HIGHSPEED_CARD_HIT: reply with the fixed hit token.");

    await waitForHighspeedComposer("抽卡命中后输入框没有进入 Highspeed 状态");
    await waitForV4TimelineContaining(HIT_REPLY_TOKEN);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(HIT_REPLY_TOKEN),
      "Highspeed mock turn 完成后 pane 仍处于运行态",
      90000,
    );
    await waitForHighspeedStatusTag("完成态消息没有展示 Highspeed 标识");

    // draw 命中按 activation 入场播放扩散；入场方式跨 draft→session 保持，不被恢复链路改写。
    // 不断言 phase：窗口后台化时 rAF 可能节流，扩散收尾时机不属于本 case 的契约。
    const drawEntrance = await takeHighspeedEntranceProbe();
    expect(drawEntrance.entrance).toBe("activation");
    expect(drawEntrance.diffusionMounted).toBe(true);

    // 切到新草稿再切回：恢复入场从 stable 挂载，模型标识立即呈现，不重播扩散（spec §9.2）。
    const { sessionId } = await getV4PaneSnapshot();
    if (!sessionId || sessionId === "draft") {
      throw new Error("Highspeed 首轮完成后 pane 没有绑定 session");
    }
    await startNewV4Draft();
    await waitForHighspeedComposerCleared("新建草稿后输入框仍处于 Highspeed 状态");
    await startHighspeedEntranceProbe();
    await selectV4TaskById(sessionId);
    await waitForHighspeedComposer("切回 Task 后输入框没有恢复 Highspeed 状态");
    const restoreEntrance = await takeHighspeedEntranceProbe();
    expect(restoreEntrance).toEqual({
      diffusionMounted: false,
      entrance: "restore",
      modelIndicatorVisible: true,
      phase: "stable",
    });
  });
});
