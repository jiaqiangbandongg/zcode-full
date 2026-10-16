// M5④ 门禁：长会话虚拟滚动（timeline 动态测高 + 底部锚定 + 回到底部）。
// 证据层 L3：14 个 completed turn 构造稳定多 turn 历史，验证
// ① 底部锚定跟随——完流后无需手动滚动即可见末行；
// ② 顶部历史可达——scrollTop=0 后最早的行在 DOM 中可见（虚拟窗口正确回填）；
// ③ 上滚不被流式拉回——turn2 慢流期间用户停留在顶部，scrollTop 不被增量拽回底部；
// ④ 回到底部按钮——解除跟随后出现，点按恢复跟随并贴底。
// 锚定状态机语义的完整覆盖在 L1 单测（packages/ui/test/v4TimelineScrollAnchor.test.ts）。
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";
import { clearAppData } from "../helpers/desktop-app.js";
import {
  clickV4TimelineBackToBottom,
  getV4TimelineScrollState,
  prepareV4ConversationE2E,
  scrollV4TimelineToTop,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("v4 M5④ 门禁：长会话虚拟滚动", () => {
  const HISTORY_TURNS = 14;
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("50+ 行历史：底部锚定跟随 → 顶部可达 → 流式不拉回 → 回到底部", async () => {
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E();

    for (let index = 1; index <= HISTORY_TURNS; index += 1) {
      const marker = String(index).padStart(3, "0");
      await sendV4Prompt(`E2E_V4_SCROLL_HISTORY_${marker} 长会话历史`);
      await browser.waitUntil(
        async () => {
          const state = await getV4TimelineScrollState();
          // render unit 在 user row 到达时就会建立；若只等 unit 数量，最后一个
          // assistant/timeline row 尚未物化便会进入断言，默认 CI 串行负载下会读到 41/42。
          return state.renderUnitCount >= index && state.windowRowCount >= index * 3;
        },
        { timeout: 30000, timeoutMsg: `第 ${index} 个 scroll history turn 未完成` },
      );
    }

    const anchored = await getV4TimelineScrollState();
    const sessionA = await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== null,
      "长会话没有绑定 session id",
    );
    if (!sessionA.sessionId) throw new Error("长会话 session id 缺失");
    // 修复原因：这个 case 验证的是 logical turn 虚拟化；provider 可把单个 logical
    // turn 投影为更多 raw rows，精确绑定 3 rows/turn 会把合法投影误报成滚动失败。
    expect(anchored.windowRowCount).toBeGreaterThanOrEqual(HISTORY_TURNS * 3);
    expect(anchored.renderUnitCount).toBe(HISTORY_TURNS);
    expect(anchored.following).toBe("true");
    // 虚拟化生效：DOM 中挂载的行数少于投影窗口行数（长会话不全量渲染）。
    expect(anchored.mountedRenderUnitCount).toBeLessThan(anchored.renderUnitCount);
    // 内容总高远超视口（可滚动历史确实存在）。
    expect(anchored.scrollHeight).toBeGreaterThan(anchored.clientHeight * 2);

    // ── 顶部历史可达：滚到顶后最早的行进入 DOM ──
    await scrollV4TimelineToTop();
    await waitForV4TimelineContaining("E2E_V4_SCROLL_HISTORY_001", 15000);
    await browser.waitUntil(
      async () => {
        const state = await getV4TimelineScrollState();
        return state.following === "false" && state.hasBackToBottom;
      },
      {
        timeout: 10000,
        timeoutMsg: "上滚离底后没有解除跟随/出现回到底部按钮",
      },
    );

    const savedHistoricalPosition = await getV4TimelineScrollState();
    await startNewV4Draft();
    await selectV4TaskById(sessionA.sessionId);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionA.sessionId,
      "切回长会话后 session 没有恢复",
    );
    await browser.waitUntil(
      async () => {
        const restored = await getV4TimelineScrollState();
        return (
          restored.following === "false" &&
          restored.hasBackToBottom &&
          Math.abs(restored.scrollTop - savedHistoricalPosition.scrollTop) <= 4
        );
      },
      {
        timeout: 15000,
        timeoutMsg: "切回长会话后没有恢复离底阅读位置",
      },
    );

    // ── turn2：慢流期间停在顶部，流式增量不得拉回 ──
    await clickV4TimelineBackToBottom();
    await sendV4Prompt("E2E_V4_SCROLL_TURN2 保持输出");
    await waitForV4TimelineContaining("V4_SCROLL_TURN2_STREAMING", 45000);
    await waitForV4Pane((s) => s.canStop, "turn2 streaming 没有出现 stop 按钮");

    await scrollV4TimelineToTop();
    await waitForV4TimelineContaining("E2E_V4_SCROLL_HISTORY_001", 15000);
    // 流式仍在进行的窗口内多次采样：scrollTop 必须停在顶部附近（不被增量拽回）。
    for (let sample = 0; sample < 4; sample += 1) {
      await browser.pause(700);
      const during = await getV4TimelineScrollState();
      expect(during.scrollTop).toBeLessThan(200);
      expect(during.following).toBe("false");
    }
    // 采样窗口结束时 turn2 仍在流式（证明上面的采样发生在流式期间）。
    const midStream = await waitForV4Pane(() => true, "读取流式中 pane 状态失败", 5000);
    expect(midStream.canStop).toBe(true);

    // ── 回到底部：恢复跟随，完流文本自动可见 ──
    await clickV4TimelineBackToBottom();
    const beforeBackgroundOutput = await waitForV4Pane(
      (snapshot) => snapshot.timelineText.includes("turn2 持续输出片段"),
      "切走前没有可比较的 turn2 流式片段",
    );
    const beforeBackgroundFragmentCount =
      beforeBackgroundOutput.timelineText.match(/turn2 持续输出片段/g)?.length ?? 0;
    await startNewV4Draft();
    await browser.pause(1200);
    await selectV4TaskById(sessionA.sessionId);
    const afterBackgroundOutput = await waitForV4Pane((snapshot) => {
      const fragmentCount = snapshot.timelineText.match(/turn2 持续输出片段/g)?.length ?? 0;
      // 修复原因：E2E 的 session projection keep-warm 只有 1 秒；切走 1.2 秒后
      // 切回时 data-session-id 会先于新 lease/snapshot 生效。只等待 session id 会
      // 在 timeline rows 仍为空的过渡帧返回 0，误判后台流式丢失。这里同时等待目标
      // timeline 恢复且片段确实增长，保持 SRM03 的后台输出 + 吸底恢复原始语义。
      return (
        snapshot.sessionId === sessionA.sessionId && fragmentCount > beforeBackgroundFragmentCount
      );
    }, "后台流式期间切回原 session 后投影没有恢复新增片段");
    const afterBackgroundFragmentCount =
      afterBackgroundOutput.timelineText.match(/turn2 持续输出片段/g)?.length ?? 0;
    expect(afterBackgroundFragmentCount).toBeGreaterThan(beforeBackgroundFragmentCount);
    await browser.waitUntil(
      async () => {
        const restored = await getV4TimelineScrollState();
        const distanceToBottom = Math.max(
          0,
          restored.scrollHeight - restored.clientHeight - restored.scrollTop,
        );
        return restored.following === "true" && distanceToBottom <= 48;
      },
      {
        timeout: 15000,
        timeoutMsg: "吸底 session 切回后没有定位到当前最新底部",
      },
    );
    await waitForV4TimelineContaining("V4_SCROLL_TURN2_DONE", 60000);
    await waitForV4Pane((s) => !s.canStop, "turn2 没有回到空闲态", 45000);
    const final = await getV4TimelineScrollState();
    expect(final.following).toBe("true");
    expect(final.hasBackToBottom).toBe(false);
  });
});
