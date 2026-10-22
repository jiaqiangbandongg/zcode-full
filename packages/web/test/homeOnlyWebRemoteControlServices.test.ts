import { describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: renderMock }),
}));

vi.mock("@zcode/ui", () => ({
  AppErrorBoundary: ({ children }: { children: unknown }) => children,
  Root: () => null,
  ZCodeIntlProvider: ({ children }: { children: unknown }) => children,
  generateMobileDeviceFingerprint: vi.fn(() => "test-mobile-fingerprint"),
  installDocumentHiddenMotionPause: vi.fn(),
  playTaskNotificationSound: vi.fn(),
  setStreamClientId: vi.fn(),
  setWebRemoteControlTerminalTransportState: vi.fn(),
}));

describe("createHomeOnlyWebRemoteControlServices", () => {
  it("absorbs disconnected mobile home initialization with safe empty results", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("document", {
      documentElement: { classList: { toggle: vi.fn() } },
      getElementById: vi.fn(() => ({ nodeType: 1 })),
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      matchMedia: () => ({ matches: false }),
      location: new URL("https://zcode.z.ai/"),
    });
    vi.stubGlobal("navigator", { language: "zh-CN" });

    const { createHomeOnlyWebRemoteControlServices } = await import("../src/main.js");
    const services = createHomeOnlyWebRemoteControlServices();

    await expect(services.oauthService.restoreCachedSession()).resolves.toBeNull();
    await expect(services.modelSelectionService.getView()).resolves.toEqual({
      revision: 0,
      providers: [],
    });
    const selectionSubscription = services.modelSelectionService.onDidChange(() => {});
    expect(() => selectionSubscription.dispose()).not.toThrow();
    await expect(services.clientScenesService.list()).resolves.toEqual({
      code: 0,
      msg: "",
      data: [],
    });
    await expect(
      services.skillsService.list({ workspacePath: "/remote/offline" }),
    ).resolves.toEqual({
      skills: [],
      capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
      diagnostics: [],
    });
    await expect(
      services.zcodeTaskService.listTasks({ workspacePath: "/remote/offline" }),
    ).resolves.toEqual([]);
    await expect(
      services.gitService.getRepositorySummary({ workspacePath: "/remote/offline" }),
    ).resolves.toMatchObject({
      workspacePath: "/remote/offline",
      isGitAvailable: false,
      isRepository: false,
    });
    await expect(
      services.hooksService.loadHooks({ workspacePath: "/remote/offline" }),
    ).resolves.toEqual({
      hooks: [],
      hooksEnabled: false,
    });
    await expect(
      services.memoryService.loadMemory({ workspacePath: "/remote/offline", agentId: "codex" }),
    ).resolves.toEqual({
      memory: null,
    });
    await expect(services.memoryService.listProjectMemories()).resolves.toEqual([]);
    await expect(
      services.outputStyleService.listStyles({ workspacePath: "/remote/offline" }),
    ).resolves.toEqual({
      styles: [],
    });
  });

  it("provides a real broadcast disposable for disconnected mobile home effects", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("document", {
      documentElement: { classList: { toggle: vi.fn() } },
      getElementById: vi.fn(() => ({ nodeType: 1 })),
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      matchMedia: () => ({ matches: false }),
      location: new URL("https://zcode.z.ai/"),
    });
    vi.stubGlobal("navigator", { language: "zh-CN" });

    const { createHomeOnlyWebRemoteControlServices } = await import("../src/main.js");
    const services = createHomeOnlyWebRemoteControlServices();
    const disposable = services.broadcastService.onMessage(() => {});

    expect(() => disposable.dispose()).not.toThrow();
    await expect(
      services.broadcastService.send({ channel: "state:theme", payload: "dark" }),
    ).resolves.toBeUndefined();
  });

  it("returns synchronous empty events for unlisted dynamic subscriptions", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("document", {
      documentElement: { classList: { toggle: vi.fn() } },
      getElementById: vi.fn(() => ({ nodeType: 1 })),
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      matchMedia: () => ({ matches: false }),
      location: new URL("https://zcode.z.ai/"),
    });
    vi.stubGlobal("navigator", { language: "zh-CN" });

    const { createHomeOnlyWebRemoteControlServices } = await import("../src/main.js");
    const services = createHomeOnlyWebRemoteControlServices();
    const workspace = { workspacePath: "/remote/offline" };
    const subscriptions = [
      services.zcodeTaskService.onDynamicWorkspaceEvent(workspace)(() => {}),
      services.zcodeAgentService.onDynamicSessionsIndexFrame(workspace)(() => {}),
      services.zcodeAgentService.onDynamicConversationFrame(workspace)(() => {}),
    ];

    for (const subscription of subscriptions) {
      expect(() => subscription.dispose()).not.toThrow();
    }
  });
});
