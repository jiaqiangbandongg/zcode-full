// M5④ 虚拟滚动核心：v4 timeline 底部锚定状态机单测（纯函数）。
import { describe, expect, it } from "vitest";
import {
  BOTTOM_ANCHOR_EPSILON_PX,
  LOAD_OLDER_PREFETCH_VIEWPORTS,
  LOAD_OLDER_TRIGGER_PX,
  UNOBSERVED_SCROLL_EPSILON_PX,
  anchorActionAfterContentChange,
  distanceToBottom,
  historyPrefetchTriggerPx,
  initialFollowing,
  isAtBottom,
  nextFollowingAfterScroll,
  prependScrollAdjustment,
  prependVirtualAnchorAdjustment,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  shouldAdjustVirtualizerForItemSizeChange,
  shouldShowBackToBottom,
  shouldTriggerLoadOlder,
  timelineKeyboardScrollIntent,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
} from "@/v4/timelineScrollAnchor.js";

const metrics = (
  scrollTop: number,
  viewportHeight: number,
  contentHeight: number,
) => ({ scrollTop, viewportHeight, contentHeight });

describe("timelineScrollAnchor", () => {
  it("distanceToBottom：正常滚动区间与内容不足一屏（不为负）", () => {
    expect(distanceToBottom(metrics(0, 600, 2000))).toBe(1400);
    expect(distanceToBottom(metrics(1400, 600, 2000))).toBe(0);
    // 内容不足一屏：无可滚动距离
    expect(distanceToBottom(metrics(0, 600, 300))).toBe(0);
  });

  it("isAtBottom：容差内视为在底（亚像素/最后一行 padding）", () => {
    expect(isAtBottom(metrics(1400, 600, 2000))).toBe(true);
    expect(
      isAtBottom(metrics(1400 - BOTTOM_ANCHOR_EPSILON_PX, 600, 2000)),
    ).toBe(true);
    expect(
      isAtBottom(metrics(1400 - BOTTOM_ANCHOR_EPSILON_PX - 1, 600, 2000)),
    ).toBe(false);
    // 内容不足一屏恒为在底
    expect(isAtBottom(metrics(0, 600, 300))).toBe(true);
  });

  it("初始态跟随底部（打开会话定位最新消息）", () => {
    expect(initialFollowing()).toBe(true);
  });

  it("状态机：用户上滚离底 → 解除跟随；滚回底部 → 恢复跟随", () => {
    let following = initialFollowing();
    // 用户上滚到中部
    following = nextFollowingAfterScroll(metrics(500, 600, 2000));
    expect(following).toBe(false);
    // 滚回底部
    following = nextFollowingAfterScroll(metrics(1400, 600, 2000));
    expect(following).toBe(true);
  });

  it("状态机：程序化贴底落点在底部，scroll 事件不误解除跟随", () => {
    // 贴底后 scroll 事件的落点 = 底部 → 跟随保持
    expect(nextFollowingAfterScroll(metrics(1400, 600, 2000))).toBe(true);
  });

  it("只有用户 scroll 改变滚动权，terminal/virtualizer 布局回退保持原状态", () => {
    const layoutMetrics = metrics(900, 600, 2000);
    expect(
      resolveFollowingAfterScroll({
        following: true,
        metrics: layoutMetrics,
        source: "layout",
      }),
    ).toBe(true);
    expect(
      resolveFollowingAfterScroll({
        following: false,
        metrics: metrics(1400, 600, 2000),
        source: "programmatic",
      }),
    ).toBe(false);
    expect(
      resolveFollowingAfterScroll({
        following: true,
        metrics: layoutMetrics,
        source: "user",
      }),
    ).toBe(false);
  });

  it("内容增长动作：跟随中贴底，解除跟随保持阅读位置（流式不拉回）", () => {
    expect(anchorActionAfterContentChange(true)).toBe("stickToBottom");
    expect(anchorActionAfterContentChange(false)).toBe("hold");
  });

  it("宽度 resize 期间吸底也暂停逐批追底，稳定后恢复", () => {
    expect(anchorActionAfterContentChange(true, true)).toBe("hold");
    expect(anchorActionAfterContentChange(true, false)).toBe("stickToBottom");
  });

  it("解除跟随期间内容持续增长：多轮 delta 均不产生贴底动作", () => {
    let following = nextFollowingAfterScroll(metrics(200, 600, 2000));
    expect(following).toBe(false);
    // 流式增长把 contentHeight 不断撑高；用户未动，scrollTop 不变，不触发 scroll 事件，
    // 状态保持 detached，每次内容变化的动作都是 hold。
    for (const grownHeight of [2400, 3000, 5000]) {
      expect(anchorActionAfterContentChange(following)).toBe("hold");
      // 若期间用户轻微滚动但仍离底，跟随不恢复
      following = nextFollowingAfterScroll(metrics(210, 600, grownHeight));
      expect(following).toBe(false);
    }
  });

  it("回到底部按钮：仅解除跟随且有内容时展示", () => {
    expect(shouldShowBackToBottom(false, 10)).toBe(true);
    expect(shouldShowBackToBottom(true, 10)).toBe(false);
    expect(shouldShowBackToBottom(false, 0)).toBe(false);
  });

  it("多 pane 独立性（纯函数无共享状态）：两组指标互不影响", () => {
    const paneA = nextFollowingAfterScroll(metrics(0, 600, 2000));
    const paneB = nextFollowingAfterScroll(metrics(1400, 600, 2000));
    expect(paneA).toBe(false);
    expect(paneB).toBe(true);
  });

  it("宽度 resize 期间禁止逐行补偿，稳定后只补偿视口上方行", () => {
    expect(
      shouldAdjustVirtualizerForItemSizeChange({
        following: false,
        suppressAdjustment: false,
        contentWidthChanging: true,
        itemEnd: 100,
        scrollTop: 300,
      }),
    ).toBe(false);
    expect(
      shouldAdjustVirtualizerForItemSizeChange({
        following: false,
        suppressAdjustment: false,
        contentWidthChanging: false,
        itemEnd: 100,
        scrollTop: 300,
      }),
    ).toBe(true);
    expect(
      shouldAdjustVirtualizerForItemSizeChange({
        following: false,
        suppressAdjustment: false,
        contentWidthChanging: false,
        itemEnd: 400,
        scrollTop: 300,
      }),
    ).toBe(false);
  });
});

// ── bugfix：贴底前对账「未观察滚动」（scroll 事件尚未派发的竞态窗口） ──
describe("reconcileFollowingForContentAnchor", () => {
  it("程序化 scrollToTop 后、scroll 事件未派发时的测量/resize commit：不夺滚动权", () => {
    // 用户/测试把 scrollTop 拽到 0（上次账目在底部 1400），scroll 事件还没派发，
    // 此时 ResizeObserver 测高修正触发内容变化 commit——必须立即解除跟随（hold），
    // 不得拿过期 following=true 贴底吞掉这次滚动。
    const following = reconcileFollowingForContentAnchor({
      following: true,
      metrics: metrics(0, 600, 2000),
      lastObservedScrollTop: 1400,
    });
    expect(following).toBe(false);
    expect(anchorActionAfterContentChange(following)).toBe("hold");
  });

  it("scrollToTop 解除跟随后，后续 resize/测量 commit 不复活跟随", () => {
    // 已解除（following=false，账目 scrollTop=0），composer 尺寸变化/测高修正
    // 连续触发多个内容变化 commit：scrollTop 未动，跟随保持解除。
    let following = false;
    for (const contentHeight of [2000, 2600, 3200]) {
      following = reconcileFollowingForContentAnchor({
        following,
        metrics: metrics(0, 600, contentHeight),
        lastObservedScrollTop: 0,
      });
      expect(following).toBe(false);
    }
  });

  it("terminal 折叠造成 scrollTop 回退但没有用户输入：保持 following 并继续贴底", () => {
    const following = reconcileFollowingForContentAnchor({
      following: true,
      metrics: metrics(720, 600, 1800),
      lastObservedScrollTop: 1400,
      userScrollIntent: "none",
    });
    expect(following).toBe(true);
    expect(anchorActionAfterContentChange(following)).toBe("stickToBottom");
  });

  it("用户向上滚动与 terminal commit 同帧：用户意图优先于临时在底几何", () => {
    expect(
      reconcileFollowingForContentAnchor({
        following: true,
        metrics: metrics(600, 600, 1200),
        lastObservedScrollTop: 1400,
        userScrollIntent: "awayFromBottom",
      }),
    ).toBe(false);
  });

  it("跟随中流式增长（scrollTop 未动，仅内容撑高）：照常贴底", () => {
    expect(
      reconcileFollowingForContentAnchor({
        following: true,
        metrics: metrics(1400, 600, 2400),
        lastObservedScrollTop: 1400,
      }),
    ).toBe(true);
  });

  it("视口增高把 scrollTop 钳回底部（回退但在底）：跟随保持，不误判为上滚", () => {
    // composer 收起 → timeline 变高 → 浏览器把 scrollTop 从 1400 钳到 1200，
    // 落点仍在底部：规则 1 先兜住。
    expect(
      reconcileFollowingForContentAnchor({
        following: true,
        metrics: metrics(1200, 800, 2000),
        lastObservedScrollTop: 1400,
      }),
    ).toBe(true);
  });

  it("亚像素回退（≤ 容差）不解除跟随", () => {
    expect(
      reconcileFollowingForContentAnchor({
        following: true,
        metrics: metrics(1300 - UNOBSERVED_SCROLL_EPSILON_PX, 600, 2400),
        lastObservedScrollTop: 1300,
      }),
    ).toBe(true);
  });

  it("未观察的下滚落点在底：恢复跟随（与 scroll 事件语义一致）", () => {
    expect(
      reconcileFollowingForContentAnchor({
        following: false,
        metrics: metrics(1400, 600, 2000),
        lastObservedScrollTop: 500,
      }),
    ).toBe(true);
  });

  it("解除跟随的中部阅读位（scrollTop 未动）：内容变化 commit 保持解除", () => {
    expect(
      reconcileFollowingForContentAnchor({
        following: false,
        metrics: metrics(500, 600, 2400),
        lastObservedScrollTop: 500,
      }),
    ).toBe(false);
  });
});

describe("timeline user scroll intent", () => {
  it("区分 wheel 向上离底与向下回底", () => {
    expect(timelineWheelScrollIntent(-20)).toBe("awayFromBottom");
    expect(timelineWheelScrollIntent(20)).toBe("towardBottom");
    expect(timelineWheelScrollIntent(0)).toBe("none");
  });

  it("touch 手指下移表示阅读更早内容", () => {
    expect(timelineTouchScrollIntent(300, 340)).toBe("awayFromBottom");
    expect(timelineTouchScrollIntent(340, 300)).toBe("towardBottom");
  });

  it("键盘导航区分方向，并忽略输入控件里的光标按键", () => {
    expect(
      timelineKeyboardScrollIntent({
        key: "PageUp",
        shiftKey: false,
        editableTarget: false,
      }),
    ).toBe("awayFromBottom");
    expect(
      timelineKeyboardScrollIntent({
        key: "End",
        shiftKey: false,
        editableTarget: false,
      }),
    ).toBe("towardBottom");
    expect(
      timelineKeyboardScrollIntent({
        key: "ArrowUp",
        shiftKey: false,
        editableTarget: true,
      }),
    ).toBe("none");
  });

  it("滚动条方向未知时只由真实 scroll 落点裁决", () => {
    expect(
      reconcileFollowingForContentAnchor({
        following: true,
        metrics: metrics(800, 600, 2000),
        lastObservedScrollTop: 1400,
        userScrollIntent: "unknown",
      }),
    ).toBe(false);
  });
});

// ── M5④ R-06：loadOlder prepend 锚定（虚拟滚动前插不跳） ──
describe("prependScrollAdjustment", () => {
  it("优先按同一可见 turn 的稳定 virtual measurement 校正 prepend", () => {
    expect(
      prependVirtualAnchorAdjustment(
        { key: "turn-21", offsetTop: -88, start: 12 },
        { key: "turn-21", offsetTop: -88, start: 227 },
        100,
      ),
    ).toBe(215);
    expect(
      prependVirtualAnchorAdjustment(
        { key: "turn-21", offsetTop: -88, start: 12 },
        { key: "turn-other", offsetTop: -88, start: 227 },
        100,
      ),
    ).toBeNull();
  });

  it("触发补页后 scrollTop 又被布局改写时仍恢复触发瞬间的视口偏移", () => {
    // 锚点触发时 start=120、scrollTop=200（视口偏移 -80）；prepend 后 start=420。
    // 若恢复/virtualizer 已把实时 scrollTop 改成 660，应回调 -160 到 500，不能再
    // 机械叠加 start delta=300 到 960，否则同一锚点会被推到视口上方 460px。
    expect(
      prependVirtualAnchorAdjustment(
        { key: "turn-21", offsetTop: -80, start: 120 },
        { key: "turn-21", offsetTop: 0, start: 420 },
        660,
      ),
    ).toBe(-160);
  });

  it("真前插（首行 rowId 变小且总高度增长）→ 平移量 = 高度差", () => {
    expect(
      prependScrollAdjustment({
        prevFirstRowId: 61,
        nextFirstRowId: 1,
        prevTotalSize: 6000,
        nextTotalSize: 12000,
      }),
    ).toBe(6000);
  });

  it("尾部追加/流式增长（首行不变）→ 不平移", () => {
    expect(
      prependScrollAdjustment({
        prevFirstRowId: 1,
        nextFirstRowId: 1,
        prevTotalSize: 6000,
        nextTotalSize: 6400,
      }),
    ).toBeNull();
  });

  it("首帧（prev 无行）与清空（next 无行）→ 不平移", () => {
    expect(
      prependScrollAdjustment({
        prevFirstRowId: null,
        nextFirstRowId: 1,
        prevTotalSize: 0,
        nextTotalSize: 6000,
      }),
    ).toBeNull();
    expect(
      prependScrollAdjustment({
        prevFirstRowId: 1,
        nextFirstRowId: null,
        prevTotalSize: 6000,
        nextTotalSize: 0,
      }),
    ).toBeNull();
  });

  it("row.removed 截断（首行变大）→ 不平移（交给底部锚定）", () => {
    expect(
      prependScrollAdjustment({
        prevFirstRowId: 1,
        nextFirstRowId: 10,
        prevTotalSize: 6000,
        nextTotalSize: 3000,
      }),
    ).toBeNull();
  });

  it("异常：首行变小但总高度未增长（同帧收缩测量）→ 不产生负平移", () => {
    expect(
      prependScrollAdjustment({
        prevFirstRowId: 61,
        nextFirstRowId: 1,
        prevTotalSize: 6000,
        nextTotalSize: 5000,
      }),
    ).toBeNull();
  });
});

describe("shouldTriggerLoadOlder", () => {
  it("HLP02：提前两个视口进入预取区，未知视口回落到顶边阈值", () => {
    const triggerPx = historyPrefetchTriggerPx(700);
    expect(triggerPx).toBe(700 * LOAD_OLDER_PREFETCH_VIEWPORTS);
    expect(historyPrefetchTriggerPx(0)).toBe(LOAD_OLDER_TRIGGER_PX);
    expect(historyPrefetchTriggerPx(Number.NaN)).toBe(LOAD_OLDER_TRIGGER_PX);
    expect(
      shouldTriggerLoadOlder({
        scrollTop: triggerPx - 1,
        canLoadOlder: true,
        loadingOlder: false,
        triggerPx,
      }),
    ).toBe(true);
    expect(
      shouldTriggerLoadOlder({
        scrollTop: triggerPx + 1,
        canLoadOlder: true,
        loadingOlder: false,
        triggerPx,
      }),
    ).toBe(false);
  });

  it("到顶 + 可拉 + 非在途 → 触发", () => {
    expect(
      shouldTriggerLoadOlder({
        scrollTop: 0,
        canLoadOlder: true,
        loadingOlder: false,
      }),
    ).toBe(true);
    expect(
      shouldTriggerLoadOlder({
        scrollTop: LOAD_OLDER_TRIGGER_PX,
        canLoadOlder: true,
        loadingOlder: false,
      }),
    ).toBe(true);
  });

  it("离顶 / 已到全序首行 / 在途中 → 不触发", () => {
    expect(
      shouldTriggerLoadOlder({
        scrollTop: LOAD_OLDER_TRIGGER_PX + 1,
        canLoadOlder: true,
        loadingOlder: false,
      }),
    ).toBe(false);
    expect(
      shouldTriggerLoadOlder({
        scrollTop: 0,
        canLoadOlder: false,
        loadingOlder: false,
      }),
    ).toBe(false);
    expect(
      shouldTriggerLoadOlder({
        scrollTop: 0,
        canLoadOlder: true,
        loadingOlder: true,
      }),
    ).toBe(false);
  });
});
