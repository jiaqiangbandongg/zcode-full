import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebRemoteControlFailureScreen } from "#src/web-remote-control/views.js";

describe("WebRemoteControlFailureScreen", () => {
  it("renders structured recovery guidance and the relay detail message", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlFailureScreen, {
        failure: {
          reason: "desktop-disconnected",
          message: "Desktop device is offline.",
        },
        locale: "en-US",
        onReload: () => {},
      }),
    );

    expect(html).toContain("Desktop Offline");
    expect(html).toContain("What happened");
    expect(html).toContain("Desktop device is offline.");
    expect(html).toContain("Try Again");
  });
  it("账号归属失败提供切换账号与选择其他设备两个动作", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlFailureScreen, {
        failure: { reason: "device-not-owned" },
        locale: "zh-CN",
        onReload: () => {},
        primaryActionLabel: "切换账号",
        secondaryAction: { label: "选择其他设备", onClick: () => {} },
      }),
    );
    expect(html).toContain("该设备不属于当前账号");
    expect(html).toContain("切换账号");
    expect(html).toContain("选择其他设备");
    expect(html).not.toContain(">重新连接</button>");
  });
});
