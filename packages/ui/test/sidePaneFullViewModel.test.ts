import { describe, expect, it } from "vitest";
import {
  FLOATING_ANCHORS,
  FLOATING_MARGIN_PX,
  clampFloatingPosition,
  dismissFloatingAnswerBubble,
  parseFloatingAnchor,
  rebaselineFloatingAnswerBubbles,
  reduceFloatingAnswerBubbles,
  resolveFloatingAnswerPreview,
  resolveFloatingExpandedHeight,
  resolveFloatingPosition,
  resolveFloatingTransformOrigin,
  resolveFloatingWidth,
  resolveNearestFloatingAnchor,
} from "@/side-pane-full-view/model.js";

const SLOT = { left: 100, top: 60, width: 1200, height: 800 };
const SIZE = { width: 560, height: 120 };

describe("side pane full view floating geometry", () => {
  it("places every anchor inside the slot with a 16px margin", () => {
    const m = FLOATING_MARGIN_PX;
    expect(resolveFloatingPosition("top-left", SLOT, SIZE)).toEqual({ left: 116, top: 76 });
    expect(resolveFloatingPosition("top-right", SLOT, SIZE)).toEqual({
      left: 100 + 1200 - m - 560,
      top: 76,
    });
    expect(resolveFloatingPosition("left-center", SLOT, SIZE)).toEqual({
      left: 116,
      top: 60 + (800 - 120) / 2,
    });
    expect(resolveFloatingPosition("right-center", SLOT, SIZE)).toEqual({
      left: 100 + 1200 - m - 560,
      top: 60 + (800 - 120) / 2,
    });
    expect(resolveFloatingPosition("bottom-left", SLOT, SIZE)).toEqual({
      left: 116,
      top: 60 + 800 - m - 120,
    });
    expect(resolveFloatingPosition("bottom-center", SLOT, SIZE)).toEqual({
      left: 100 + (1200 - 560) / 2,
      top: 60 + 800 - m - 120,
    });
    expect(resolveFloatingPosition("bottom-right", SLOT, SIZE)).toEqual({
      left: 100 + 1200 - m - 560,
      top: 60 + 800 - m - 120,
    });
  });

  it("grows bottom anchors upward and top anchors downward", () => {
    const tall = { width: 560, height: 500 };
    expect(resolveFloatingPosition("bottom-right", SLOT, tall).top).toBe(60 + 800 - 16 - 500);
    expect(resolveFloatingPosition("top-right", SLOT, tall).top).toBe(76);
  });

  it("keeps an oversized window pinned to the slot origin", () => {
    const huge = { width: 2000, height: 2000 };
    expect(resolveFloatingPosition("bottom-right", SLOT, huge)).toEqual({ left: 100, top: 60 });
  });

  it("snaps to the anchor whose resting position is closest to the dropped window", () => {
    // 窗口中心拖到左上角附近
    expect(resolveNearestFloatingAnchor({ left: 130, top: 90 }, SLOT, SIZE)).toBe("top-left");
    // 拖到底部中间
    expect(resolveNearestFloatingAnchor({ left: 420, top: 640 }, SLOT, SIZE)).toBe("bottom-center");
    // 拖到右侧中部
    expect(resolveNearestFloatingAnchor({ left: 700, top: 400 }, SLOT, SIZE)).toBe("right-center");
  });

  it("clamps a dragged window so it never leaves the slot", () => {
    expect(clampFloatingPosition({ left: -50, top: 2000 }, SLOT, SIZE)).toEqual({
      left: 100,
      top: 60 + 800 - 120,
    });
  });

  it("caps width and expanded height to the slot", () => {
    expect(resolveFloatingWidth(1200)).toBe(560);
    expect(resolveFloatingWidth(400)).toBe(400 - 32);
    expect(resolveFloatingExpandedHeight(1000)).toBe(640);
    expect(resolveFloatingExpandedHeight(500)).toBe(500 - 32);
  });

  it("scales minimize / restore from the corner the bubble sits on", () => {
    expect(resolveFloatingTransformOrigin("bottom-right")).toBe("right bottom");
    expect(resolveFloatingTransformOrigin("top-left")).toBe("left top");
    expect(resolveFloatingTransformOrigin("left-center")).toBe("left center");
    expect(resolveFloatingTransformOrigin("bottom-center")).toBe("center bottom");
  });

  it("accepts only known anchors from persisted preferences", () => {
    for (const anchor of FLOATING_ANCHORS) {
      expect(parseFloatingAnchor(anchor)).toBe(anchor);
    }
    expect(parseFloatingAnchor("top-center")).toBeNull();
    expect(parseFloatingAnchor(null)).toBeNull();
  });
});

// 回答气泡（docs/ui/side-pane-full-view.md）：基线之后出现的已结束回合才弹出，只有 × 或点击才清除。
describe("side pane full view answer bubble", () => {
  const answer = (rowId: number, text = `answer ${rowId}`) => ({ rowId, text });
  const report = (
    ownerKey: string,
    turnKey: string,
    running: boolean,
    latestAnswer: ReturnType<typeof answer> | null,
  ) => ({ ownerKey, latestTurn: { turnKey, running, answer: latestAnswer } });

  it("treats the turn already finished on first sight as seen", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), report("task-a", "t1", false, answer(1)));
    expect(bubbles.get("task-a")).toEqual({ seenTurnKey: "t1", answer: null });
    bubbles = reduceFloatingAnswerBubbles(bubbles, report("task-a", "t1", false, answer(1)));
    expect(bubbles.get("task-a")?.answer ?? null).toBeNull();
  });

  it("pops a turn that finishes without ever being seen running", () => {
    // 回放或很快的回答：同一次渲染里就从 t1 变成已结束的 t2。
    let bubbles = reduceFloatingAnswerBubbles(new Map(), report("task-a", "t1", false, answer(1)));
    bubbles = reduceFloatingAnswerBubbles(bubbles, report("task-a", "t2", false, answer(2)));
    expect(bubbles.get("task-a")).toEqual({ seenTurnKey: "t2", answer: answer(2) });
  });

  it("pops the turn that was running on first sight once it completes", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), report("task-a", "t2", true, null));
    expect(bubbles.get("task-a")).toEqual({ seenTurnKey: null, answer: null });
    bubbles = reduceFloatingAnswerBubbles(bubbles, report("task-a", "t2", false, answer(2)));
    expect(bubbles.get("task-a")?.answer).toEqual(answer(2));
  });

  it("keeps the bubble while the next turn runs and replaces it with the new answer", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), report("task-a", "t1", false, answer(1)));
    bubbles = reduceFloatingAnswerBubbles(bubbles, report("task-a", "t2", false, answer(2)));
    bubbles = reduceFloatingAnswerBubbles(bubbles, report("task-a", "t3", true, null));
    expect(bubbles.get("task-a")?.answer).toEqual(answer(2));
    bubbles = reduceFloatingAnswerBubbles(bubbles, report("task-a", "t3", false, answer(3)));
    expect(bubbles.get("task-a")?.answer).toEqual(answer(3));
  });

  it("keeps owners apart and ignores reports without a turn", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), report("task-a", "t1", false, answer(1)));
    bubbles = reduceFloatingAnswerBubbles(bubbles, report("task-b", "t9", false, answer(9)));
    expect(bubbles.get("task-b")?.answer ?? null).toBeNull();
    expect(reduceFloatingAnswerBubbles(bubbles, { ownerKey: "task-a", latestTurn: null })).toBe(
      bubbles,
    );
  });

  it("clears only on dismiss and does not pop answers already seen outside the floating window", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), report("task-a", "t1", false, answer(1)));
    bubbles = reduceFloatingAnswerBubbles(bubbles, report("task-a", "t2", false, answer(2)));
    bubbles = dismissFloatingAnswerBubble(bubbles, "task-a");
    expect(bubbles.get("task-a")?.answer ?? null).toBeNull();

    // 离开浮窗期间 t3 在对话 tab 里结束，回到浮窗重新建立基线，不弹出。
    bubbles = rebaselineFloatingAnswerBubbles(bubbles);
    bubbles = reduceFloatingAnswerBubbles(bubbles, report("task-a", "t3", false, answer(3)));
    expect(bubbles.get("task-a")?.answer ?? null).toBeNull();
  });

  it("previews the answer as plain text", () => {
    expect(
      resolveFloatingAnswerPreview(
        "## 结论\n\n- **已完成** 修改，见 [文档](https://example.com)\n- 运行 `pnpm test`\n\n```ts\nconst a = 1;\n```\n保留 snake_case_name",
      ),
    ).toBe("结论 已完成 修改，见 文档 运行 pnpm test 保留 snake_case_name");
  });
});
