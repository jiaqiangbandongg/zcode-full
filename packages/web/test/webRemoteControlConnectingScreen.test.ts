import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebRemoteControlLoadingScreen } from "#src/web-remote-control/views.js";

const render = (props: Parameters<typeof WebRemoteControlLoadingScreen>[0]) =>
  renderToStaticMarkup(createElement(WebRemoteControlLoadingScreen, props));

describe("连接过程页", () => {
  it.each(["zh-CN", "en-US"] as const)("%s 显示目标电脑、平台图标与当前阶段", (locale) => {
    const html = render({
      state: "authenticating",
      locale,
      device: { name: "Alice’s MacBook", platform: "darwin" },
    });
    expect(html).toContain(
      locale === "zh-CN" ? "正在连接 Alice’s MacBook" : "Connecting to Alice’s MacBook",
    );
    expect(html).toContain(locale === "zh-CN" ? "正在认证设备…" : "Authenticating device…");
    expect(html).toContain('data-device-platform-icon="darwin"');
    expect(html.match(/data-step-state="done"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*data-step-state="active"/);
  });

  it("没有名字和平台时用通用文案与电脑图标；重连不高亮进度并补充说明", () => {
    const html = render({ state: "reconnecting", locale: "zh-CN" });
    expect(html).toContain("正在连接电脑");
    expect(html).toContain('data-device-platform-icon="unknown"');
    expect(html).toContain("连接中断，正在重连…");
    expect(html).toContain("网络或休眠恢复后会自动重连，请稍候。");
    expect(html.match(/data-step-state="idle"/g)).toHaveLength(4);
    expect(html).not.toContain('aria-current="step"');
  });

  it("配对完成进入最后一段", () => {
    const html = render({ state: "paired", locale: "en-US", device: { name: "PC" } });
    expect(html).toContain("Paired. Loading workspace…");
    expect(html.match(/data-step-state="done"/g)).toHaveLength(3);
  });
});
