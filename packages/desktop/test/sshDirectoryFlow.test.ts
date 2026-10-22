import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceChannels } from "@zcode/shared";
import { TID_SETTINGS_SECTION_NAV, TID_TASK_SETTINGS_BUTTON, testId } from "@zcode/shared/test-ids";
import { clickTestIdByDom, clickTestIdByWebDriver } from "#e2e/helpers/desktop-app";
import { callHandoffHost } from "#e2e/helpers/remote-project-handoff-probe";
import { openSSHRemoteDialog, openSSHSourceDirectory } from "#e2e/helpers/ssh-remote-p0";

vi.mock("./e2e/helpers/desktop-app.js", () => ({
  clickTestIdByDom: vi.fn(),
  clickTestIdByWebDriver: vi.fn(),
  hoverTestIdByWebDriver: vi.fn(),
  setInputValueByTestIdDom: vi.fn(),
  waitForWorkspaceApp: vi.fn(),
  waitForTestIdByDom: vi.fn(),
}));
vi.mock("./e2e/helpers/custom-openai-provider-store.js", () => ({}));
vi.mock("./e2e/helpers/v4-conversation.js", () => ({ startNewV4Draft: vi.fn() }));

vi.mock("./e2e/helpers/remote-project-handoff-probe.js", () => ({
  installHandoffRpcProbe: vi.fn(),
  callHandoffHost: vi.fn(async () => ({
    profiles: [
      {
        transport: "ssh",
        lifecycleState: "active",
        sourceServerId: "known-source",
        target: { kind: "ssh", host: "127.0.0.1", port: 43210, username: "dev" },
      },
    ],
  })),
}));
const target = { host: "127.0.0.1", port: 43210, username: "dev", password: "fixture" };

function button(text: string, disabled = false) {
  return { innerText: text, disabled, getClientRects: () => [1], click: vi.fn() };
}

function installBrowserFixture(directoryLabel: string, disabled = false, settingsOpen = false) {
  const directoryButton = button(directoryLabel, disabled);
  const newConnectionButton = { ...button("新建连接"), textContent: "新建连接" };
  const sidebarButton = button("在此设备聊天");
  const sidebar = {
    innerText: "dev@127.0.0.1:43210 侧栏",
    querySelectorAll: () => [sidebarButton],
  };
  const card = {
    innerText: "测试设备 dev@127.0.0.1:43210 已连接",
    querySelector: () => (disabled ? null : directoryButton),
    querySelectorAll: () => [directoryButton],
  };
  const dialog = {
    querySelectorAll: (selector: string) =>
      ["section", "[data-remote-source-server-id]"].includes(selector) ? [card] : [directoryButton],
  };
  const document = {
    querySelector: (selector: string) =>
      selector.includes("ssh-dialog")
        ? dialog
        : selector.includes("settings-page")
          ? { querySelectorAll: () => [newConnectionButton] }
          : null,
    querySelectorAll: (selector: string) =>
      selector === "section"
        ? [sidebar, card]
        : selector === '[role="dialog"] button'
          ? [{ textContent: "添加连接", click: vi.fn() }]
          : [sidebarButton, directoryButton],
  };
  vi.stubGlobal("$", (selector: string) => ({
    waitForDisplayed: async () => {
      if (selector.includes("data-device-id") && disabled) throw new Error("saved device missing");
    },
    isDisplayed: async () => selector.includes("settings-page") && settingsOpen,
    click: selector.includes("data-device-id") ? directoryButton.click : vi.fn(),
  }));
  vi.stubGlobal("browser", {
    // 使用独立 VM 执行真实 browser callback，捕获误用 Node 闭包常量的问题。
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      runInNewContext(`(${fn.toString()})(...args)`, {
        document,
        args,
        window: { __remoteProjectHandoffRpc: { ready: true } },
      }),
    waitUntil: async (predicate: () => Promise<boolean>, options: { timeoutMsg: string }) => {
      if (!(await predicate())) throw new Error(options.timeoutMsg);
    },
  });
  return { directoryButton, sidebarButton, newConnectionButton };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SSH 项目目录入口", () => {
  it("连接向导专用 case 从设置页新建连接，不进入项目创建的 Host 选择路径", async () => {
    const { newConnectionButton } = installBrowserFixture("测试设备");
    await openSSHRemoteDialog("E2E_SSH_DIRECTORY", { entry: "settings" });
    expect(clickTestIdByDom).toHaveBeenCalledWith(TID_TASK_SETTINGS_BUTTON);
    expect(clickTestIdByDom).toHaveBeenCalledWith(
      testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"),
    );
    expect(newConnectionButton.click).toHaveBeenCalledOnce();
    expect(clickTestIdByWebDriver).not.toHaveBeenCalledWith("virtual-project-add");
  });

  it("取消独立向导后仍在设置页，可直接重新打开连接，不点击被遮挡的全局设置入口", async () => {
    const { newConnectionButton } = installBrowserFixture("测试设备", false, true);
    await openSSHRemoteDialog("E2E_SSH_DIRECTORY", { entry: "settings" });
    expect(clickTestIdByDom).not.toHaveBeenCalledWith(TID_TASK_SETTINGS_BUTTON);
    expect(newConnectionButton.click).toHaveBeenCalledOnce();
  });

  it("按真实Source身份选择设备，不点击同名侧栏", async () => {
    const { directoryButton, sidebarButton } = installBrowserFixture("测试设备");
    await openSSHSourceDirectory(target, "E2E_SSH_DIRECTORY");
    expect(callHandoffHost).toHaveBeenCalledWith(
      ServiceChannels.SourceServerManagement,
      "getSnapshot",
    );
    expect(clickTestIdByWebDriver).toHaveBeenCalledWith("virtual-project-device");
    expect(clickTestIdByWebDriver).toHaveBeenCalledWith("virtual-project-browse");
    expect(directoryButton.click).toHaveBeenCalledTimes(1);
    expect(sidebarButton.click).not.toHaveBeenCalled();
  });

  it("设备没有进入选择器时报告缺失，不点击同名旧卡片", async () => {
    const { directoryButton } = installBrowserFixture("选择其他目录", true);
    await expect(openSSHSourceDirectory(target, "E2E_SSH_DIRECTORY")).rejects.toThrow(
      "saved device missing",
    );
    expect(directoryButton.click).not.toHaveBeenCalled();
  });
});
