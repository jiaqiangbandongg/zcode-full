import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDeepLinkProtocol } from "@desktop/main/desktopOAuthDeepLink";
import {
  createDeepLinkSingleInstanceData,
  extractDeepLinkUrlFromArgs,
  extractDeepLinkUrlFromSingleInstanceData,
} from "@desktop/main/desktopDeepLinkUrl";

const mocks = vi.hoisted(() => ({
  register: vi.fn(() => true),
  registerLinux: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    setAsDefaultProtocolClient: mocks.register,
    isPackaged: true,
    name: "ZCode",
    getPath: () => "/test-home",
  },
  BrowserWindow: {},
  dialog: {},
}));
vi.mock("@desktop/main/desktopLinuxDeepLinkRegistration", () => ({
  registerLinuxDeepLinkProtocol: mocks.registerLinux,
}));

const defaultAppDescriptor = Object.getOwnPropertyDescriptor(process, "defaultApp");
const logger = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.register.mockReturnValue(true);
  Object.defineProperty(process, "defaultApp", { configurable: true, value: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (defaultAppDescriptor) {
    Object.defineProperty(process, "defaultApp", defaultAppDescriptor);
  } else {
    Reflect.deleteProperty(process, "defaultApp");
  }
});

describe("Windows Deep Link 启动参数边界", () => {
  it("生产态每次注册都覆盖为带参数分隔符的模板", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    registerDeepLinkProtocol(logger);
    registerDeepLinkProtocol(logger);

    expect(mocks.register.mock.calls).toEqual([
      ["zcode", process.execPath, ["--"]],
      ["zcode", process.execPath, ["--"]],
    ]);
  });

  it("开发态入口留在分隔符前，外部 URL 只能追加到分隔符后", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    Object.defineProperty(process, "defaultApp", { configurable: true, value: true });
    const entry = resolve("开发项目 with spaces", "main.js");
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, entry]);

    registerDeepLinkProtocol(logger);

    expect(mocks.register).toHaveBeenCalledWith("zcode", process.execPath, [entry, "--"]);
  });

  it("安全注册失败仍记录警告", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.register.mockReturnValue(false);

    registerDeepLinkProtocol(logger);

    expect(logger.warn).toHaveBeenCalledWith("[deep-link] 注册协议失败", { scheme: "zcode" });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it.each([
    "zcode://oauth/callback?code=code%20value&state=state",
    "zcode://payment/callback?provider=zai&status=return",
    "zcode://workspace/open?path=C%3A%5CProject%20A%26B",
    "zcode://share/import?code=abc_DEF-123",
  ])("分隔符保留冷启动和单实例投递中的正常 URL：%s", (url) => {
    const argv = [process.execPath, "--", url];
    expect(extractDeepLinkUrlFromArgs(argv)).toBe(url);
    expect(extractDeepLinkUrlFromSingleInstanceData(createDeepLinkSingleInstanceData(argv))).toBe(
      url,
    );
  });
});

describe("非 Windows 注册兼容性", () => {
  it.each(["darwin", "linux"] as const)("%s 保留生产注册调用", (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);

    registerDeepLinkProtocol(logger);

    expect(mocks.register).toHaveBeenCalledWith("zcode");
    expect(mocks.registerLinux).toHaveBeenCalledTimes(platform === "linux" ? 1 : 0);
  });

  it.each(["darwin", "linux"] as const)("%s 保留开发注册入口", (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    Object.defineProperty(process, "defaultApp", { configurable: true, value: true });
    const entry = resolve("desktop", "main.js");
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, entry]);

    registerDeepLinkProtocol(logger);

    expect(mocks.register).toHaveBeenCalledWith("zcode", process.execPath, [entry]);
    expect(mocks.registerLinux).not.toHaveBeenCalled();
  });
});
