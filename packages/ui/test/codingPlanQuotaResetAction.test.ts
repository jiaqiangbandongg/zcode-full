// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingPlanQuotaResetAction } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

function installAnimationFrameController() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    callbacks.set(frameId, callback);
    return frameId;
  });
  const cancelAnimationFrame = vi.fn((frameId: number) => {
    callbacks.delete(frameId);
  });
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

  return {
    cancelAnimationFrame,
    flush() {
      const pendingCallbacks = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pendingCallbacks) {
        callback(performance.now());
      }
    },
  };
}

describe("CodingPlanQuotaResetAction", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("重置按钮复用等待请求的确认色", () => {
    render(
      createElement(CodingPlanQuotaResetAction, {
        ariaLabel: "重置 5 小时额度",
        completedAt: null,
        completedLabel: "已重置",
        processing: false,
        processingLabel: "正在重置",
        resetLabel: "重置",
        successLabel: "重置成功",
        onReset: vi.fn(async () => {}),
      }),
    );

    const button = screen.getByRole("button", { name: "重置 5 小时额度" });
    expect(button.className).toContain("bg-interaction-confirmation-surface");
    expect(button.className).toContain("text-interaction-confirmation-foreground");
  });

  it("页面重置入口只打开统一弹窗，不直接核销", () => {
    const onOpenDialog = vi.fn();
    render(
      createElement(CodingPlanQuotaResetAction, {
        ariaLabel: "重置 5 小时额度",
        completedAt: null,
        completedLabel: "已重置",
        processing: false,
        processingLabel: "正在重置",
        resetLabel: "重置",
        successLabel: "重置成功",
        onOpenDialog,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "重置 5 小时额度" }));
    expect(onOpenDialog).toHaveBeenCalledTimes(1);
  });

  it("服务端重置成功后展示短时成功勾选并撒花，再进入已重置状态", async () => {
    vi.useFakeTimers();
    let resolveReset!: () => void;
    const onReset = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReset = resolve;
        }),
    );
    const celebrate = vi.fn();

    const view = render(
      createElement(CodingPlanQuotaResetAction, {
        ariaLabel: "重置 5 小时额度",
        completedAt: null,
        completedLabel: "已重置",
        processing: false,
        processingLabel: "正在重置",
        resetLabel: "重置",
        successLabel: "重置成功",
        onReset,
        onCelebrate: celebrate,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "重置 5 小时额度" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(celebrate).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "正在重置" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => resolveReset());
    view.rerender(
      createElement(CodingPlanQuotaResetAction, {
        ariaLabel: "重置 5 小时额度",
        completedAt: new Date("2026-08-07T19:08:01+08:00").getTime(),
        completedLabel: "已重置",
        processing: false,
        processingLabel: "正在重置",
        resetLabel: "重置",
        successLabel: "重置成功",
        onReset,
        onCelebrate: celebrate,
      }),
    );

    expect(celebrate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "重置成功" })).toBeTruthy();
    expect(screen.queryByText("已重置")).toBeNull();

    act(() => vi.advanceTimersByTime(599));
    expect(screen.getByRole("button", { name: "重置成功" })).toBeTruthy();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("已重置")).toBeTruthy();
  });

  it("请求失败后恢复可点击，不显示成功态也不撒花", async () => {
    const onReset = vi.fn(async () => {
      throw new Error("reset failed");
    });
    const celebrate = vi.fn();

    render(
      createElement(CodingPlanQuotaResetAction, {
        ariaLabel: "重置 5 小时额度",
        completedAt: null,
        completedLabel: "已重置",
        processing: false,
        processingLabel: "正在重置",
        resetLabel: "重置",
        successLabel: "重置成功",
        onReset,
        onCelebrate: celebrate,
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重置 5 小时额度" }));
    });

    expect(
      (screen.getByRole("button", { name: "重置 5 小时额度" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(celebrate).not.toHaveBeenCalled();
  });

  it("已完成状态不会再次提供消费按钮", () => {
    render(
      createElement(CodingPlanQuotaResetAction, {
        ariaLabel: "重置 5 小时额度",
        completedAt: new Date("2026-08-07T19:08:00+08:00").getTime(),
        completedLabel: "已重置",
        processing: false,
        processingLabel: "正在重置",
        resetLabel: "重置",
        successLabel: "重置成功",
        onReset: vi.fn(async () => undefined),
      }),
    );

    expect(screen.queryByRole("button", { name: "重置 5 小时额度" })).toBeNull();
    expect(screen.getByText("已重置")).toBeTruthy();
    // 回归:已重置文案必须与「重置」按钮的 xs 尺寸(h-5)等高。曾经的 min-h-6 会把
    // 所在额度条的标签行撑高,导致同排没有动作的额度条数值与进度条错位。
    expect(screen.getByText("已重置").className).toContain("min-h-5");
    expect(screen.getByText("已重置").className).not.toContain("min-h-6");
  });

  it("自动/运营完成收到补播信号时，等浮层锚点挂载一帧后补播一次撒花且不重播", () => {
    const animationFrame = installAnimationFrameController();
    const completedAt = new Date("2026-08-07T19:08:00+08:00").getTime();
    const celebrate = vi.fn();
    const onAutoCelebrated = vi.fn();
    const props = {
      ariaLabel: "重置 5 小时额度",
      autoCelebrateCompletedAt: completedAt,
      completedAt,
      completedLabel: "已重置",
      processing: false,
      processingLabel: "正在重置",
      resetLabel: "重置",
      successLabel: "重置成功",
      onAutoCelebrated,
      onReset: vi.fn(async () => undefined),
      onCelebrate: celebrate,
    };

    const view = render(createElement(CodingPlanQuotaResetAction, props));

    // 回归：浮层刚打开的提交阶段不能提前消费 arm，否则撒花会在面板可见前结束。
    expect(celebrate).not.toHaveBeenCalled();
    expect(onAutoCelebrated).not.toHaveBeenCalled();

    act(() => animationFrame.flush());
    expect(celebrate).toHaveBeenCalledTimes(1);
    expect(celebrate.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement);
    expect(onAutoCelebrated).toHaveBeenCalledTimes(1);
    expect(onAutoCelebrated).toHaveBeenCalledWith(completedAt);

    // 同一 used_at 重复渲染不重播。
    view.rerender(createElement(CodingPlanQuotaResetAction, props));
    expect(celebrate).toHaveBeenCalledTimes(1);
  });

  it("已重置文案带时间 Tooltip 时也必须等锚点挂载后补播撒花", () => {
    const animationFrame = installAnimationFrameController();
    const completedAt = new Date("2026-08-17T12:00:00+08:00").getTime();
    const celebrate = vi.fn();
    const onAutoCelebrated = vi.fn();

    render(
      createElement(
        TooltipProvider,
        null,
        createElement(CodingPlanQuotaResetAction, {
          ariaLabel: "重置 5 小时额度",
          autoCelebrateCompletedAt: completedAt,
          completedAt,
          completedLabel: "已重置",
          completedTooltipLabel: "重置时间 12:00",
          processing: false,
          processingLabel: "正在重置",
          resetLabel: "重置",
          successLabel: "重置成功",
          onAutoCelebrated,
          onReset: vi.fn(async () => undefined),
          onCelebrate: celebrate,
        }),
      ),
    );

    expect(celebrate).not.toHaveBeenCalled();
    expect(onAutoCelebrated).not.toHaveBeenCalled();

    act(() => animationFrame.flush());
    expect(celebrate).toHaveBeenCalledTimes(1);
    expect(celebrate.mock.calls[0]?.[0]).toBe(screen.getByText("已重置"));
    expect(onAutoCelebrated).toHaveBeenCalledWith(completedAt);
  });

  it("浮层在补播帧前关闭时不消费自动撒花机会", () => {
    const animationFrame = installAnimationFrameController();
    const completedAt = new Date("2026-08-17T12:00:00+08:00").getTime();
    const celebrate = vi.fn();
    const onAutoCelebrated = vi.fn();

    const view = render(
      createElement(CodingPlanQuotaResetAction, {
        ariaLabel: "重置 5 小时额度",
        autoCelebrateCompletedAt: completedAt,
        completedAt,
        completedLabel: "已重置",
        processing: false,
        processingLabel: "正在重置",
        resetLabel: "重置",
        successLabel: "重置成功",
        onAutoCelebrated,
        onReset: vi.fn(async () => undefined),
        onCelebrate: celebrate,
      }),
    );

    view.unmount();
    act(() => animationFrame.flush());

    expect(animationFrame.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(celebrate).not.toHaveBeenCalled();
    expect(onAutoCelebrated).not.toHaveBeenCalled();
  });

  it("补播信号与当前 completedAt 不一致或未 arm 时不补播撒花", () => {
    const celebrate = vi.fn();
    const onAutoCelebrated = vi.fn();

    render(
      createElement(CodingPlanQuotaResetAction, {
        ariaLabel: "重置 5 小时额度",
        autoCelebrateCompletedAt: 111,
        completedAt: 222,
        completedLabel: "已重置",
        processing: false,
        processingLabel: "正在重置",
        resetLabel: "重置",
        successLabel: "重置成功",
        onAutoCelebrated,
        onReset: vi.fn(async () => undefined),
        onCelebrate: celebrate,
      }),
    );

    expect(celebrate).not.toHaveBeenCalled();
    expect(onAutoCelebrated).not.toHaveBeenCalled();
  });
});
