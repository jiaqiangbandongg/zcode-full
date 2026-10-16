// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FACE_COLORS,
  WorkflowAgentFace,
  agentColor,
  avatarColor,
} from "@/components/workflow-timeline/WorkflowAgentFace.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function renderFace(status: "pending" | "running" | "done" | "failed" = "running") {
  return render(createElement(WorkflowAgentFace, { avatarIndex: 0, name: "Ada", status }));
}
const face = (view: ReturnType<typeof renderFace>) => view.container.querySelector("svg")!;
function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}
function clock() {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.2);
}
describe("WorkflowAgentFace", () => {
  it("九个编号取九色环、互不相同，第十个循环；无编号退回名字散列", () => {
    const hues = Array.from({ length: 9 }, (_, i) => agentColor(i, "x"));
    expect(new Set(hues).size).toBe(9);
    expect(hues).toEqual([
      "#54B9A6",
      "#F19D38",
      "#6464EF",
      "#885CF5",
      "#3C82F6",
      "#ED712E",
      "#EB4699",
      "#5BC67A",
      "#EA4045",
    ]);
    expect(agentColor(9, "x")).toBe(FACE_COLORS[0]);
    expect(agentColor(undefined, "Ada")).toBe(avatarColor("Ada"));
  });

  it("基础表情遵循执行状态，采用 20 格 r7 和 4×6 白色 pill 几何", () => {
    for (const [status, expression] of [
      ["pending", "dots"],
      ["running", "pill"],
      ["done", "happy"],
      ["failed", "sad"],
    ] as const) {
      const v = renderFace(status);
      expect(face(v).dataset.expression).toBe(expression);
      expect(face(v).getAttribute("viewBox")).toBe("0 0 20 20");
      expect(face(v).querySelector(".wf-face-body")!.getAttribute("rx")).toBe("7");
      expect(
        Array.from(face(v).querySelectorAll('[data-eye-expression="pill"] rect'), (e) =>
          ["x", "y", "width", "height", "rx"].map((k) => e.getAttribute(k)),
        ),
      ).toEqual([
        ["7", "6", "4", "6", "2"],
        ["13", "6", "4", "6", "2"],
      ]);
      v.unmount();
    }
  });
  it("疑惑右眼是底部对齐的圆形，不再是扁胶囊", () => {
    const v = renderFace();
    const right = face(v).querySelectorAll('[data-eye-expression="confused"] rect')[1]!;
    expect(["x", "y", "width", "height", "rx"].map((k) => right.getAttribute(k))).toEqual([
      "13",
      "8",
      "4",
      "4",
      "2",
    ]);
  });
  it("双眨和平移交替；特殊表情不连续重复且会恢复基础表情", () => {
    clock();
    const v = renderFace();
    const node = face(v);
    const actions = new Set<string>();
    const expressions: string[] = [];
    let last = "pill";
    for (let i = 0; i < 1500; i++) {
      advance(100);
      actions.add(node.dataset.motion!);
      const e = node.dataset.expression!;
      if (e !== last && e !== "pill") expressions.push(e);
      last = e;
    }
    expect(actions.has("blink")).toBe(true);
    expect(actions.has("glance")).toBe(true);
    expect(expressions.length).toBeGreaterThan(1);
    expect(expressions.every((e) => ["focused", "confused"].includes(e))).toBe(true);
    expect(expressions.every((e, i) => i === 0 || e !== expressions[i - 1])).toBe(true);
  });
  it("成功只调度眼睛上下抖，状态切换与卸载取消旧动画", () => {
    clock();
    const v = renderFace("done");
    advance(1600);
    expect(face(v).dataset.motion).toBe("hop");
    expect(face(v).style.getPropertyValue("--wf-face-hops")).toBe("2");
    v.rerender(createElement(WorkflowAgentFace, { avatarIndex: 0, name: "Ada", status: "failed" }));
    expect(face(v).dataset.expression).toBe("sad");
    expect(face(v).dataset.motion).toBe("idle");
    for (let i = 0; i < 100; i++) {
      advance(100);
      expect(face(v).dataset.motion).not.toBe("hop");
    }
    v.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("随机初始延迟让头像错开", () => {
    clock();
    const a = renderFace();
    vi.mocked(Math.random).mockReturnValue(0.8);
    const b = renderFace();
    advance(1600);
    expect(face(a).dataset.motion).not.toBe(face(b).dataset.motion);
  });
  it("隐藏与动态 reduced-motion 立即归静，恢复后重新调度", () => {
    clock();
    let reduced = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return reduced;
      },
      addEventListener: (_e: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_e: string, fn: () => void) => listeners.delete(fn),
    }));
    const v = renderFace("done");
    advance(1600);
    reduced = true;
    act(() => listeners.forEach((fn) => fn()));
    expect(vi.getTimerCount()).toBe(0);
    expect(face(v).dataset.expression).toBe("happy");
    expect(face(v).dataset.motion).toBe("idle");
    reduced = false;
    act(() => listeners.forEach((fn) => fn()));
    expect(vi.getTimerCount()).toBe(1);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
    v.unmount();
    expect(listeners.size).toBe(0);
  });
  it("等待、失败与成功只出现各自允许的偶发表情", () => {
    clock();
    for (const [status, allowed] of [
      ["pending", ["dots"]],
      ["failed", ["sad", "focused"]],
      ["done", ["happy", "pill"]],
    ] as const) {
      const v = renderFace(status);
      const seen = new Set<string>();
      for (let i = 0; i < 1600; i++) {
        advance(100);
        seen.add(face(v).dataset.expression!);
      }
      expect([...seen].sort()).toEqual([...allowed].sort());
      v.unmount();
    }
  });
  it("离开视口停止调度，重新进入恢复；卸载断开观察器", () => {
    clock();
    let notify: (entries: { isIntersecting: boolean }[]) => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof notify) {
          notify = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const v = renderFace();
    act(() => notify([{ isIntersecting: false }]));
    expect(vi.getTimerCount()).toBe(0);
    expect(face(v).dataset.motion).toBe("idle");
    act(() => notify([{ isIntersecting: true }]));
    expect(vi.getTimerCount()).toBe(1);
    v.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("右侧眨两下后整组移到左侧，再眨三下移回右侧", () => {
    clock();
    const v = renderFace();
    const node = face(v);
    advance(1520);
    expect(node.dataset.motion).toBe("blink");
    expect(node.style.getPropertyValue("--wf-face-blinks")).toBe("2");
    expect(node.style.getPropertyValue("--wf-face-x")).toBe("0px");
    advance(500);
    expect(node.dataset.motion).toBe("glance");
    expect(node.style.getPropertyValue("--wf-face-x")).toBe("-4px");
    advance(360);
    vi.mocked(Math.random).mockReturnValue(0.8);
    advance(1900);
    expect(node.dataset.motion).toBe("blink");
    expect(node.style.getPropertyValue("--wf-face-blinks")).toBe("3");
    expect(node.style.getPropertyValue("--wf-face-x")).toBe("-4px");
    advance(800);
    expect(node.style.getPropertyValue("--wf-face-x")).toBe("0px");
  });
  it("等待中三个白点轻浮，切回运行才开始眨眼", () => {
    clock();
    const v = renderFace("pending");
    expect(
      Array.from(face(v).querySelectorAll('[data-eye-expression="dots"] circle'), (n) =>
        ["cx", "cy", "r"].map((k) => n.getAttribute(k)),
      ),
    ).toEqual([
      ["5", "10", "1.5"],
      ["10", "10", "1.5"],
      ["15", "10", "1.5"],
    ]);
    expect(vi.getTimerCount()).toBe(1);
    advance(1600);
    expect(face(v).dataset.motion).toBe("dots-wave");
    advance(1000);
    expect(face(v).dataset.motion).toBe("idle");
    advance(27400);
    expect(face(v).dataset.expression).toBe("dots");
    v.rerender(
      createElement(WorkflowAgentFace, { avatarIndex: 0, name: "Ada", status: "running" }),
    );
    expect(face(v).dataset.expression).toBe("pill");
    expect(vi.getTimerCount()).toBe(1);
    v.rerender(
      createElement(WorkflowAgentFace, { avatarIndex: 0, name: "Ada", status: undefined }),
    );
    expect(face(v).dataset.expression).toBe("dots");
    expect(vi.getTimerCount()).toBe(1);
  });
  it("成功不依赖偶发概率，开心抖眼和 pill 眨眼必定交替", () => {
    clock();
    vi.mocked(Math.random).mockReturnValue(0.8);
    const v = renderFace("done");
    const states: string[] = [];
    const motions = new Set<string>();
    for (let i = 0; i < 300; i++) {
      advance(100);
      const expression = face(v).dataset.expression!;
      if (states.at(-1) !== expression) states.push(expression);
      motions.add(face(v).dataset.motion!);
    }
    expect(states.length).toBeGreaterThanOrEqual(4);
    expect(states.every((value, i) => value === (i % 2 === 0 ? "happy" : "pill"))).toBe(true);
    expect(motions.has("glance")).toBe(false);
    expect(motions.has("hop")).toBe(true);
    expect(motions.has("blink")).toBe(true);
  });
  it("成功原地开心抖眼，pill 只眨一次立即回开心", () => {
    clock();
    const v = renderFace("done");
    advance(2300);
    expect(face(v).dataset.expression).toBe("pill");
    expect(face(v).dataset.motion).toBe("blink");
    expect(face(v).style.getPropertyValue("--wf-face-blinks")).toBe("1");
    expect(face(v).style.getPropertyValue("--wf-face-x")).toBe("0px");
    advance(500);
    expect(face(v).dataset.expression).toBe("happy");
  });
  it("失败委屈飘 1–2 下，偶尔生气抖眼，再回归委屈", () => {
    clock();
    const v = renderFace("failed");
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      advance(100);
      const n = face(v);
      seen.add(`${n.dataset.expression}:${n.dataset.motion}`);
      if (n.dataset.motion === "float")
        expect(["1", "2"]).toContain(n.style.getPropertyValue("--wf-face-floats"));
      if (n.dataset.motion === "shake")
        expect(["3", "4", "5"]).toContain(n.style.getPropertyValue("--wf-face-shakes"));
    }
    expect(seen.has("sad:float")).toBe(true);
    expect(seen.has("focused:shake")).toBe(true);
    expect(face(v).querySelector(".wf-face-body")!.getAttribute("style")).toBeNull();
  });
  it("疑惑眼保持至少 2.2 秒，不会像其他偶发表情一样很快收回", () => {
    clock();
    const v = renderFace();
    for (let i = 0; i < 1000 && face(v).dataset.expression !== "confused"; i++) advance(20);
    expect(face(v).dataset.expression).toBe("confused");
    advance(2200);
    expect(face(v).dataset.expression).toBe("confused");
    advance(2000);
    expect(face(v).dataset.expression).toBe("pill");
  });
  it("不再渲染鄙视眼型", () => {
    const v = renderFace();
    expect(face(v).querySelector('[data-eye-expression="unimpressed"]')).toBeNull();
  });
  it("成功态开心驻留明显长于普通 pill", () => {
    clock();
    const v = renderFace("done");
    let happy = 0;
    let pill = 0;
    for (let i = 0; i < 1200; i++) {
      advance(100);
      if (face(v).dataset.expression === "happy") happy++;
      else if (face(v).dataset.expression === "pill") pill++;
    }
    expect(happy).toBeGreaterThan(pill * 2);
  });
});
