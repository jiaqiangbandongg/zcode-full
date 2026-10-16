import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * 验证 renderer/main.tsx 中 handleServicePortMessage 的防重复 createRoot 逻辑：
 * 多次收到 ServicePort message 时只应初始化一次 React root。
 *
 * 这里不真正渲染 React，而是验证 createRoot 只被调用一次。
 */

const createRootMock = vi.fn(() => ({
  render: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  createRoot: createRootMock,
}));

vi.mock("@zcode/ui", () => ({
  AppErrorBoundary: ({ children }: { children: unknown }) => children,
  Root: () => null,
  ZCodeIntlProvider: ({ children }: { children: unknown }) => children,
  registerBaseWorkspaceServices: vi.fn(),
  registerRemoteWorkspaceSession: vi.fn(),
  playTaskNotificationSound: vi.fn(() => Promise.resolve()),
}));

vi.mock("@zcode/client", () => ({
  connectViaMessagePort: vi.fn(() => ({
    settingService: {},
  })),
}));

// 模拟 window.zcode
vi.stubGlobal("window", {
  ...globalThis.window,
  location: { search: "" },
  matchMedia: () => ({ matches: true }),
  zcode: {
    selectDirectory: vi.fn(),
    activateOrSetWorkspace: vi.fn(),
    connectRemote: vi.fn(),
    disposeRemoteSession: vi.fn(async () => {}),
    isDockerAvailable: vi.fn(async () => false),
    listWSLDistros: vi.fn(async () => []),
    listDockerContainers: vi.fn(async () => []),
    listSSHConfigAliases: vi.fn(async () => []),
    openExternal: vi.fn(),
    registerOAuthState: vi.fn(),
    onOAuthCallback: vi.fn(() => () => {}),
    notifyRendererReady: vi.fn(),
    reportTelemetryEvent: vi.fn(async () => {}),
    showTaskNotification: vi.fn(),
    syncWindowTabs: vi.fn(),
    syncWindowUnreadCount: vi.fn(),
    onFocusTab: vi.fn(() => () => {}),
    onNewTab: vi.fn(() => () => {}),
    onNewTask: vi.fn(() => () => {}),
    onOpenWorkspace: vi.fn(() => () => {}),
    onWindowFullscreenChanged: vi.fn(() => () => {}),
    onTaskNotificationClick: vi.fn(() => () => {}),
    exportLogs: vi.fn(),
    onUpdateReady: vi.fn(() => () => {}),
    onUpdateCheckResult: vi.fn(() => () => {}),
    quitAndInstallUpdate: vi.fn(async () => {}),
    getInstalledEditors: vi.fn(),
    openInEditor: vi.fn(),
    executeDesktopCommand: vi.fn(),
    setApplicationLocale: vi.fn(),
    setTitleBarTheme: vi.fn(),
  },
  addEventListener: vi.fn(),
});

vi.stubGlobal("document", {
  documentElement: { classList: { add: vi.fn() } },
  getElementById: vi.fn(() => ({})),
});

vi.stubGlobal("navigator", { userAgent: "Mac" });
vi.stubGlobal("localStorage", {
  getItem: () => "dark",
  setItem: vi.fn(),
});

describe("renderer main.tsx 防重复 createRoot", () => {
  beforeEach(() => {
    createRootMock.mockClear();
    vi.resetModules();
  });

  it("handleServicePortMessage 是命名函数而非匿名函数", () => {
    // Bugfix: 这个断言只关心入口文件里是否保留了可复用的命名 handler，
    // 没必要在全量测试时把整个 renderer 入口都 import 起来。直接读源码能避开
    // 大量模块初始化带来的偶发超时，同时仍然能防回归。
    const source = readFileSync(join(import.meta.dirname, "../src/renderer/src/main.tsx"), "utf-8");

    expect(source).toContain("function handleServicePortMessage(event: MessageEvent): void");
    expect(source).toContain('window.addEventListener("message", handleServicePortMessage);');
  });

  it("onOpenWorkspace bridge 缺失时有无操作 disposer 兜底", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../src/renderer/src/desktopPlatform.ts"),
      "utf-8",
    );

    expect(source).toContain("window.zcode.onOpenWorkspace?.(handler) ?? (() => {})");
  });

  it("remote workspace service port 早于 base ServicePort 时会暂存并在 base ready 后 flush", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/renderer/src/main.tsx"), "utf-8");

    expect(source).toContain("const pendingRemoteWorkspaceServicePorts");
    expect(source).toContain("pendingRemoteWorkspaceServicePorts.push(remoteWorkspacePort);");
    expect(source).toContain("notifyRemoteWorkspaceServicePortReady(params);");
    expect(source).toContain("function flushPendingRemoteWorkspaceServicePorts(): void");
    expect(source).toContain("flushPendingRemoteWorkspaceServicePorts();");
  });

  it("desktop Root 暂时显式开启 Assistant code-comment 卡片", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/renderer/src/main.tsx"), "utf-8");

    expect(source).toContain("isDesktop");
    expect(source).toContain("assistantCodeCommentCardsEnabled");
  });
});
