import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import type {
  WebRemoteControlDeviceGroup,
  WebRemoteControlDeviceListView,
} from "#src/web-remote-control/index.js";

import {
  WebRemoteControlDeviceListPage,
  WebRemoteControlConnectionList,
} from "#src/web-remote-control/views.js";

const actions = { onSelect: () => {}, onRefresh: () => {}, onSwitchAccount: () => {} };

const connection = (
  sid: string,
  mid: string,
  meta: WebRemoteControlRelayV2Device["meta"],
  createdAt = 1,
): WebRemoteControlRelayV2Device => ({
  device_sid: sid,
  device_mid: mid,
  online: true,
  created_at: createdAt,
  meta,
});

const mac: WebRemoteControlDeviceGroup = {
  deviceMid: "abcdefgh-long",
  name: "MacBook",
  platform: "darwin",
  onlineConnections: [
    connection("on", "abcdefgh-long", { name: "MacBook", platform: "darwin", version: "3.15.0" }),
  ],
};
const homePc: WebRemoteControlDeviceGroup = {
  deviceMid: "12345678-long",
  name: "Home PC",
  platform: "linux",
  onlineConnections: [],
};
const unnamed: WebRemoteControlDeviceGroup = { deviceMid: "87654321-long", onlineConnections: [] };

function render(
  locale: "zh-CN" | "en-US",
  view: Partial<WebRemoteControlDeviceListView> & Pick<WebRemoteControlDeviceListView, "devices">,
) {
  return renderToStaticMarkup(
    createElement(WebRemoteControlDeviceListPage, {
      ...actions,
      locale,
      view: { kind: "devices", loading: false, error: false, ...view },
    }),
  );
}

describe("连接前设备列表", () => {
  it.each(["zh-CN", "en-US"] as const)(
    "%s 按在线/离线分组，显示平台与版本，离线禁用且默认不显示设备 ID",
    (locale) => {
      const zh = locale === "zh-CN";
      const html = render(locale, { devices: [mac, homePc, unnamed] });
      expect(html).toContain(zh ? "选择电脑" : "Choose a computer");
      expect(html).toMatch(new RegExp(`${zh ? "在线" : "Online"}<span[^>]*>1</span>`));
      expect(html).toMatch(new RegExp(`${zh ? "离线" : "Offline"}<span[^>]*>2</span>`));
      expect(html).toContain("macOS · ZCode 3.15.0");
      expect(html).toContain(zh ? "Linux · 离线" : "Linux · Offline");
      expect(html).toContain(zh ? "未命名设备" : "Unnamed device");
      expect(html).toContain('data-device-platform-icon="darwin"');
      expect(html).toContain('data-device-platform-icon="linux"');
      expect(html).toContain('data-device-platform-icon="unknown"');
      expect(html).not.toContain("abcdefgh");
      expect(html).not.toContain("12345678");
      // 两个离线行原生禁用；在线单连接行可点
      expect(html.match(/<button type="button" disabled=""[^>]*class="flex w-full/g)).toHaveLength(
        2,
      );
      expect(html).toContain(
        zh
          ? "没看到你的电脑？在电脑端 ZCode 登录同一账号并开启远程控制，然后刷新。"
          : "Don&#x27;t see your computer?",
      );
    },
  );

  it("同组重名时追加 MID 前 8 位区分，其他设备仍不显示 ID", () => {
    const twin = { ...homePc, deviceMid: "fedcba98-long", name: "Home PC" };
    const html = render("zh-CN", { devices: [mac, homePc, twin] });
    expect(html).toContain("Linux · 离线 · ID 12345678");
    expect(html).toContain("Linux · 离线 · ID fedcba98");
    expect(html).not.toContain("abcdefgh");
  });

  it("账号行显示显示名与登录平台；读不到账号时只保留切换账号按钮", () => {
    const withAccount = render("zh-CN", {
      devices: [mac],
      account: { displayName: "jyrong", provider: "bigmodel" },
    });
    expect(withAccount).toContain("jyrong · BigModel");
    expect(withAccount).toMatch(/>J<\/span>/);
    expect(withAccount).toContain(">切换</button>");
    const withoutAccount = render("en-US", { devices: [mac] });
    expect(withoutAccount).toContain(">Switch account</button>");
    expect(withoutAccount).not.toContain(" · Z.ai");
  });

  it.each(["zh-CN", "en-US"] as const)("%s 多个在线连接只占一行，显示连接数且可点开", (locale) => {
    const multi: WebRemoteControlDeviceGroup = {
      deviceMid: "abcdefgh-long",
      name: "Workstation",
      platform: "win32",
      onlineConnections: ["sid-one", "sid-two"].map((sid) =>
        connection(sid, "abcdefgh-long", { name: "Workstation", version: "3.14.1" }),
      ),
    };
    const html = render(locale, { devices: [multi] });
    expect(html.match(/<li>/g)).toHaveLength(1);
    expect(html).toContain(locale === "zh-CN" ? "2 个连接" : "2 connections");
    expect(html).toContain(">Windows</span>");
    expect(html).not.toContain("sid-one");
    expect(html).not.toContain('disabled=""');
  });

  it("多连接选择行显示版本、启动时间与 SID 末 6 位，不展示完整 SID；刷新中禁用", () => {
    const now = Date.UTC(2026, 8, 23, 12);
    const device: WebRemoteControlDeviceGroup = {
      deviceMid: "abcdefgh-long",
      name: "Workstation",
      platform: "win32",
      onlineConnections: [
        connection(
          "sid-alpha-a41f9c",
          "abcdefgh-long",
          { version: "3.15.0" },
          now / 1000 - 3 * 3600,
        ),
        connection(
          "e2e-device-alternative-with-a-long-connection-identifier",
          "abcdefgh-long",
          {},
          now / 1000 - 2 * 86_400,
        ),
      ],
    };
    const list = (locale: "zh-CN" | "en-US", disabled = false) =>
      renderToStaticMarkup(
        createElement(WebRemoteControlConnectionList, {
          device,
          locale,
          disabled,
          now,
          onSelect: () => {},
        }),
      );
    const zh = list("zh-CN");
    expect(zh).toContain("ZCode 3.15.0");
    expect(zh).toContain("3小时前启动 · ID a41f9c");
    expect(zh).toContain(">ZCode</span>");
    expect(zh).toContain("前天启动 · ID tifier");
    expect(zh).not.toContain("e2e-device-alternative");
    expect(list("en-US")).toContain("started 3 hours ago · ID a41f9c");
    expect(list("zh-CN", true).match(/disabled=""/g)).toHaveLength(2);
  });

  it("空列表给出同账号开启远控提示与刷新按钮，加载和失败不能冒充空态", () => {
    const empty = (loading: boolean, error: boolean) =>
      render("zh-CN", { devices: [], loading, error });
    expect(empty(false, false)).toContain("暂无设备");
    expect(empty(false, false)).toContain("在电脑端登录同一账号并开启 Web 远程控制");
    expect(empty(false, false)).toContain(">刷新</button>");
    expect(empty(true, false)).toContain("正在加载设备");
    expect(empty(true, false)).not.toContain("暂无设备");
    expect(empty(true, false)).toMatch(
      /aria-label="刷新"[^>]*disabled=""|disabled=""[^>]*aria-label="刷新"/,
    );
    expect(empty(false, true)).toContain("无法加载设备");
    expect(empty(false, true)).not.toContain("暂无设备");
  });

  it("刷新中或刷新失败时在线行暂不可选", () => {
    expect(render("zh-CN", { devices: [mac], loading: true }).match(/disabled=""/g)).toHaveLength(
      2,
    );
    expect(render("zh-CN", { devices: [mac], error: true }).match(/disabled=""/g)).toHaveLength(1);
  });
});
