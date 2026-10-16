// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHighspeedComposerEntrance } from "@/highspeed/useHighspeedComposerEntrance.js";

type EntranceProps = {
  cardId: string | null;
  activationCardId: string | null;
};

function renderEntrance(initialProps: EntranceProps) {
  const onActivationApplied = vi.fn();
  const hook = renderHook(
    (props: EntranceProps) => useHighspeedComposerEntrance({ ...props, onActivationApplied }),
    { initialProps },
  );
  return { ...hook, onActivationApplied };
}

describe("useHighspeedComposerEntrance", () => {
  it("draw 新命中播放一次激活，锁定后立即消费请求，请求清空后仍保持本次激活", () => {
    const { result, rerender, onActivationApplied } = renderEntrance({
      cardId: null,
      activationCardId: null,
    });

    rerender({ cardId: "card-1", activationCardId: "card-1" });
    expect(result.current).toBe("activation");
    expect(onActivationApplied).toHaveBeenCalledTimes(1);
    expect(onActivationApplied).toHaveBeenCalledWith("card-1");

    // 宿主消费后清空请求：同一张卡的这次入场不能因此被改判为 restore，否则动效会中途跳到终态。
    rerender({ cardId: "card-1", activationCardId: null });
    expect(result.current).toBe("activation");
    expect(onActivationApplied).toHaveBeenCalledTimes(1);
  });

  it("没有激活请求时呈现的卡（切回 Task、快照恢复）直接按 restore 入场", () => {
    const { result, rerender, onActivationApplied } = renderEntrance({
      cardId: null,
      activationCardId: null,
    });

    rerender({ cardId: "card-1", activationCardId: null });

    expect(result.current).toBe("restore");
    expect(onActivationApplied).not.toHaveBeenCalled();
  });

  it("激活过的卡切走再切回时不重播", () => {
    const { result, rerender } = renderEntrance({ cardId: null, activationCardId: null });
    rerender({ cardId: "card-1", activationCardId: "card-1" });
    rerender({ cardId: "card-1", activationCardId: null });

    rerender({ cardId: null, activationCardId: null });
    rerender({ cardId: "card-1", activationCardId: null });

    expect(result.current).toBe("restore");
  });

  it("组件重挂载（如退出分享模式）时同一张卡按 restore 入场", () => {
    const { result, onActivationApplied } = renderEntrance({
      cardId: "card-1",
      activationCardId: null,
    });

    expect(result.current).toBe("restore");
    expect(onActivationApplied).not.toHaveBeenCalled();
  });

  it("激活请求与当前卡不一致时不播放也不消费", () => {
    const { result, onActivationApplied } = renderEntrance({
      cardId: "card-2",
      activationCardId: "card-1",
    });

    expect(result.current).toBe("restore");
    expect(onActivationApplied).not.toHaveBeenCalled();
  });

  it("挂载时已有匹配的待消费请求（draw 命中时 composer 未挂载）仍播放一次", () => {
    const { result, onActivationApplied } = renderEntrance({
      cardId: "card-1",
      activationCardId: "card-1",
    });

    expect(result.current).toBe("activation");
    expect(onActivationApplied).toHaveBeenCalledTimes(1);
    expect(onActivationApplied).toHaveBeenCalledWith("card-1");
  });
});
