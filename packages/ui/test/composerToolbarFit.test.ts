// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fitComposerToolbar } from "@/prompt-editor/useComposerToolbarFit.js";

// jsdom 不做排版：只替代几何读数，保留真实 DOM、裁决和各阶段的空间变化。
function fixture() {
  const root = document.createElement("div");
  root.style.columnGap = "12px";
  root.innerHTML = `<div data-composer-leading-actions><div data-composer-leading-content>
    <button data-composer-collapse-priority="1"></button>
    <button data-composer-collapse-priority="2"></button>
    <button data-composer-collapse-priority="0"></button>
  </div></div><div data-composer-trailing-actions>
    <button class="composer-model-trigger"><span class="composer-provider-prefix">Provider/</span>Model</button>
    <button data-composer-collapse-priority="3" data-composer-thought-control></button><button>Send</button>
  </div>`;
  const controls = [...root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]")];
  const leading = root.querySelector<HTMLElement>("[data-composer-leading-content]")!;
  const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]")!;
  const trailing = root.querySelector<HTMLElement>("[data-composer-trailing-actions]")!;
  const model = root.querySelector<HTMLElement>(".composer-model-trigger")!;
  let width = 740;
  const rect = (value: number) => ({ width: value }) as DOMRect;
  const controlWidth = (index: number) => {
    if (!root.contains(controls[index])) return 0;
    if (!controls[index].dataset.composerCompact) return 100;
    return index === 3 && controls[index].dataset.composerCompact === "true" ? 40 : 28;
  };
  model.getBoundingClientRect = () =>
    rect(root.dataset.composerModelIcon ? 28 : root.dataset.composerProviderCompact ? 200 : 300);
  trailing.getBoundingClientRect = () =>
    rect(model.getBoundingClientRect().width + controlWidth(3) + 28);
  leading.getBoundingClientRect = () => rect(controlWidth(0) + controlWidth(1) + controlWidth(2));
  root.getBoundingClientRect = () => rect(width);
  available.getBoundingClientRect = () =>
    rect(Math.max(0, width - trailing.getBoundingClientRect().width - 12));
  return {
    root,
    controls,
    fit(nextWidth: number) {
      width = nextWidth;
      fitComposerToolbar(root);
    },
    compact() {
      return controls.map((control) => control.dataset.composerCompact ?? "full");
    },
  };
}

describe("composer toolbar fit", () => {
  it("七档独立压缩，think/供应商与末尾两个图标分别裁决，放宽逆序恢复", () => {
    const f = fixture();
    const expected: Record<number, string[]> = {
      740: ["full", "full", "full", "full"],
      739: ["full", "full", "true", "full"],
      668: ["full", "full", "true", "full"],
      667: ["true", "full", "true", "full"],
      596: ["true", "full", "true", "full"],
      595: ["true", "true", "true", "full"],
      524: ["true", "true", "true", "full"],
      523: ["true", "true", "true", "true"],
      464: ["true", "true", "true", "true"],
      463: ["true", "true", "true", "true"],
      364: ["true", "true", "true", "true"],
      363: ["true", "true", "true", "icon"],
      352: ["true", "true", "true", "icon"],
      351: ["true", "true", "true", "icon"],
      180: ["true", "true", "true", "icon"],
    };
    for (const width of [
      740, 739, 668, 667, 596, 595, 524, 523, 464, 463, 364, 363, 352, 351, 180, 352, 364, 464, 524,
      596, 668, 740,
    ]) {
      f.fit(width);
      expect(f.compact(), `width=${width}`).toEqual(expected[width]);
      expect(f.root.dataset.composerProviderCompact === "true").toBe(width < 464);
      expect(f.root.dataset.composerModelIcon === "true").toBe(width < 352);
    }
  });

  it("手机缺少 Computer 时直接进入第二档，think 与模型最后分两档收起", () => {
    const f = fixture();
    f.controls[2].remove();
    f.fit(640);
    expect(f.compact()).toEqual(["full", "full", "full", "full"]);
    f.fit(639);
    expect(f.compact()).toEqual(["true", "full", "full", "full"]);
    expect(f.root.dataset.composerProviderCompact).toBeUndefined();
    f.fit(336);
    expect(f.root.dataset.composerProviderCompact).toBe("true");
    expect(f.controls[3].dataset.composerCompact).toBe("true");
    f.fit(335);
    expect(f.root.dataset.composerModelIcon).toBeUndefined();
    expect(f.controls[3].dataset.composerCompact).toBe("icon");
    f.fit(323);
    expect(f.root.dataset.composerModelIcon).toBe("true");
  });

  it("缺少可收起控件时仍处理供应商和模型，空间恢复时清除压缩状态", () => {
    const f = fixture();
    f.controls.forEach((control) => control.remove());
    f.fit(240);
    expect(f.root.dataset.composerProviderCompact).toBe("true");
    expect(f.root.dataset.composerModelIcon).toBeUndefined();
    f.fit(239);
    expect(f.root.dataset.composerModelIcon).toBe("true");
    f.fit(340);
    expect(f.root.dataset.composerProviderCompact).toBeUndefined();
    expect(f.root.dataset.composerModelIcon).toBeUndefined();
  });
});
