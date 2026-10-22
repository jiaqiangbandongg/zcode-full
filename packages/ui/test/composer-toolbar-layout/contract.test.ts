// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { exampleComposerToolbarLayout } from "@/composer-toolbar-layout/contract.example.js";
import { fitComposerToolbar } from "@/prompt-editor/useComposerToolbarFit.js";

describe("composer toolbar layout contract", () => {
  it("通过原布局入口测量并更新控件，不更改业务属性", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-composer-leading-actions><div data-composer-leading-content>
      <button data-composer-collapse-priority="0" data-model-id="model-a"></button>
    </div></div>`;
    const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]")!;
    const content = root.querySelector<HTMLElement>("[data-composer-leading-content]")!;
    const control = root.querySelector<HTMLElement>("button")!;
    vi.spyOn(available, "getBoundingClientRect").mockReturnValue({ width: 40 } as DOMRect);
    vi.spyOn(content, "getBoundingClientRect").mockImplementation(
      () => ({ width: control.dataset.composerCompact ? 28 : 100 }) as DOMRect,
    );

    exampleComposerToolbarLayout({ fit: fitComposerToolbar }, root);

    expect(control.dataset.composerCompact).toBe("true");
    expect(control.dataset.modelId).toBe("model-a");
    expect(root.dataset.composerModelIcon).toBeUndefined();
  });
});
