// @vitest-environment jsdom

// 视口钩子（docs/dynamic-workflow/presentation.md「Overflow: the ledge」；修订 2026-09-12「空草稿的笔不空转」）：
// 量到的三个数没变就不换对象——ResizeObserver / 滚动的每一次回调都造新对象曾让时间线白渲染一轮，
// 在 React 嵌套更新计数上多记一笔。
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimelineViewport } from "@/components/workflow-timeline/use-timeline-viewport.js";

type ResizeCallback = () => void;
let resizeCallbacks: ResizeCallback[] = [];
const originalResizeObserver = globalThis.ResizeObserver;

function fakeElement(size: { clientWidth: number; scrollLeft: number; scrollWidth: number }) {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { get: () => size.clientWidth });
  Object.defineProperty(element, "scrollWidth", { get: () => size.scrollWidth });
  Object.defineProperty(element, "scrollLeft", {
    get: () => size.scrollLeft,
    set: (v) => (size.scrollLeft = v),
  });
  return element;
}

beforeEach(() => {
  resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeCallback) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
  vi.useRealTimers();
});

describe("useTimelineViewport", () => {
  it("measures on mount; a resize callback with the same numbers keeps the same viewport object", () => {
    const size = { clientWidth: 400, scrollLeft: 0, scrollWidth: 960 };
    const element = fakeElement(size);
    const view = renderHook(() => useTimelineViewport(element, 960));
    const first = view.result.current;
    expect(first).toEqual({ clientWidth: 400, scrollLeft: 0, scrollWidth: 960, scrolling: false });

    // 同样的数：对象不换（React 据此跳过这轮），消费者的 useMemo 也不会失效。
    act(() => {
      for (const callback of resizeCallbacks) callback();
    });
    expect(view.result.current).toBe(first);

    size.clientWidth = 500;
    act(() => {
      for (const callback of resizeCallbacks) callback();
    });
    expect(view.result.current).not.toBe(first);
    expect(view.result.current.clientWidth).toBe(500);
  });

  it("re-measures when the content key changes without re-rendering if nothing moved", () => {
    const size = { clientWidth: 400, scrollLeft: 0, scrollWidth: 960 };
    const element = fakeElement(size);
    let renders = 0;
    const view = renderHook(
      ({ key }: { key: number }) => {
        renders += 1;
        return useTimelineViewport(element, key);
      },
      { initialProps: { key: 960 } },
    );
    const after = renders;
    const first = view.result.current;
    view.rerender({ key: 1152 });
    // 只有 rerender 自己那一次；量到的数没变，layout effect 不再追加一轮，对象也不换。
    expect(renders).toBe(after + 1);
    expect(view.result.current).toBe(first);
  });
});
