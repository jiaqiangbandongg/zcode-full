import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RootStartupLoading, ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";

describe("RootStartupLoading", () => {
  it("引导使用静态品牌图标时保留外观但不渲染呼吸动画", () => {
    const html = renderToStaticMarkup(createElement(ZCodeStartupLogoBadge, { animated: false }));
    expect(html).toContain("<svg");
    expect(html).toContain("linear-gradient");
    expect(html).not.toContain("<animate");
  });
  it("启动阻塞态使用整体呼吸的 ZCode SVG 而不是可见 loading 文案", () => {
    const html = renderToStaticMarkup(createElement(RootStartupLoading, { label: "加载中..." }));

    expect(html).toContain('data-testid="root-startup-loading"');
    expect(html).toContain('aria-label="加载中..."');
    expect(html).toContain("<svg");
    expect(html).toContain('attributeName="opacity"');
    expect(html).toContain('values="1;0.4;1"');
    expect(html).toContain("bg-background");
    expect(html).not.toContain(">加载中...<");
  });
});
