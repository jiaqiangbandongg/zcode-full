// @vitest-environment jsdom

// 草稿的笔（docs/dynamic-workflow/presentation.md「The draft and the pen」）：一次一站、每字 24 ms、
// 站间停 120 ms；笔没到的站不揭示；名字中途变长接着写；追上流即 idle。
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PEN_GAP_MS,
  PEN_MS,
  useTypewriter,
} from "@/components/workflow-timeline/use-typewriter.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// 笔每写一字都是 setState → effect 再排下一枚定时器；一次 advance 只能走一步，所以按步长逐段推进。
function tick(ms: number) {
  let left = ms;
  do {
    const step = Math.min(PEN_MS, left);
    act(() => {
      vi.advanceTimersByTime(step);
    });
    left -= step;
  } while (left > 0);
}

describe("useTypewriter", () => {
  it("第一站立即揭示、逐字写出；写完才停一拍揭示下一站", () => {
    const view = renderHook(({ names }: { names: string[] | undefined }) => useTypewriter(names), {
      initialProps: { names: ["plan", "verify"] as string[] | undefined },
    });
    expect(view.result.current).toMatchObject({ idle: false, shown: [0], visible: 1 });

    tick(PEN_MS * 2);
    expect(view.result.current.shown).toEqual([2]);
    tick(PEN_MS * 2);
    expect(view.result.current).toMatchObject({ idle: false, shown: [4], visible: 1 });

    // 写完 plan：停 120 ms 才揭示 verify（期间第二站仍不在轨道上）。
    tick(PEN_GAP_MS - 1);
    expect(view.result.current.visible).toBe(1);
    tick(1);
    expect(view.result.current).toMatchObject({ shown: [4, 0], visible: 2 });

    tick(PEN_MS * 6);
    expect(view.result.current).toMatchObject({ idle: true, shown: [4, 6], visible: 2 });
  });

  it("名字中途变长（未闭合的标记又来了字）笔接着写；换成新数组但内容不变不会打断笔", () => {
    const view = renderHook(({ names }: { names: string[] }) => useTypewriter(names), {
      initialProps: { names: ["ver"] },
    });
    tick(PEN_MS * 3);
    expect(view.result.current).toMatchObject({ idle: true, shown: [3] });

    view.rerender({ names: ["verify"] });
    expect(view.result.current.idle).toBe(false);
    tick(PEN_MS * 3);
    expect(view.result.current).toMatchObject({ idle: true, shown: [6] });

    // 脚本每来一块都换一个数组：内容不变，笔的位置不变、不重置。
    view.rerender({ names: ["verify"] });
    expect(view.result.current).toMatchObject({ idle: true, shown: [6], visible: 1 });
  });

  it("名字在前缀上变了（流式下的稳健性）退回公共前缀；不是草稿时静默", () => {
    const view = renderHook(({ names }: { names: string[] | undefined }) => useTypewriter(names), {
      initialProps: { names: ["plan"] as string[] | undefined },
    });
    tick(PEN_MS * 4);
    expect(view.result.current.shown).toEqual([4]);
    view.rerender({ names: ["plot"] });
    tick(0);
    expect(view.result.current.shown[0]).toBe(2);

    view.rerender({ names: undefined });
    expect(view.result.current).toEqual({ idle: false, shown: [], visible: 0 });
  });

  it("两站一起到：第二站等第一站写完；空站名的站也要揭示", () => {
    const view = renderHook(() => useTypewriter(["a", "b"]));
    tick(PEN_MS);
    expect(view.result.current).toMatchObject({ shown: [1], visible: 1 });
    tick(PEN_GAP_MS);
    expect(view.result.current).toMatchObject({ shown: [1, 0], visible: 2 });
  });

  it("空草稿（还没有一站）笔静默：不揭示不存在的站，也不空转；第一站到了才揭示，站数回到 0 笔收回", async () => {
    // 不用 renderHook/act：这条曾是无限循环（揭示第 1 站 → 站数为 0 被裁回 → 再揭示……），act 会把
    // 循环一直冲下去直到 worker 内存耗尽，看不到失败本身。真实计时器 + 裸 createRoot 数渲染次数。
    vi.useRealTimers();
    const globalWithAct = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousAct = globalWithAct.IS_REACT_ACT_ENVIRONMENT;
    globalWithAct.IS_REACT_ACT_ENVIRONMENT = false;
    let renders = 0;
    let last: ReturnType<typeof useTypewriter> | undefined;
    function Probe({ names }: { names: string[] }) {
      renders += 1;
      last = useTypewriter(names);
      return null;
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      root.render(createElement(Probe, { names: [] }));
      await settle();
      expect(renders).toBeLessThanOrEqual(2);
      expect(last).toEqual({ idle: false, shown: [], visible: 0 });

      root.render(createElement(Probe, { names: ["plan"] }));
      await settle();
      expect(last).toMatchObject({ visible: 1 });

      const before = renders;
      root.render(createElement(Probe, { names: [] }));
      await settle();
      expect(renders).toBeLessThanOrEqual(before + 2);
      expect(last).toEqual({ idle: false, shown: [], visible: 0 });
    } finally {
      root.unmount();
      host.remove();
      globalWithAct.IS_REACT_ACT_ENVIRONMENT = previousAct;
    }
  });

  it("prefers-reduced-motion：整站立即写完是渲染时派生的，站名变长不再多一轮 setState", () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes("reduce"),
        media: query,
      }) as MediaQueryList) as typeof window.matchMedia;
    try {
      let renders = 0;
      const view = renderHook(
        ({ names }: { names: string[] }) => {
          renders += 1;
          return useTypewriter(names);
        },
        { initialProps: { names: ["ver"] } },
      );
      // 揭示第一站是唯一一次 setState；名字已经整站写完。
      expect(renders).toBe(2);
      expect(view.result.current).toMatchObject({ idle: true, shown: [3], visible: 1 });

      view.rerender({ names: ["verify"] });
      expect(renders).toBe(3);
      expect(view.result.current).toMatchObject({ idle: true, shown: [6], visible: 1 });

      // 仍一站一站揭示：第二站停一拍才上轨道，上来就是整站。
      view.rerender({ names: ["verify", "publish"] });
      expect(view.result.current).toMatchObject({ idle: false, shown: [6], visible: 1 });
      tick(PEN_GAP_MS);
      expect(view.result.current).toMatchObject({ idle: true, shown: [6, 7], visible: 2 });
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});
