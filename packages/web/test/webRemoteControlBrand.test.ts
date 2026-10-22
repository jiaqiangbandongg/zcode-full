import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebRemoteControlBrand } from "#src/web-remote-control/views.js";

describe("远控页头品牌", () => {
  it("品牌图标为装饰性，整体不可交互", () => {
    const html = renderToStaticMarkup(createElement(WebRemoteControlBrand));
    expect(html).toMatch(/<img[^>]*data-app-logo="zcode"/);
    expect(html).toMatch(/<img[^>]*alt=""/);
    expect(html).toMatch(/<img[^>]*aria-hidden="true"/);
    expect(html).toContain("ZCode");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("role=");
  });
});
