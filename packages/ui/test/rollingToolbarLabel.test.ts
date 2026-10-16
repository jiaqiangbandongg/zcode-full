// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";

describe("RollingToolbarLabel", () => {
  it("uses a taller line box for toolbar labels", () => {
    const html = renderToStaticMarkup(createElement(RollingToolbarLabel, { label: "Planning" }));

    expect(html).toContain("h-[1.3em]");
    expect(html).toContain("leading-[1.25]");
    expect(html).not.toContain("h-[1.15em]");
    expect(html).not.toContain("leading-none");
  });

  it("renders a responsive prefix separately while preserving the full title", () => {
    const html = renderToStaticMarkup(
      createElement(RollingToolbarLabel, {
        label: "deepseek/deepseek-v4-flash",
        prefix: "deepseek/",
        prefixClassName: "hidden @xl/composer:inline",
        value: "deepseek-v4-flash",
      }),
    );

    expect(html).toContain('title="deepseek/deepseek-v4-flash"');
    expect(html).toContain('class="hidden @xl/composer:inline"');
    expect(html).toContain("deepseek/");
    expect(html).toContain("deepseek-v4-flash");
  });
});

// 模型触发器把标签的第二层 span 设为块级省略行；减少动画不能让它命中两个文字片段。
it.each([false, true])("系统减少动画=%s 时供应商和模型共用一个截断行", async (reducedMotion) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: reducedMotion,
    addEventListener() {},
    removeEventListener() {},
  }));
  try {
    await act(async () =>
      root.render(
        createElement(RollingToolbarLabel, {
          label: "ZAPI (Anthropic) / GLM-5.3-Highspeed-fusion",
          prefix: "ZAPI (Anthropic) / ",
          prefixClassName: "inline",
          value: "GLM-5.3-Highspeed-fusion",
        }),
      ),
    );
    const lines = host.querySelectorAll(":scope > span > span");
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe("ZAPI (Anthropic) / GLM-5.3-Highspeed-fusion");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
