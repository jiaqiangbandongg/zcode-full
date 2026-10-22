// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRemoteControlDeviceHeader } from "@/web-remote-control/WebRemoteControlDeviceHeader.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: { name: string }) => values?.name ?? id,
    },
  }),
}));
afterEach(cleanup);

describe("远控设备导航", () => {
  it.each([undefined, "", "   "])(
    "缺失或空名称 %s 显示未命名设备，点击才调用入口命令",
    (deviceName) => {
      const chooseOtherDevice = vi.fn();
      const page = render(
        createElement(WebRemoteControlDeviceHeader, {
          navigation: { deviceName, chooseOtherDevice },
        }),
      );
      expect(page.getByText("webRemoteControl.unnamedDevice")).toBeTruthy();
      expect(chooseOtherDevice).not.toHaveBeenCalled();
      fireEvent.click(page.getByRole("button", { name: "webRemoteControl.switchDevice" }));
      expect(chooseOtherDevice).toHaveBeenCalledOnce();
    },
  );

  it("整行即切换入口：设备名在按钮内单行截断，不再显示“当前设备”前缀", () => {
    const chooseOtherDevice = vi.fn();
    const page = render(
      createElement(WebRemoteControlDeviceHeader, {
        navigation: { deviceName: "  研发电脑  ", chooseOtherDevice },
      }),
    );
    const button = page.getByRole("button", { name: "webRemoteControl.switchDevice" });
    const name = page.getByText("研发电脑");
    expect(name.textContent).toBe("研发电脑");
    expect(button.contains(name)).toBe(true);
    expect(name.className).toContain("truncate");
    expect(button.getAttribute("title")).toBe("webRemoteControl.switchDevice");
    expect(button.textContent).toBe("研发电脑");
    fireEvent.click(name);
    expect(chooseOtherDevice).toHaveBeenCalledOnce();
  });

  it.each([
    ["darwin", "darwin"],
    ["win32", "win32"],
    [undefined, "unknown"],
  ])("平台 %s 显示对应设备图标 %s", (devicePlatform, icon) => {
    const page = render(
      createElement(WebRemoteControlDeviceHeader, {
        navigation: { deviceName: "Mac", devicePlatform, chooseOtherDevice: vi.fn() },
      }),
    );
    const button = page.getByRole("button", { name: "webRemoteControl.switchDevice" });
    expect(button.querySelector(`[data-device-platform-icon="${icon}"]`)).not.toBeNull();
  });
});
