// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  SourceServerManagementSnapshot,
  SSHConfigAliasOption,
  DockerContainerInfo,
  WSLDistro,
} from "@zcode/shared";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import { createCanonicalWslTargetResolver } from "@desktop/main/desktopWslTargetResolver.js";

const ports = vi.hoisted(() => ({
  trace: { complete: vi.fn(), fail: vi.fn(), cancel: vi.fn() },
  locale: "zh-CN",
  snapshot: {} as SourceServerManagementSnapshot,
  credentialService: { load: vi.fn(async (): Promise<string | null> => null), save: vi.fn() },
  settingService: {
    get: vi.fn<
      () => Promise<{
        remoteBoundaryOnboardingVersion?: number;
        remoteBoundaryIntroAcknowledgedVersion?: number;
      }>
    >(async () => ({ remoteBoundaryIntroAcknowledgedVersion: 1 })),
    update: vi.fn(async () => undefined),
  },
  management: {
    getSnapshot: vi.fn(),
    onDidChangeState: () => ({ dispose() {} }),
    onDidChangeDirectory: () => ({ dispose() {} }),
    updateSource: vi.fn(),
    confirmIdentityChange: vi.fn(),
  },
  platform: {
    isLocalDevelopmentRuntime: true,
    isDockerAvailable: vi.fn(async () => true),
    listSSHConfigAliases: vi.fn(async (): Promise<SSHConfigAliasOption[]> => []),
    listWSLDistros: vi.fn(async (): Promise<WSLDistro[]> => []),
    listDockerContainers: vi.fn(async (): Promise<DockerContainerInfo[]> => []),
    onRemoteConnectionLog: vi.fn(() => () => undefined),
    cancelPendingRemoteConnection: vi.fn(async () => undefined),
  },
  confirm: vi.fn(async () => true),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: ports.locale,
    intl: {
      formatMessage: ({ id }: { id: string }, values: Record<string, string> = {}) => {
        const messages: Record<string, string> = ports.locale === "zh-CN" ? zhCN : enUS;
        return (messages[id] ?? id).replace(/\{(\w+)\}/gu, (_, key) => values[key] ?? `{${key}}`);
      },
    },
  }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ ...ports, sourceServerManagementService: ports.management }),
  useOptionalBaseWorkspaceServices: () => ({
    ...ports,
    sourceServerManagementService: ports.management,
  }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ports.platform,
  useOptionalPlatform: () => ports.platform,
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => ports.confirm }));

import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

beforeEach(() => {
  vi.clearAllMocks();
  useConfirmDialogStore.setState({ pendingRequest: undefined });
  ports.settingService.update.mockReset().mockResolvedValue(undefined);
  ports.settingService.get
    .mockReset()
    .mockResolvedValue({ remoteBoundaryIntroAcknowledgedVersion: 1 });
  ports.confirm.mockReset().mockResolvedValue(true);
  ports.credentialService.load.mockResolvedValue(null);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.unstubAllEnvs();
  ports.platform.isLocalDevelopmentRuntime = true;
  ports.platform.isDockerAvailable.mockResolvedValue(true);
  ports.locale = "zh-CN";
  ports.platform.listSSHConfigAliases.mockResolvedValue([]);
  ports.platform.listWSLDistros.mockResolvedValue([]);
  ports.platform.listDockerContainers.mockResolvedValue([]);
  ports.snapshot = {
    generation: 1,
    servers: [],
    profiles: [],
    states: [],
    workspaceHistory: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
  ports.management.getSnapshot.mockImplementation(async () => ports.snapshot);
  ports.management.confirmIdentityChange.mockImplementation(async () => ports.snapshot);
  useRemoteWorkspaceSessionStore.setState({ sessionsById: {} });
});
afterEach(cleanup);

vi.mock("@/lib/userActionTelemetry.js", () => ({ startUserAction: () => ports.trace }));
import {
  useRemoteConnectionFlow,
  type RemoteConnectionFlowOptions,
} from "@/remote-connection-flow/index.js";
import { RemoteConnectionSettingsStep } from "@/RemoteConnectionDialogContent.js";
import { RemoteConnectionConnectingStep } from "@/remote-connection/RemoteConnectionConnectingStep.js";
import { requestRemoteProjectConnection } from "@/remote-connection-flow/contract.js";
import { requestRetainedRemoteProjectConnection } from "@/project-sidebar/remote-project-connection.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";

const targetA = { kind: "docker" as const, container: "a" };
function defaults(extra: Partial<RemoteConnectionFlowOptions> = {}): RemoteConnectionFlowOptions {
  return {
    open: true,
    onConnect: vi.fn(async () => "session-a"),
    onSelectProject: vi.fn(async () => undefined),
    onCancelSession: vi.fn(async () => undefined),
    ...extra,
  };
}
async function drain() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

const upgradeFailure = {
  code: "source-server-upgrade-required",
  message: "Source Server 3.14.0 must be upgraded to at least 3.15.0",
};

const wslInputs = [
  { kind: "wsl" },
  { kind: "wsl", distro: "Ubuntu" },
  { kind: "wsl", user: "dev" },
  { kind: "wsl", distro: "Ubuntu", user: "dev" },
] as const;
const resolvedWslTarget = { kind: "wsl", distro: "Ubuntu", user: "dev" } as const;
const wslProfileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const wslInstallPreview = {
  version: "3.15.1",
  sizeBytes: 1048576,
  installPath: "/home/dev/.zcode/server",
};
const wslInstallFailure = {
  code: "source-server-install-required",
  message: "install required",
  profileId: wslProfileId,
  resolvedWslTarget,
};

function prepareWslInstall() {
  ports.snapshot.profiles = [
    { profileId: wslProfileId, transport: "wsl", target: resolvedWslTarget, createdAt: 1 },
  ];
  ports.snapshot.states = [
    {
      profileId: wslProfileId,
      state: "needs-install",
      installPreview: wslInstallPreview,
      updatedAt: 1,
    },
  ];
}

it.each(
  wslInputs.flatMap((target) => ["connection", "handoff"].map((entry) => ({ target, entry }))),
)("WSL 安装绑定实际身份：$entry $target", async ({ target, entry }) => {
  prepareWslInstall();
  let now = 0;
  let systemIdentity = { distro: "Ubuntu", user: "dev" };
  const resolve = createCanonicalWslTargetResolver({
    now: () => now,
    createBackend: (input) => ({
      resolveIdentity: async () => ({
        distro: input.distro ?? systemIdentity.distro,
        user: input.user ?? systemIdentity.user,
      }),
      dispose() {},
    }),
  });
  const resolved: unknown[] = [];
  const onConnect = vi.fn<RemoteConnectionFlowOptions["onConnect"]>(async (input, _id, context) => {
    resolved.push(await resolve(input as typeof target));
    if (!context?.confirmSourceServerInstall)
      throw Object.assign(new Error(wslInstallFailure.message), wslInstallFailure);
    return "session-a";
  });
  const props = defaults({
    isWindowsDesktop: true,
    onConnect,
    preferredDirectoryPath: "/repo",
    ...(entry === "handoff" ? { preferredTarget: target, initialFailure: wslInstallFailure } : {}),
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  if (entry === "connection") act(() => result.current.selectionStep.onSelectTarget(target));
  await waitFor(() => expect(result.current.connectingStep.installConfirmation).toBeDefined());
  expect(result.current.connectingStep.installConfirmation?.target).toEqual(resolvedWslTarget);
  // 原项目交接先建立安装确认，预览由异步快照补齐；等待预览就绪，避免提前断言造成竞态。
  await waitFor(() =>
    expect(result.current.connectingStep.installConfirmation?.preview).toEqual(wslInstallPreview),
  );
  render(createElement(RemoteConnectionConnectingStep, result.current.connectingStep));
  expect(screen.getByText("WSL · Ubuntu · dev")).toBeTruthy();
  // 超过已有发现缓存时间并改变系统默认值，确认仍须使用等待时已解析的目标。
  now = 6000;
  systemIdentity = { distro: "Debian", user: "other" };
  await act(async () => result.current.connectingStep.installConfirmation!.onConfirm());
  if (entry === "handoff")
    await waitFor(() =>
      expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/repo", undefined),
    );
  expect(onConnect.mock.lastCall?.[0]).toEqual(resolvedWslTarget);
  expect(onConnect.mock.lastCall?.[2]).toEqual({ confirmSourceServerInstall: true });
  expect(resolved.at(-1)).toEqual(resolvedWslTarget);
});

it.each(wslInputs)("WSL 安装预览失败仍确认同一实际目标：%j", async (target) => {
  const onConnect = vi.fn<RemoteConnectionFlowOptions["onConnect"]>(async () => {
    ports.management.getSnapshot.mockRejectedValue(new Error("preview unavailable"));
    throw Object.assign(new Error(wslInstallFailure.message), wslInstallFailure);
  });
  const { result } = renderHook(() =>
    useRemoteConnectionFlow(defaults({ isWindowsDesktop: true, onConnect })),
  );
  act(() => result.current.selectionStep.onSelectTarget(target));
  await waitFor(() => expect(result.current.connectingStep.installConfirmation).toBeDefined());
  expect(result.current.connectingStep.installConfirmation?.target).toEqual(resolvedWslTarget);
  expect(result.current.connectingStep.installConfirmation?.preview).toBeUndefined();
  await act(async () => result.current.connectingStep.installConfirmation!.onConfirm());
  expect(onConnect.mock.lastCall?.[0]).toEqual(resolvedWslTarget);
});

it.each(wslInputs)("已保存 WSL 返回配置保留参数并清除上一线路：%j", async (target) => {
  const profile = { profileId: wslProfileId, transport: "wsl" as const, target, createdAt: 1 };
  const onConnect = vi.fn<RemoteConnectionFlowOptions["onConnect"]>(async () => {
    throw new Error("offline");
  });
  const { result } = renderHook(() =>
    useRemoteConnectionFlow(defaults({ isWindowsDesktop: true, onConnect })),
  );
  act(() => {
    result.current.settingsStep.onWslDistroChange("Previous");
    result.current.settingsStep.onWslUserChange?.("root");
    result.current.selectionStep.onSelectProfile(profile);
  });
  await waitFor(() => expect(result.current.connectingStep.rawError).toBe("offline"));
  await act(async () => result.current.connectingStep.onBack());
  expect(result.current.settingsStep.wslDistro).toBe("distro" in target ? target.distro : "");
  expect(result.current.settingsStep.wslUser).toBe("user" in target ? target.user : "");
  await act(async () => result.current.settingsStep.onConnect());
  expect(onConnect.mock.calls).toHaveLength(2);
  expect(onConnect.mock.lastCall?.[0]).toEqual({
    ...target,
    distro: "distro" in target ? target.distro : undefined,
  });
});

it("WSL 安装快照迟到时取消不复活旧目标", async () => {
  prepareWslInstall();
  const snapshot = Promise.withResolvers<SourceServerManagementSnapshot>();
  const read = vi.fn(() => snapshot.promise);
  const onConnect = vi.fn<RemoteConnectionFlowOptions["onConnect"]>(async () => {
    throw Object.assign(new Error(wslInstallFailure.message), wslInstallFailure);
  });
  const props = defaults({ isWindowsDesktop: true, openIntentId: 1, onConnect });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  ports.management.getSnapshot.mockImplementation((options?: unknown) =>
    options === undefined ? read() : Promise.resolve(ports.snapshot),
  );
  act(() => result.current.selectionStep.onSelectTarget({ kind: "wsl" }));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  act(() => result.current.connectingStep.onCancelConnection?.());
  await act(async () => snapshot.resolve(ports.snapshot));
  expect(result.current.connectingStep.installConfirmation).toBeUndefined();
  expect(result.current.connectingStep.target).not.toEqual(resolvedWslTarget);
  expect(onConnect).toHaveBeenCalledOnce();
});

it.each(wslInputs)("WSL 安装等待返回配置后旧确认失效：%j", async (target) => {
  prepareWslInstall();
  const onConnect = vi
    .fn<RemoteConnectionFlowOptions["onConnect"]>()
    .mockRejectedValueOnce(Object.assign(new Error(wslInstallFailure.message), wslInstallFailure))
    .mockRejectedValue(new Error("new target offline"));
  const { result } = renderHook(() =>
    useRemoteConnectionFlow(defaults({ isWindowsDesktop: true, onConnect })),
  );
  act(() => result.current.selectionStep.onSelectTarget(target));
  await waitFor(() => expect(result.current.connectingStep.installConfirmation).toBeDefined());
  const oldConfirmation = result.current.connectingStep.installConfirmation!;
  await act(async () => result.current.connectingStep.onBack());
  expect(result.current.connectingStep.installConfirmation).toBeUndefined();
  expect(result.current.settingsStep.wslDistro).toBe("Ubuntu");
  expect(result.current.settingsStep.wslUser).toBe("dev");
  await act(async () => oldConfirmation.onConfirm());
  expect(onConnect).toHaveBeenCalledOnce();
  act(() => {
    result.current.settingsStep.onWslDistroChange("Debian");
    result.current.settingsStep.onWslUserChange?.("other");
  });
  await act(async () => result.current.settingsStep.onConnect());
  expect(onConnect.mock.lastCall?.[0]).toEqual({ kind: "wsl", distro: "Debian", user: "other" });
  expect(result.current.connectingStep.installConfirmation).toBeUndefined();
});

it.each([undefined, "Ubuntu"])(
  "WSL 省略用户（发行版 %s）按 Host Profile 自动更新且按钮可重试",
  async (distro) => {
    const target = { kind: "wsl" as const, ...(distro ? { distro } : {}) };
    const actual = { kind: "wsl" as const, distro: "Ubuntu", user: "dev" };
    const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
    ports.snapshot.profiles = [
      { profileId, transport: "wsl", target: actual, createdAt: 1 },
      {
        profileId: "other-user",
        transport: "wsl",
        target: { ...actual, user: "root" },
        createdAt: 2,
      },
    ];
    ports.snapshot.states = ports.snapshot.profiles.map((profile, index) => ({
      profileId: profile.profileId,
      state: "needs-upgrade",
      updateAvailability: "required",
      upgradeTarget: "server",
      updatedAt: index + 1,
    }));
    ports.management.updateSource.mockResolvedValue(ports.snapshot);
    const onConnect = vi.fn<RemoteConnectionFlowOptions["onConnect"]>(async () => {
      throw Object.assign(new Error(upgradeFailure.message), upgradeFailure, {
        profileId,
        resolvedWslTarget: { kind: "wsl", distro: "Ubuntu", user: "dev" },
      });
    });
    const { result } = renderHook(() => useRemoteConnectionFlow(defaults({ onConnect })));
    act(() => result.current.selectionStep.onSelectTarget(target));
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.connectingStep.loading).toBe(false));
    expect(ports.management.updateSource.mock.calls).toEqual([
      [{ profileId, expectedTarget: actual, force: false }],
    ]);
    expect(onConnect.mock.calls[1]?.[0]).toEqual(actual);
    render(createElement(RemoteConnectionConnectingStep, result.current.connectingStep));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "更新远端" })));
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(3));
    expect(ports.management.updateSource.mock.calls).toEqual([
      [{ profileId, expectedTarget: actual, force: false }],
      [{ profileId, expectedTarget: actual, force: false }],
    ]);
  },
);

it.each(["removed", "controller", "canceled"])(
  "WSL 升级 Profile %s 时不更新其他线路",
  async (scenario) => {
    const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
    const target = { kind: "wsl" as const, distro: "Ubuntu" };
    ports.snapshot.profiles = [
      { profileId, transport: "wsl", target: { ...target, user: "dev" }, createdAt: 1 },
    ];
    ports.snapshot.states = [
      {
        profileId,
        state: "needs-upgrade",
        updateAvailability: "required",
        upgradeTarget: "controller",
        updatedAt: 1,
      },
    ];
    if (scenario === "removed") ports.snapshot.profiles = [];
    let release!: () => void;
    ports.management.getSnapshot.mockImplementation(async (options?: unknown) => {
      if (scenario === "canceled" && options === undefined)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return ports.snapshot;
    });
    const onConnect = vi.fn<RemoteConnectionFlowOptions["onConnect"]>(async () => {
      throw Object.assign(new Error(upgradeFailure.message), upgradeFailure, {
        profileId,
        resolvedWslTarget: { kind: "wsl", distro: "Ubuntu", user: "dev" },
      });
    });
    const { result } = renderHook(() => useRemoteConnectionFlow(defaults({ onConnect })));
    act(() => result.current.selectionStep.onSelectTarget(target));
    if (scenario === "canceled") {
      await waitFor(() => expect(release).toBeDefined());
      act(() => result.current.connectingStep.onCancelConnection?.());
      await act(async () => release());
      expect(result.current.connectingStep.cancelled).toBe(true);
    } else {
      await waitFor(() => expect(result.current.connectingStep.loading).toBe(false));
      render(createElement(RemoteConnectionConnectingStep, result.current.connectingStep));
      expect(screen.queryByRole("button", { name: "更新远端" })).toBeNull();
      if (scenario === "controller")
        expect(result.current.connectingStep.upgradeTarget).toBe("controller");
      else expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    }
    expect(ports.management.updateSource).not.toHaveBeenCalled();
  },
);
function prepareProjectUpgrade() {
  const target = { kind: "ssh" as const, host: "example.com", username: "dev", port: 22 };
  ports.snapshot.profiles = [
    {
      profileId: "project-profile",
      transport: "ssh",
      target: { ...target, passwordCredentialKey: "project-password" },
      createdAt: 1,
    },
  ];
  ports.snapshot.states = [
    {
      profileId: "project-profile",
      state: "needs-upgrade",
      updateAvailability: "required",
      upgradeTarget: "server",
      errorCode: upgradeFailure.code,
      updatedAt: 1,
    },
  ];
  ports.credentialService.load.mockResolvedValue("fixture-password");
  ports.management.updateSource.mockImplementation(async () => ports.snapshot);
  return defaults({
    preferredProfileId: "project-profile",
    preferredDirectoryPath: "/repo-b",
    initialFailure: upgradeFailure,
  });
}

it.each(["fresh", "pending"])("原项目 %s 升级交接自动更新一次并恢复原目录", async (entry) => {
  const props = prepareProjectUpgrade();
  const openWizard = vi.fn();
  await requestRemoteProjectConnection({
    preference: {
      preferredProfileId: props.preferredProfileId,
      preferredDirectoryPath: props.preferredDirectoryPath,
    },
    presentation: resolveRemoteConnectionPresentation(
      entry === "pending" ? ports.snapshot.states[0]! : {},
    ),
    failure: upgradeFailure,
    reconnect: async () => {
      throw Object.assign(new Error(upgradeFailure.message), upgradeFailure);
    },
    openWizard,
  });
  renderHook(() => useRemoteConnectionFlow({ ...props, ...openWizard.mock.calls[0]![0] }));
  await waitFor(() =>
    expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/repo-b", undefined),
  );
  expect(ports.management.updateSource.mock.calls).toEqual([
    [
      {
        profileId: "project-profile",
        expectedTarget: { kind: "ssh", host: "example.com", username: "dev", port: 22 },
        force: false,
      },
    ],
  ]);
  expect(props.onConnect).toHaveBeenCalledTimes(1);
});

it.each(["handoff", "connection"])("%s 升级快照失败后可显式重试并恢复原目录", async (entry) => {
  const props = prepareProjectUpgrade();
  if (entry === "connection") props.initialFailure = undefined;
  props.onConnect = vi.fn(async () => {
    if (!ports.management.updateSource.mock.calls.length) {
      throw Object.assign(new Error(upgradeFailure.message), upgradeFailure);
    }
    return "session-a";
  });
  let failSnapshot = true;
  ports.management.getSnapshot.mockImplementation(async (options?: unknown) => {
    if (options === undefined && failSnapshot) {
      failSnapshot = false;
      throw new Error("snapshot temporarily unavailable");
    }
    return ports.snapshot;
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await waitFor(() =>
    expect(result.current.connectingStep.rawError).toBe("snapshot temporarily unavailable"),
  );
  expect(result.current.connectingStep.loading).toBe(false);
  expect(ports.management.updateSource).not.toHaveBeenCalled();
  expect(props.onSelectProject).not.toHaveBeenCalled();
  render(createElement(RemoteConnectionConnectingStep, result.current.connectingStep));
  expect(screen.queryByRole("button", { name: "更新远端" })).toBeNull();
  const retry = screen.getByRole("button", { name: "重试" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  fireEvent.click(retry);
  await waitFor(() =>
    expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/repo-b", undefined),
  );
  expect(ports.management.updateSource.mock.calls).toEqual([
    [
      {
        profileId: "project-profile",
        expectedTarget: { kind: "ssh", host: "example.com", username: "dev", port: 22 },
        force: false,
      },
    ],
  ]);
});

it("取消后晚到的升级快照异常不覆盖取消状态", async () => {
  const props = prepareProjectUpgrade();
  let rejectSnapshot: ((error: Error) => void) | undefined;
  ports.management.getSnapshot.mockImplementation(async (options?: unknown) => {
    if (options !== undefined) return ports.snapshot;
    return new Promise<SourceServerManagementSnapshot>((_, reject) => {
      rejectSnapshot = reject;
    });
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await waitFor(() => expect(rejectSnapshot).toBeDefined());
  act(() => result.current.connectingStep.onCancelConnection());
  await act(async () => rejectSnapshot!(new Error("late snapshot failure")));
  expect(result.current.connectingStep.cancelled).toBe(true);
  expect(result.current.connectingStep.rawError).toBeUndefined();
  expect(result.current.connectingStep.errorMessage).toBe("");
  expect(result.current.connectingStep.loading).toBe(false);
  expect(ports.management.updateSource).not.toHaveBeenCalled();
  expect(props.onConnect).not.toHaveBeenCalled();
});

it.each(["cancel", "confirm"])("原项目自动更新遇到运行任务后等待 %s", async (decision) => {
  const props = prepareProjectUpgrade();
  ports.management.updateSource.mockRejectedValueOnce(
    Object.assign(new Error("tasks active"), { code: "source-server-update-running-tasks" }),
  );
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await waitFor(() => expect(result.current.connectingStep.forceUpdate).toBeDefined());
  expect(ports.management.updateSource.mock.calls).toEqual([
    [
      {
        profileId: "project-profile",
        expectedTarget: { kind: "ssh", host: "example.com", username: "dev", port: 22 },
        force: false,
      },
    ],
  ]);
  expect(props.onConnect).not.toHaveBeenCalled();
  act(() => {
    if (decision === "cancel") result.current.connectingStep.forceUpdate!.onCancel();
    else result.current.connectingStep.forceUpdate!.onConfirm();
  });
  await drain();
  if (decision === "cancel") {
    expect(ports.management.updateSource).toHaveBeenCalledTimes(1);
    expect(props.onConnect).not.toHaveBeenCalled();
  } else {
    await waitFor(() => expect(props.onSelectProject).toHaveBeenCalledTimes(1));
    expect(ports.management.updateSource.mock.calls[1]).toEqual([
      {
        profileId: "project-profile",
        expectedTarget: { kind: "ssh", host: "example.com", username: "dev", port: 22 },
        force: true,
      },
    ]);
  }
});

it("取消原项目更新后晚到的成功结果不恢复旧项目", async () => {
  const props = prepareProjectUpgrade();
  let finish!: (snapshot: SourceServerManagementSnapshot) => void;
  ports.management.updateSource.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await waitFor(() => expect(ports.management.updateSource).toHaveBeenCalledTimes(1));
  act(() => result.current.connectingStep.onCancelConnection());
  await act(async () => finish(ports.snapshot));
  expect(props.onConnect).not.toHaveBeenCalled();
  expect(props.onSelectProject).not.toHaveBeenCalled();
  expect(result.current.connectingStep.cancelled).toBe(true);
  expect(result.current.connectingStep.loading).toBe(false);
});

it("原项目更新后仍不兼容不循环，收起恢复不再次更新", async () => {
  const props = prepareProjectUpgrade();
  props.onConnect = vi.fn(async () => {
    throw Object.assign(new Error(upgradeFailure.message), upgradeFailure);
  });
  const { result, rerender } = renderHook((p) => useRemoteConnectionFlow(p), {
    initialProps: props,
  });
  await waitFor(() => expect(props.onConnect).toHaveBeenCalledTimes(1));
  await drain();
  expect(result.current.connectingStep.upgradeRequired).toBe(true);
  act(() => result.current.header.onMinimize());
  rerender({ ...props, open: false });
  rerender({ ...props, open: true });
  await drain();
  expect(ports.management.updateSource).toHaveBeenCalledTimes(1);
  expect(props.onConnect).toHaveBeenCalledTimes(1);
});

it("原项目更新失败保留原因与更新入口，不继续绑定目录", async () => {
  const props = prepareProjectUpgrade();
  ports.management.updateSource.mockRejectedValue(new Error("archive unavailable"));
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await waitFor(() => expect(result.current.connectingStep.rawError).toBe("archive unavailable"));
  expect(result.current.connectingStep.upgradeRequired).toBe(true);
  expect(ports.management.updateSource).toHaveBeenCalledTimes(1);
  expect(props.onConnect).not.toHaveBeenCalled();
});

it.each(["controller", "ordinary-failure"])("%s 交接不自动更新或重新拨号", async (reason) => {
  const props = prepareProjectUpgrade();
  if (reason === "controller") ports.snapshot.states[0]!.upgradeTarget = "controller";
  else props.initialFailure = { code: "remote-host-unreachable", message: "offline" };
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await waitFor(() =>
    expect(result.current.connectingStep.rawError).toBe(props.initialFailure!.message),
  );
  await drain();
  expect(result.current.connectingStep.upgradeRequired).toBe(false);
  expect(ports.management.updateSource).not.toHaveBeenCalled();
  expect(props.onConnect).not.toHaveBeenCalled();
});
it("失败收起保留后台操作门禁，恢复仍保留错误", async () => {
  const active = vi.fn();
  let reject!: (error: Error) => void;
  const props = defaults({
    onFlowActiveChange: active,
    onConnect: vi.fn(
      () =>
        new Promise<string>((_, r) => {
          reject = r;
        }),
    ),
  });
  const { result, rerender } = renderHook((p) => useRemoteConnectionFlow(p), {
    initialProps: props,
  });
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  act(() => result.current.header.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => {
    reject(new Error("intent A failed"));
  });
  expect(result.current.connectingStep.errorMessage).not.toBe("");
  expect(active.mock.lastCall?.[0]).toBe(true);
  rerender({ ...props, open: true });
  await drain();
  expect(result.current.connectingStep.rawError).toBe("intent A failed");
});
it("新的入口标识重新消费同一已编辑 Profile", async () => {
  ports.snapshot.profiles = [
    { profileId: "a", transport: "docker", displayName: "A", target: targetA, createdAt: 1 },
  ];
  const onConnect = vi.fn<RemoteConnectionFlowOptions["onConnect"]>(async () => {
    throw new Error("target failed");
  });
  const props = defaults({ onConnect, preferredProfileId: "a", openIntentId: 1 });
  const { result, rerender } = renderHook((p) => useRemoteConnectionFlow(p), {
    initialProps: props,
  });
  await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
  await drain();
  act(() => result.current.header.onMinimize());
  rerender({ ...props, open: false });
  await drain();
  ports.snapshot = {
    ...ports.snapshot,
    generation: 2,
    profiles: [
      { ...ports.snapshot.profiles[0]!, target: { kind: "docker", container: "edited-a" } },
    ],
  };
  rerender({ ...props, open: true, openIntentId: 2 });
  await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2));
  expect(onConnect.mock.calls[1]?.[0]).toMatchObject({ container: "edited-a" });
});
it("空闲流程接受无偏好的新入口并清除旧失败", async () => {
  const props = defaults({
    onConnect: vi.fn(async () => {
      throw new Error("target failed");
    }),
    openIntentId: 1,
  });
  const { result, rerender } = renderHook((p) => useRemoteConnectionFlow(p), {
    initialProps: props,
  });
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await drain();
  act(() => result.current.header.onMinimize());
  rerender({ ...props, open: false });
  await drain();
  rerender({ ...props, open: true, openIntentId: 2 });
  await drain();
  expect(result.current.currentStep).toBe("device");
  expect(result.current.error).toBe("");
});
it("WSL 成功收尾后重复入口仍应用同一发行版", async () => {
  const props = defaults({
    preferredKind: "wsl",
    preferredWslDistro: "Ubuntu",
    isWindowsDesktop: true,
  });
  const { result, rerender } = renderHook((p) => useRemoteConnectionFlow(p), {
    initialProps: props,
  });
  await drain();
  expect(result.current.currentStep).toBe("settings");
  act(() => result.current.settingsStep.onConnect());
  await drain();
  expect(result.current.currentStep).toBe("directory");
  await act(async () => {
    await result.current.directoryStep.onSelect("/srv/test");
  });
  rerender({ ...props, open: false });
  await drain();
  rerender({ ...props, open: true });
  await drain();
  expect(result.current.currentStep).toBe("settings");
  expect(result.current.settingsStep.wslDistro).toBe("Ubuntu");
});
it("主动取消立即结算 trace，迟到拒绝不重复结算", async () => {
  let reject!: (error: Error) => void;
  const props = defaults({
    onConnect: vi.fn(
      () =>
        new Promise<string>((_, r) => {
          reject = r;
        }),
    ),
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  act(() => result.current.connectingStep.onCancelConnection());
  expect(ports.trace.cancel).toHaveBeenCalledTimes(1);
  await act(async () => {
    reject(Object.assign(new Error("cancelled"), { code: "remote-connection-canceled" }));
  });
  expect(ports.trace.cancel).toHaveBeenCalledTimes(1);
  expect(ports.trace.complete).not.toHaveBeenCalled();
  expect(ports.trace.fail).not.toHaveBeenCalled();
});
it("失败页脚提供关闭与返回列表，不改写失败为取消", async () => {
  const onOpenChange = vi.fn();
  const props = defaults({
    onOpenChange,
    onConnect: vi.fn(async () => {
      throw new Error("target failed");
    }),
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await drain();
  render(createElement(RemoteConnectionConnectingStep, result.current.connectingStep));
  expect(screen.queryByRole("button", { name: "取消连接" })).toBeNull();
  expect(screen.getByRole("button", { name: "返回列表" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await drain();
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  expect(result.current.connectingStep.cancelled).toBe(false);
});
it("安装预览快照失败仍保留安装确认", async () => {
  const props = defaults({
    onConnect: vi.fn(async () => {
      ports.management.getSnapshot.mockRejectedValue(new Error("snapshot unavailable"));
      throw Object.assign(new Error("install required"), {
        code: "source-server-install-required",
      });
    }),
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await drain();
  expect(result.current.connectingStep.installConfirmation?.target).toMatchObject(targetA);
  expect(result.current.connectingStep.installConfirmation?.preview).toBeUndefined();
  expect(result.current.error).toBe("");
});
it("强制更新任务清单读取失败仍要求明确确认", async () => {
  ports.snapshot.profiles = [
    { profileId: "a", transport: "docker", target: targetA, createdAt: 1 },
  ];
  ports.snapshot.states = [
    {
      profileId: "a",
      state: "needs-upgrade",
      updateAvailability: "required",
      updatedAt: 1,
      errorCode: "source-server-upgrade-required",
      upgradeTarget: "server",
    },
  ];
  ports.management.updateSource.mockImplementation(async () => {
    ports.management.getSnapshot.mockRejectedValue(new Error("task snapshot unavailable"));
    throw Object.assign(new Error("tasks active"), { code: "source-server-update-running-tasks" });
  });
  const props = defaults({
    preferredProfileId: "a",
    onConnect: vi.fn(async () => {
      throw Object.assign(new Error("upgrade required"), {
        code: "source-server-upgrade-required",
      });
    }),
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await waitFor(() => expect(result.current.connectingStep.forceUpdate).toBeDefined());
  expect(result.current.connectingStep.forceUpdate?.tasks).toBeUndefined();
  expect(ports.management.updateSource).toHaveBeenCalledTimes(1);
  expect(ports.management.updateSource).toHaveBeenCalledWith({
    profileId: "a",
    expectedTarget: targetA,
    force: false,
  });
  act(() => result.current.connectingStep.forceUpdate?.onCancel());
  await drain();
  expect(ports.management.updateSource).toHaveBeenCalledTimes(1);
});
it("新目标替换旧安装等待，失败时不能确认安装旧设备", async () => {
  const onConnect = vi
    .fn<RemoteConnectionFlowOptions["onConnect"]>()
    .mockRejectedValueOnce(
      Object.assign(new Error("A needs install"), { code: "source-server-install-required" }),
    )
    .mockRejectedValue(new Error("B failed"));
  const props = defaults({ onConnect, openIntentId: 1 });
  const { result, rerender } = renderHook((p) => useRemoteConnectionFlow(p), {
    initialProps: props,
  });
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await drain();
  expect(result.current.connectingStep.installConfirmation?.target).toMatchObject(targetA);
  act(() => result.current.header.onMinimize());
  rerender({ ...props, open: false });
  await drain();
  rerender({
    ...props,
    open: true,
    openIntentId: 2,
    preferredTarget: { kind: "docker", container: "b" },
  });
  await drain();
  act(() => result.current.settingsStep.onConnect());
  await drain();
  expect(result.current.connectingStep.target).toMatchObject({ container: "b" });
  expect(result.current.connectingStep.installConfirmation).toBeUndefined();
});

it("新的 WSL 入口撤销旧 Profile 的迟到凭据读取", async () => {
  let resolveCredential!: (value: string) => void;
  ports.credentialService.load.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        resolveCredential = resolve;
      }),
  );
  ports.snapshot.profiles = [
    {
      profileId: "a",
      transport: "ssh",
      target: { kind: "ssh", host: "a", username: "dev", passwordCredentialKey: "secret-ref" },
      createdAt: 1,
    },
  ];
  const props = defaults({ preferredProfileId: "a", isWindowsDesktop: true, openIntentId: 1 });
  const { result, rerender } = renderHook((options) => useRemoteConnectionFlow(options), {
    initialProps: props,
  });
  await waitFor(() => expect(ports.credentialService.load).toHaveBeenCalled());
  act(() => result.current.header.onMinimize());
  rerender({ ...props, open: false });
  await drain();
  rerender({
    ...props,
    preferredProfileId: undefined,
    preferredKind: "wsl",
    preferredWslDistro: "Ubuntu",
    open: true,
    openIntentId: 2,
  });
  await drain();
  await act(async () => resolveCredential("late-secret"));
  expect(props.onConnect).not.toHaveBeenCalled();
  expect(result.current.currentStep).toBe("settings");
  expect(result.current.settingsStep.kind).toBe("wsl");
});
it("新建意图的复用提示标记在安装确认后继续传递且不进入 Host context", async () => {
  const onConnect = vi
    .fn<RemoteConnectionFlowOptions["onConnect"]>()
    .mockRejectedValueOnce(
      Object.assign(new Error("install"), { code: "source-server-install-required" }),
    )
    .mockResolvedValue("session-a");
  const { result } = renderHook(() => useRemoteConnectionFlow(defaults({ onConnect })));
  await drain();
  act(() => result.current.selectionStep.onNewConnection("docker"));
  act(() => result.current.settingsStep.onManualDockerContainerChange("manual-container"));
  act(() => result.current.settingsStep.onConnect());
  await drain();
  expect(onConnect).toHaveBeenLastCalledWith(
    { kind: "docker", container: "manual-container" },
    expect.any(String),
    undefined,
    { announceReusedConnection: true },
  );
  act(() => result.current.connectingStep.installConfirmation?.onConfirm());
  await drain();
  expect(onConnect).toHaveBeenLastCalledWith(
    { kind: "docker", container: "manual-container" },
    expect.any(String),
    { confirmSourceServerInstall: true },
    { announceReusedConnection: true },
  );
});

it("原项目安装交接确认后清除旧错误，并携带安装授权继续原目录", async () => {
  const props = prepareProjectUpgrade();
  props.initialFailure = { code: "source-server-install-required", message: "install required" };
  ports.snapshot.states = [
    {
      profileId: "project-profile",
      state: "needs-install",
      errorCode: "source-server-install-required",
      updatedAt: 1,
    },
  ];
  const connecting = Promise.withResolvers<string>();
  props.onConnect = vi.fn(() => connecting.promise);
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await waitFor(() => expect(result.current.connectingStep.installConfirmation).toBeDefined());
  act(() => result.current.connectingStep.installConfirmation!.onConfirm());
  await drain();
  expect(props.onConnect).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "ssh" }),
    expect.any(String),
    { confirmSourceServerInstall: true },
  );
  expect(result.current.error).toBe("");
  await act(async () => {
    connecting.resolve("session-a");
  });
  await waitFor(() =>
    expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/repo-b", undefined),
  );
});

it("已保存项目只交接精确 Profile，安装确认后继续原目录而非设备选目录", async () => {
  const props = prepareProjectUpgrade();
  const profile = ports.snapshot.profiles[0]!;
  ports.snapshot.profiles = [{ ...profile, sourceServerId: "source-1" }];
  ports.snapshot.servers = [
    {
      sourceServerId: "source-1",
      displayName: "dev",
      declaredWorkspaces: [],
      preferredProfileId: profile.profileId,
    },
  ];
  ports.snapshot.states = [
    {
      profileId: profile.profileId,
      sourceServerId: "source-1",
      state: "needs-install",
      errorCode: "source-server-install-required",
      updatedAt: 1,
    },
  ];
  const openWizard = vi.fn();
  await requestRetainedRemoteProjectConnection({
    workspaceKey: "remote:server:source-1:/repo-b",
    service: {
      readDirectory: async () => ({
        hosts: [{ id: "remote:server:source-1", membershipId: "m", target: profile.target }],
        entries: [{ id: "p", hostId: "remote:server:source-1", roots: [{ rootPath: "/repo-b" }] }],
      }),
      connectHost: vi.fn(),
    } as never,
    getSnapshot: async () => ports.snapshot,
    openWizard,
  });
  const preference = openWizard.mock.calls[0]![0];
  expect(preference).not.toHaveProperty("preferredSourceServerId");
  const { result } = renderHook(() => useRemoteConnectionFlow({ ...props, ...preference }));
  await waitFor(() => expect(result.current.connectingStep.installConfirmation).toBeDefined());
  expect(props.onConnect).not.toHaveBeenCalled();
  act(() => result.current.connectingStep.installConfirmation!.onConfirm());
  await waitFor(() =>
    expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/repo-b", undefined),
  );
  expect(props.onConnect).toHaveBeenCalledOnce();
  expect(props.onConnect).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "ssh" }),
    expect.any(String),
    { confirmSourceServerInstall: true },
  );
});

it.each([false, true])(
  "原项目完成被取消时不进入目录选择，仅释放新 attachment（复用=%s）",
  async (reused) => {
    const props = prepareProjectUpgrade();
    props.initialFailure = undefined;
    props.onProjectIntentCleared = vi.fn();
    props.onSelectProject = vi.fn(async () => {
      throw Object.assign(new Error("project.navigation-cancelled"), {
        code: "remote-connection-canceled",
      });
    });
    if (reused)
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: { "session-a": { sessionId: "session-a" } as never },
      });
    const { result } = renderHook(() => useRemoteConnectionFlow(props));
    await waitFor(() => expect(result.current.connectingStep.cancelled).toBe(true));
    expect(result.current.currentStep).not.toBe("directory");
    expect(props.onProjectIntentCleared).toHaveBeenCalledOnce();
    if (reused) expect(props.onCancelSession).not.toHaveBeenCalled();
    else expect(props.onCancelSession).toHaveBeenCalledWith("session-a");
  },
);

it.each([false, true])(
  "设备管理完成后关闭向导，不选目录且仅释放本次 attachment（复用=%s）",
  async (reused) => {
    if (reused)
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: {
          "session-a": { sessionId: "session-a", sourceServerId: "source-1" } as never,
        },
      });
    const onDeviceConnected = vi.fn();
    const props = defaults({
      completion: "device-management",
      onDeviceConnected,
      onOpenChange: vi.fn(),
    });
    props.onConnect = vi.fn(async () => {
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: {
          "session-a": { sessionId: "session-a", sourceServerId: "source-1" } as never,
        },
      });
      return "session-a";
    });
    const { result } = renderHook(() => useRemoteConnectionFlow(props));
    await drain();
    act(() => result.current.selectionStep.onSelectTarget(targetA));
    await waitFor(() =>
      expect(onDeviceConnected).toHaveBeenCalledWith("source-1", expect.any(Function)),
    );
    expect(props.onSelectProject).not.toHaveBeenCalled();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(result.current.currentStep).not.toBe("directory");
    if (reused) expect(props.onCancelSession).not.toHaveBeenCalled();
    else expect(props.onCancelSession).toHaveBeenCalledWith("session-a");
  },
);

it("设备管理取消后的迟到连接不能完成导航或关闭新界面", async () => {
  const connection = Promise.withResolvers<string>();
  const onDeviceConnected = vi.fn();
  const props = defaults({
    completion: "device-management",
    onDeviceConnected,
    onConnect: vi.fn(() => connection.promise),
    onOpenChange: vi.fn(),
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await waitFor(() => expect(props.onConnect).toHaveBeenCalled());
  await act(async () => result.current.connectingStep.onClose());
  await act(async () => connection.resolve("session-a"));
  expect(onDeviceConnected).not.toHaveBeenCalled();
  expect(props.onSelectProject).not.toHaveBeenCalled();
  expect(props.onOpenChange).toHaveBeenCalledWith(false);
  expect(props.onCancelSession).toHaveBeenCalledWith("session-a");
});

it("取消设备添加后，已失效的安装确认不能重新连接", async () => {
  const props = defaults({
    completion: "device-management",
    onDeviceConnected: vi.fn(),
    onConnect: vi.fn(async () => {
      throw Object.assign(new Error("install required"), {
        code: "source-server-install-required",
      });
    }),
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await waitFor(() => expect(result.current.connectingStep.installConfirmation).toBeDefined());
  const confirmation = result.current.connectingStep.installConfirmation!;
  act(() => confirmation.onCancel());
  await act(async () => confirmation.onConfirm());
  expect(props.onConnect).toHaveBeenCalledOnce();
  expect(result.current.connectingStep.cancelled).toBe(true);
});

it("设置新建直接进入 SSH 分类表单，切换和候选只准备配置，提交才拨号", async () => {
  const props = defaults({ completion: "device-management" });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  expect(result.current.currentStep).toBe("settings");
  expect(result.current.settingsStep.kind).toBe("ssh");
  expect(result.current.connectingStep.backToDevicesLabel).toBe("新建连接");
  expect(result.current.settingsStep.availableKinds).not.toContain("wsl");
  act(() => {
    result.current.settingsStep.onHostChange("first.example.com");
    result.current.settingsStep.onPasswordChange("first-secret");
  });
  act(() => result.current.settingsStep.onKindChange?.("ssh"));
  expect(result.current.settingsStep.password).toBe("first-secret");
  act(() => result.current.settingsStep.onKindChange?.("docker"));
  act(() => result.current.settingsStep.onDockerContainerChange("dev-container"));
  expect(props.onConnect).not.toHaveBeenCalled();
  expect(result.current.settingsStep.password).toBe("");
  act(() => result.current.settingsStep.onConnect());
  await drain();
  expect(props.onConnect).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "docker", container: "dev-container" }),
    expect.any(String),
    undefined,
  );
});

it("手动换 SSH 目标清空旧凭据，发现迟到不覆盖新目标", async () => {
  let resolveAliases!: (aliases: SSHConfigAliasOption[]) => void;
  ports.platform.listSSHConfigAliases.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveAliases = resolve;
      }),
  );
  const props = defaults({ completion: "device-management" });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  act(() => {
    result.current.settingsStep.onHostChange("first.example.com");
    result.current.settingsStep.onUsernameChange("dev");
    result.current.settingsStep.onPasswordChange("first-secret");
    result.current.settingsStep.onPrivateKeyPassphraseChange("first-passphrase");
  });
  act(() => result.current.settingsStep.onHostChange("second.example.com"));
  expect(result.current.settingsStep.password).toBe("");
  expect(result.current.settingsStep.privateKeyPassphrase).toBe("");
  await act(async () => resolveAliases([{ alias: "late", host: "late.example.com" }]));
  expect(result.current.settingsStep.host).toBe("second.example.com");
  expect(props.onConnect).not.toHaveBeenCalled();
});

it("分类表单允许发现失败时手动添加，失败与没有运行容器有不同提示", async () => {
  ports.platform.listDockerContainers.mockRejectedValue(new Error("discovery offline"));
  const props = defaults({ completion: "device-management" });
  function Settings() {
    const flow = useRemoteConnectionFlow(props);
    return createElement(RemoteConnectionSettingsStep, flow.settingsStep);
  }
  render(createElement(Settings));
  fireEvent.click(screen.getByRole("button", { name: "Docker", exact: true }));
  await screen.findAllByText(zhCN["remote.optionsLoadFailed"]);
  expect(screen.queryByText(zhCN["docker.noContainers"])).toBeNull();
  const input = screen.getByTestId("docker-container-input");
  fireEvent.change(input, { target: { value: "manual-container" } });
  expect(props.onConnect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "添加并连接" }));
  await waitFor(() => expect(props.onConnect).toHaveBeenCalled());
});

it("同一 SSH 地址去除空白不丢失凭据", async () => {
  const props = defaults({ completion: "device-management" });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  act(() => {
    result.current.settingsStep.onHostChange(" example.com ");
    result.current.settingsStep.onUsernameChange(" dev ");
    result.current.settingsStep.onPasswordChange("secret");
  });
  act(() => {
    result.current.settingsStep.onHostChange("example.com");
    result.current.settingsStep.onUsernameChange("dev");
  });
  expect(result.current.settingsStep.password).toBe("secret");
});

it("Docker 旧发现请求晚到不能清除新一轮选择", async () => {
  let resolveOld!: (containers: DockerContainerInfo[]) => void;
  ports.platform.listDockerContainers.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const { result } = renderHook(() =>
    useRemoteConnectionFlow(defaults({ completion: "device-management" })),
  );
  act(() => result.current.settingsStep.onKindChange?.("docker"));
  await drain();
  act(() => result.current.settingsStep.onKindChange?.("ssh"));
  act(() => result.current.settingsStep.onKindChange?.("docker"));
  await drain();
  act(() => result.current.settingsStep.onDockerContainerChange("new-container"));
  await act(async () => resolveOld([]));
  expect(result.current.settingsStep.dockerContainer).toBe("new-container");
});

it("已加载列表的手动刷新在切换类型后同样失效", async () => {
  let resolveRefresh!: (containers: DockerContainerInfo[]) => void;
  const props = defaults({ completion: "device-management" });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  act(() => result.current.settingsStep.onKindChange?.("docker"));
  await drain();
  ports.platform.listDockerContainers.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
  );
  act(() => result.current.settingsStep.onDockerContainersRefresh?.());
  await drain();
  act(() => result.current.settingsStep.onKindChange?.("ssh"));
  act(() => result.current.settingsStep.onKindChange?.("docker"));
  act(() => result.current.settingsStep.onDockerContainerChange("new-selection"));
  await act(async () => resolveRefresh([]));
  expect(result.current.settingsStep.dockerContainer).toBe("new-selection");
});

it("项目返回意图只在明确取消时完成，后台收起不当作取消", async () => {
  const onCancelled = vi.fn();
  const props = defaults({ completion: "device-management", onCancelled, onOpenChange: vi.fn() });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  act(() => result.current.header.onMinimize());
  expect(onCancelled).not.toHaveBeenCalled();
  await act(async () => result.current.handleOpenChange(false));
  expect(onCancelled).toHaveBeenCalledOnce();
});

it("项目返回意图在安装等待取消时完成，不接受迟到确认", async () => {
  const onCancelled = vi.fn();
  const props = defaults({
    completion: "device-management",
    onCancelled,
    onOpenChange: vi.fn(),
    onConnect: vi.fn(async () => {
      throw Object.assign(new Error("install"), { code: "source-server-install-required" });
    }),
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await waitFor(() => expect(result.current.connectingStep.installConfirmation).toBeDefined());
  const confirmation = result.current.connectingStep.installConfirmation!;
  act(() => confirmation.onCancel());
  expect(onCancelled).toHaveBeenCalledOnce();
  await act(async () => confirmation.onConfirm());
  expect(props.onConnect).toHaveBeenCalledOnce();
});

it("后台设备连接成功保留结果，只在显式继续时交付一次", async () => {
  let complete!: (id: string) => void;
  const connected = vi.fn();
  const active = vi.fn();
  const props = defaults({
    completion: "device-management",
    onDeviceConnected: connected,
    onFlowActiveChange: active,
    onConnect: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    ),
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await waitFor(() => expect(complete).toBeDefined());
  act(() => result.current.connectingStep.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => complete("session-a"));
  expect(connected).not.toHaveBeenCalled();
  expect(result.current.minimizedProgress).not.toBeNull();
  const continueOperation = result.current.minimizedProgress!.onResume;
  await act(async () => {
    continueOperation();
    continueOperation();
  });
  expect(connected).toHaveBeenCalledTimes(1);
  expect(props.onConnect).toHaveBeenCalledTimes(1);
  expect(active.mock.lastCall?.[0]).toBe(false);
});

it.each(["connecting", "completed"])(
  "普通入口重新打开后台设备连接时恢复原完成动作：%s",
  async (phase) => {
    const connection = Promise.withResolvers<string>();
    const connected = vi.fn();
    const active = vi.fn();
    const props = defaults({
      openIntentId: 1,
      completion: "device-management",
      onDeviceConnected: connected,
      onFlowActiveChange: active,
      onOpenChange: vi.fn(),
      onConnect: vi.fn(() => connection.promise),
    });
    const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
      initialProps: props,
    });
    act(() => result.current.selectionStep.onSelectTarget(targetA));
    act(() => result.current.connectingStep.onMinimize());
    rerender({ ...props, open: false });
    if (phase === "completed") await act(async () => connection.resolve("session-a"));
    const oldResume = result.current.minimizedProgress!.onResume;
    expect(active.mock.lastCall?.[0]).toBe(true);

    // Root 在活动流程中保留入口代际，只更新受控 open；不能绕过后台恢复。
    rerender({ ...props, open: true });
    if (phase === "connecting") await act(async () => connection.resolve("session-a"));
    await waitFor(() => expect(connected).toHaveBeenCalledOnce());
    await act(async () => {
      oldResume();
      oldResume();
    });
    rerender({ ...props, open: true });
    expect(connected).toHaveBeenCalledOnce();
    expect(props.onConnect).toHaveBeenCalledOnce();
    expect(props.onSelectProject).not.toHaveBeenCalled();
    expect(props.onOpenChange).toHaveBeenLastCalledWith(false);
    expect(active.mock.lastCall?.[0]).toBe(false);
    expect(result.current.minimizedProgress).toBeNull();
  },
);

it("普通入口恢复后台完成后，取消使迟到的设备校验与旧继续失效", async () => {
  const connection = Promise.withResolvers<string>();
  const validation = Promise.withResolvers<SourceServerManagementSnapshot>();
  ports.snapshot.servers = [{ sourceServerId: "source-a", displayName: "Device" } as never];
  ports.snapshot.states = [{ sourceServerId: "source-a", state: "online" } as never];
  const props = defaults({
    openIntentId: 1,
    completion: "device-management",
    onDeviceConnected: vi.fn(),
    onCancelled: vi.fn(),
    onOpenChange: vi.fn(),
    onConnect: vi.fn(async () => {
      const id = await connection.promise;
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: { [id]: { sessionId: id, sourceServerId: "source-a" } as never },
      });
      return id;
    }),
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  act(() => result.current.connectingStep.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => connection.resolve("session-a"));
  const oldResume = result.current.minimizedProgress!.onResume;
  const readSnapshot = vi.fn(() => validation.promise);
  ports.management.getSnapshot.mockImplementationOnce(readSnapshot);
  rerender({ ...props, open: true });
  await waitFor(() => expect(readSnapshot).toHaveBeenCalledOnce());
  await act(async () => result.current.handleOpenChange(false));
  await act(async () => {
    validation.resolve(ports.snapshot);
    oldResume();
  });
  expect(props.onCancelled).toHaveBeenCalledOnce();
  expect(props.onDeviceConnected).not.toHaveBeenCalled();
  expect(props.onConnect).toHaveBeenCalledOnce();
  expect(props.onOpenChange).toHaveBeenLastCalledWith(false);
});

it.each(["directory", "project"])("后台 %s 完成不导航，取消后旧继续不复活", async (kind) => {
  let complete!: (id: string) => void;
  const navigate = vi.fn(async () => {});
  const cancelled = vi.fn();
  const props = defaults({
    ...(kind === "project" ? { onConnectionReady: navigate } : { preferredDirectoryPath: "/work" }),
    onSelectProject: navigate,
    onCancelled: cancelled,
    onConnect: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    ),
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await waitFor(() => expect(complete).toBeDefined());
  act(() => result.current.connectingStep.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => complete("session-a"));
  expect(navigate).not.toHaveBeenCalled();
  const oldContinue = result.current.minimizedProgress!.onResume;
  await act(async () => result.current.handleOpenChange(false));
  expect(cancelled).toHaveBeenCalledWith(true);
  await act(async () => oldContinue());
  expect(navigate).not.toHaveBeenCalled();
  expect(props.onCancelSession).toHaveBeenCalledWith("session-a");
});

it("后台完成后设备已断开，旧继续不交付成功且保留可处理错误", async () => {
  const connection = Promise.withResolvers<string>();
  ports.snapshot.servers = [{ sourceServerId: "source-a", displayName: "Device" } as never];
  ports.snapshot.states = [{ sourceServerId: "source-a", state: "online" } as never];
  const connected = vi.fn();
  const props = defaults({
    completion: "device-management",
    onDeviceConnected: connected,
    onConnect: vi.fn(async () => {
      const id = await connection.promise;
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: { [id]: { sessionId: id, sourceServerId: "source-a" } as never },
      });
      return id;
    }),
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  act(() => result.current.connectingStep.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => connection.resolve("session-a"));
  ports.snapshot = {
    ...ports.snapshot,
    generation: 2,
    states: [{ sourceServerId: "source-a", state: "offline" } as never],
  };
  await act(async () => result.current.minimizedProgress!.onResume());
  expect(connected).not.toHaveBeenCalled();
  expect(result.current.minimizedProgress?.error).toContain("设备");
  expect(props.onConnect).toHaveBeenCalledTimes(1);
});

it.each([false, true])("后台目录取消只释放本次创建的 attachment，复用=%s", async (reused) => {
  if (reused)
    useRemoteWorkspaceSessionStore.setState({
      sessionsById: { "session-a": { sessionId: "session-a" } as never },
    });
  const connection = Promise.withResolvers<string>();
  const props = defaults({ onConnect: vi.fn(() => connection.promise) });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  act(() => result.current.connectingStep.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => connection.resolve("session-a"));
  await act(async () => result.current.handleOpenChange(false));
  if (reused) expect(props.onCancelSession).not.toHaveBeenCalled();
  else expect(props.onCancelSession).toHaveBeenCalledWith("session-a");
});

it.each([false, true])("异步确认后台设备保持入口门禁，再次收起=%s", async (minimizeAgain) => {
  const connection = Promise.withResolvers<string>();
  const validation = Promise.withResolvers<SourceServerManagementSnapshot>();
  ports.snapshot.servers = [{ sourceServerId: "source-a", displayName: "Device" } as never];
  ports.snapshot.states = [{ sourceServerId: "source-a", state: "online" } as never];
  const active = vi.fn();
  const props = defaults({
    completion: "device-management",
    onFlowActiveChange: active,
    onDeviceConnected: vi.fn(),
    onConnect: vi.fn(async () => {
      const id = await connection.promise;
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: { [id]: { sessionId: id, sourceServerId: "source-a" } as never },
      });
      return id;
    }),
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  act(() => result.current.connectingStep.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => connection.resolve("session-a"));
  ports.management.getSnapshot.mockImplementationOnce(() => validation.promise);
  act(() => result.current.minimizedProgress!.onResume());
  expect(active.mock.lastCall?.[0]).toBe(true);
  if (minimizeAgain) act(() => result.current.header.onMinimize());
  await act(async () => validation.resolve(ports.snapshot));
  if (minimizeAgain) {
    expect(props.onDeviceConnected).not.toHaveBeenCalled();
    expect(active.mock.lastCall?.[0]).toBe(true);
    await act(async () => result.current.minimizedProgress!.onResume());
  }
  expect(active.mock.lastCall?.[0]).toBe(false);
  expect(props.onDeviceConnected).toHaveBeenCalledOnce();
});

it.each(["cancel", "replace", "current"])(
  "后台继续的延迟快照失败按入口代际处理：%s",
  async (action) => {
    const connection = Promise.withResolvers<string>();
    const validation = Promise.withResolvers<SourceServerManagementSnapshot>();
    ports.snapshot.servers = [{ sourceServerId: "source-a", displayName: "Device" } as never];
    ports.snapshot.states = [{ sourceServerId: "source-a", state: "online" } as never];
    const onOpenChange = vi.fn();
    const props = defaults({
      openIntentId: 1,
      completion: "device-management",
      onOpenChange,
      onDeviceConnected: vi.fn(),
      onConnect: vi.fn(async () => {
        const id = await connection.promise;
        useRemoteWorkspaceSessionStore.setState({
          sessionsById: { [id]: { sessionId: id, sourceServerId: "source-a" } as never },
        });
        return id;
      }),
    });
    const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
      initialProps: props,
    });
    act(() => result.current.selectionStep.onSelectTarget(targetA));
    act(() => result.current.connectingStep.onMinimize());
    rerender({ ...props, open: false });
    await act(async () => connection.resolve("session-a"));
    ports.management.getSnapshot.mockImplementationOnce(() => validation.promise);
    act(() => result.current.minimizedProgress!.onResume());
    if (action === "cancel") await act(async () => result.current.handleOpenChange(false));
    if (action === "replace") {
      rerender({ ...props, openIntentId: 2 });
      await drain();
    }
    onOpenChange.mockClear();
    await act(async () => validation.reject(new Error("late resume snapshot failure")));
    if (action === "current") {
      expect(result.current.error).toContain("late resume snapshot failure");
      expect(onOpenChange).toHaveBeenCalledWith(true);
    } else {
      expect(result.current.error).not.toContain("late resume snapshot failure");
      expect(onOpenChange).not.toHaveBeenCalledWith(true);
    }
    expect(props.onDeviceConnected).not.toHaveBeenCalled();
  },
);

it.each([false, true])("首次远程介绍必须明确确认后才完成原意图（后台=%s）", async (background) => {
  ports.settingService.get.mockResolvedValue({ remoteBoundaryOnboardingVersion: 2 });
  const ack = Promise.withResolvers<boolean>();
  ports.confirm.mockImplementationOnce(() => ack.promise);
  const connected = Promise.withResolvers<string>();
  ports.snapshot.servers = [{ sourceServerId: "source-a", displayName: "Device" } as never];
  ports.snapshot.states = [{ sourceServerId: "source-a", state: "online" } as never];
  const onDeviceConnected = vi.fn();
  const props = defaults({
    completion: "device-management",
    onDeviceConnected,
    onConnect: async () => {
      const id = await connected.promise;
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: { [id]: { sessionId: id, sourceServerId: "source-a" } as never },
      });
      return id;
    },
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  if (background) {
    act(() => result.current.connectingStep.onMinimize());
    rerender({ ...props, open: false });
  }
  await act(async () => connected.resolve("session-a"));
  if (background) {
    expect(ports.confirm).not.toHaveBeenCalled();
    act(() => result.current.minimizedProgress!.onResume());
  }
  await waitFor(() =>
    expect(ports.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: "source-server-boundary",
        requiredAcknowledgement: true,
      }),
    ),
  );
  expect(ports.settingService.update).not.toHaveBeenCalled();
  expect(onDeviceConnected).not.toHaveBeenCalled();
  await act(async () => ack.resolve(true));
  await waitFor(() =>
    expect(onDeviceConnected).toHaveBeenCalledWith("source-a", expect.any(Function)),
  );
  expect(ports.settingService.update).toHaveBeenCalledWith({
    remoteBoundaryIntroAcknowledgedVersion: 1,
  });
});

import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
it.each([
  ["close", "dismiss"],
  ["close", "confirm"],
  ["back", "dismiss"],
  ["back", "confirm"],
] as const)("连接成功遇到确认框时保留完成，入口=%s，选择=%s", async (action, choice) => {
  useConfirmDialogStore.setState({ pendingRequest: undefined });
  ports.confirm.mockImplementation((payload) =>
    useConfirmDialogStore.getState().requestConfirmation(payload),
  );
  ports.settingService.get.mockResolvedValue({ remoteBoundaryOnboardingVersion: 2 });
  const connected = Promise.withResolvers<string>();
  const onFlowActiveChange = vi.fn();
  const props = defaults({
    onFlowActiveChange,
    onConnect: async () => {
      const id = await connected.promise;
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: { [id]: { sessionId: id, sourceServerId: "source-a" } as never },
      });
      return id;
    },
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  act(() =>
    action === "close" ? result.current.header.onClose() : result.current.connectingStep.onBack(),
  );
  expect(useConfirmDialogStore.getState().pendingRequest).toBeTruthy();
  await act(async () => connected.resolve("session-a"));
  await drain();
  expect(onFlowActiveChange).toHaveBeenLastCalledWith(true);
  await act(async () => useConfirmDialogStore.getState().settleChoice(choice));
  if (choice === "confirm") {
    expect(useConfirmDialogStore.getState().pendingRequest).toBeUndefined();
    expect(ports.settingService.update).not.toHaveBeenCalled();
    expect(props.onCancelSession).toHaveBeenCalledWith("session-a");
    return;
  }
  await drain();
  const pending = useConfirmDialogStore.getState().pendingRequest;
  if (pending?.intent === "source-server-boundary") {
    await act(async () => useConfirmDialogStore.getState().settleChoice("confirm"));
  }
  expect(result.current.currentStep).toBe("directory");
});
it("读取介绍状态期间收起保留结果，显式继续才介绍和交付", async () => {
  useConfirmDialogStore.setState({ pendingRequest: undefined });
  ports.confirm.mockImplementation((payload) =>
    useConfirmDialogStore.getState().requestConfirmation(payload),
  );
  const read = Promise.withResolvers<{ remoteBoundaryOnboardingVersion: number }>();
  const connected = Promise.withResolvers<string>();
  const onDeviceConnected = vi.fn();
  const props = defaults({
    completion: "device-management",
    onDeviceConnected,
    onConnect: async () => {
      const id = await connected.promise;
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: { [id]: { sessionId: id, sourceServerId: "source-a" } as never },
      });
      return id;
    },
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  await drain();
  ports.settingService.get.mockImplementation(() => read.promise);
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await act(async () => connected.resolve("session-a"));
  await drain();
  act(() => result.current.header.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => read.resolve({ remoteBoundaryOnboardingVersion: 2 }));
  await drain();
  expect(ports.confirm).not.toHaveBeenCalled();
  expect(onDeviceConnected).not.toHaveBeenCalled();
  ports.snapshot.servers = [{ sourceServerId: "source-a", displayName: "Device" } as never];
  ports.snapshot.states = [{ sourceServerId: "source-a", state: "online" } as never];
  await act(async () => result.current.minimizedProgress!.onResume());
  expect(useConfirmDialogStore.getState().pendingRequest?.intent).toBe("source-server-boundary");
  await act(async () => useConfirmDialogStore.getState().settleChoice("confirm"));
  expect(onDeviceConnected).toHaveBeenCalledExactlyOnceWith("source-a", expect.any(Function));
});

it("保存介绍确认期间收起保留结果，显式继续只交付一次", async () => {
  useConfirmDialogStore.setState({ pendingRequest: undefined });
  ports.confirm.mockImplementation((payload) =>
    useConfirmDialogStore.getState().requestConfirmation(payload),
  );
  ports.settingService.get.mockResolvedValue({ remoteBoundaryOnboardingVersion: 2 });
  const persisted = Promise.withResolvers<void>();
  ports.settingService.update.mockImplementationOnce(() => persisted.promise);
  const onDeviceConnected = vi.fn();
  const props = defaults({
    completion: "device-management",
    onDeviceConnected,
    onConnect: async () => {
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: {
          "session-a": { sessionId: "session-a", sourceServerId: "source-a" } as never,
        },
      });
      return "session-a";
    },
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await drain();
  expect(useConfirmDialogStore.getState().pendingRequest?.intent).toBe("source-server-boundary");
  await act(async () => useConfirmDialogStore.getState().settleChoice("confirm"));
  expect(ports.settingService.update).toHaveBeenCalled();
  act(() => result.current.header.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => persisted.resolve());
  await drain();
  expect(onDeviceConnected).not.toHaveBeenCalled();
  ports.settingService.get.mockResolvedValue({ remoteBoundaryIntroAcknowledgedVersion: 1 });
  ports.snapshot.servers = [{ sourceServerId: "source-a", displayName: "Device" } as never];
  ports.snapshot.states = [{ sourceServerId: "source-a", state: "online" } as never];
  const resume = result.current.minimizedProgress!.onResume;
  await act(async () => {
    resume();
    resume();
  });
  expect(onDeviceConnected).toHaveBeenCalledExactlyOnceWith("source-a", expect.any(Function));
  expect(ports.confirm).toHaveBeenCalledTimes(1);
});

it("介绍读取期间取消会释放当前独占 attachment，迟到结果不复活", async () => {
  const read = Promise.withResolvers<{ remoteBoundaryOnboardingVersion: number }>();
  const props = defaults({
    onConnect: vi.fn(async () => {
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: {
          "session-a": { sessionId: "session-a", sourceServerId: "source-a" } as never,
        },
      });
      return "session-a";
    }),
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  ports.settingService.get.mockImplementation(() => read.promise);
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await drain();
  act(() => result.current.connectingStep.onCancelConnection());
  expect(props.onCancelSession).toHaveBeenCalledExactlyOnceWith("session-a");
  await act(async () => read.resolve({ remoteBoundaryOnboardingVersion: 2 }));
  expect(ports.confirm).not.toHaveBeenCalled();
  expect(ports.settingService.update).not.toHaveBeenCalled();
  expect(result.current.connectingStep.cancelled).toBe(true);
});

const editedUpgradeTargets = [
  [
    { kind: "ssh", host: "a.example.com", username: "dev", port: 22 },
    { kind: "ssh", host: "b.example.com", username: "dev", port: 22 },
  ],
  [
    { kind: "wsl", distro: "Ubuntu", user: "dev" },
    { kind: "wsl", distro: "Ubuntu", user: "other" },
  ],
  [
    { kind: "docker", container: "a" },
    { kind: "docker", container: "b" },
  ],
] as const;
it.each(editedUpgradeTargets)(
  "升级失败 %j 后同 ID 改址不得更新或重连新目标",
  async (target, edited) => {
    const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
    ports.snapshot.profiles = [{ profileId, transport: target.kind, target, createdAt: 1 }];
    ports.snapshot.states = [
      {
        profileId,
        state: "needs-upgrade",
        upgradeTarget: "server",
        updateAvailability: "required",
        updatedAt: 1,
      },
    ];
    ports.management.updateSource.mockImplementation(async () => ports.snapshot);
    let release: (() => void) | undefined;
    let failed = false;
    ports.management.getSnapshot.mockImplementation(async (options?: unknown) => {
      if (failed && options === undefined)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return ports.snapshot;
    });
    const onConnect = vi.fn<RemoteConnectionFlowOptions["onConnect"]>(async () => {
      if (failed) throw new Error("unexpected reconnect");
      failed = true;
      throw Object.assign(new Error(upgradeFailure.message), upgradeFailure, { profileId });
    });
    const { result } = renderHook(() => useRemoteConnectionFlow(defaults({ onConnect })));
    act(() => result.current.selectionStep.onSelectTarget(target));
    await waitFor(() => expect(release).toBeDefined());
    ports.snapshot.profiles = [{ profileId, transport: edited.kind, target: edited, createdAt: 1 }];
    await act(async () => release!());
    await waitFor(() => expect(result.current.connectingStep.loading).toBe(false));
    expect(ports.management.updateSource).not.toHaveBeenCalled();
    expect(onConnect).toHaveBeenCalledOnce();
    expect(result.current.connectingStep.target).toMatchObject(target);
    render(createElement(RemoteConnectionConnectingStep, result.current.connectingStep));
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更新远端" })).toBeNull();
  },
);

it("快照校验后 Host 拒绝改址，旧升级退出且显式重试保留原目录", async () => {
  const props = prepareProjectUpgrade();
  ports.management.updateSource.mockRejectedValueOnce(
    Object.assign(new Error("target changed"), { code: "remote-target-changed" }),
  );
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await waitFor(() => expect(result.current.connectingStep.upgradeRequired).toBe(false));
  await waitFor(() => expect(result.current.connectingStep.errorMessage).toBeTruthy());
  expect(props.onConnect).not.toHaveBeenCalled();
  expect(props.onSelectProject).not.toHaveBeenCalled();
  render(createElement(RemoteConnectionConnectingStep, result.current.connectingStep));
  expect(screen.queryByRole("button", { name: "更新远端" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试" })));
  await waitFor(() =>
    expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/repo-b", undefined),
  );
  expect(props.onConnect).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "ssh", host: "example.com" }),
    expect.any(String),
    undefined,
  );
});
it("WSL 原项目升级交接保留已解析身份，不从最新 Profile 猜默认用户", async () => {
  const profileId = wslProfileId;
  ports.snapshot.profiles = [
    { profileId, transport: "wsl", target: resolvedWslTarget, createdAt: 1 },
  ];
  ports.snapshot.states = [
    {
      profileId,
      state: "needs-upgrade",
      upgradeTarget: "server",
      updateAvailability: "required",
      updatedAt: 1,
    },
  ];
  ports.management.updateSource.mockResolvedValue(ports.snapshot);
  const openWizard = vi.fn();
  await requestRemoteProjectConnection({
    preference: { preferredTarget: { kind: "wsl" }, preferredDirectoryPath: "/repo-a" },
    presentation: resolveRemoteConnectionPresentation({}),
    reconnect: async () => {
      throw Object.assign(new Error(upgradeFailure.message), upgradeFailure, {
        profileId,
        resolvedWslTarget,
      });
    },
    openWizard,
  });
  expect(openWizard.mock.calls[0]?.[0].initialFailure.resolvedWslTarget).toEqual(resolvedWslTarget);
  const props = defaults(openWizard.mock.calls[0]![0]);
  renderHook(() => useRemoteConnectionFlow(props));
  await waitFor(() =>
    expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/repo-a", undefined),
  );
  expect(ports.management.updateSource).toHaveBeenCalledWith({
    profileId,
    expectedTarget: resolvedWslTarget,
    force: false,
  });
  expect(props.onConnect).toHaveBeenCalledWith(resolvedWslTarget, expect.any(String), undefined);
});
it("WSL 升级缺少已解析身份时只提供重试", async () => {
  ports.snapshot.profiles = [
    { profileId: wslProfileId, transport: "wsl", target: resolvedWslTarget, createdAt: 1 },
  ];
  ports.snapshot.states = [
    {
      profileId: wslProfileId,
      state: "needs-upgrade",
      upgradeTarget: "server",
      updateAvailability: "required",
      updatedAt: 1,
    },
  ];
  const onConnect = vi.fn<RemoteConnectionFlowOptions["onConnect"]>(async () => {
    throw Object.assign(new Error(upgradeFailure.message), upgradeFailure, {
      profileId: wslProfileId,
    });
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(defaults({ onConnect })));
  act(() => result.current.selectionStep.onSelectTarget({ kind: "wsl" }));
  await waitFor(() => expect(result.current.connectingStep.loading).toBe(false));
  expect(ports.management.updateSource).not.toHaveBeenCalled();
  render(createElement(RemoteConnectionConnectingStep, result.current.connectingStep));
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});

it.each(editedUpgradeTargets)(
  "原项目 %j 交接前同 ID 改址，不消费新线路凭据或升级",
  async (target, edited) => {
    const profileId = wslProfileId;
    ports.snapshot.profiles = [{ profileId, transport: edited.kind, target: edited, createdAt: 1 }];
    ports.snapshot.states = [
      {
        profileId,
        state: "needs-upgrade",
        upgradeTarget: "server",
        updateAvailability: "required",
        updatedAt: 1,
      },
    ];
    ports.management.updateSource.mockResolvedValue(ports.snapshot);
    ports.credentialService.load.mockResolvedValue("new-target-secret");
    const openWizard = vi.fn();
    await requestRemoteProjectConnection({
      preference: {
        preferredProfileId: profileId,
        preferredTarget: target,
        preferredDirectoryPath: "/repo-a",
      },
      presentation: resolveRemoteConnectionPresentation({}),
      reconnect: async () => {
        throw Object.assign(new Error(upgradeFailure.message), upgradeFailure, {
          profileId,
          ...(target.kind === "wsl" ? { resolvedWslTarget: target } : {}),
        });
      },
      openWizard,
    });
    const props = defaults(openWizard.mock.calls[0]![0]);
    const { result } = renderHook(() => useRemoteConnectionFlow(props));
    await waitFor(() => expect(result.current.connectingStep.errorMessage).toBeTruthy());
    await waitFor(() => expect(result.current.connectingStep.loading).toBe(false));
    expect(ports.management.updateSource).not.toHaveBeenCalled();
    expect(props.onConnect).not.toHaveBeenCalled();
    expect(result.current.connectingStep.target).toMatchObject(target);
  },
);

it("设备完成资格读取失败保留连接错误，显式重试成功才关闭向导", async () => {
  const completion = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("membership read unavailable"))
    .mockResolvedValue(undefined);
  const props = defaults({
    completion: "device-management",
    onDeviceConnected: completion,
    onOpenChange: vi.fn(),
  });
  props.onConnect = vi.fn(async () => {
    useRemoteWorkspaceSessionStore.setState({
      sessionsById: {
        "session-a": { sessionId: "session-a", sourceServerId: "source-1" } as never,
      },
    });
    return "session-a";
  });
  const { result } = renderHook(() => useRemoteConnectionFlow(props));
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await waitFor(() =>
    expect(result.current.connectingStep.rawError).toContain("membership read unavailable"),
  );
  expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  expect(props.onSelectProject).not.toHaveBeenCalled();
  act(() => result.current.connectingStep.onRetry());
  await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  expect(completion).toHaveBeenCalledTimes(2);
});

it.each(["resolve", "reject"])(
  "取消进行中的设备完成校验后，迟到%s不恢复错误或关闭新入口",
  async (outcome) => {
    const completion = Promise.withResolvers<void>();
    const completed = vi.fn(() => completion.promise);
    const props = defaults({
      completion: "device-management",
      onDeviceConnected: completed,
      onCancelled: vi.fn(),
      onOpenChange: vi.fn(),
    });
    props.onConnect = vi.fn(async () => {
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: {
          "session-a": { sessionId: "session-a", sourceServerId: "source-1" } as never,
        },
      });
      return "session-a";
    });
    const { result } = renderHook(() => useRemoteConnectionFlow(props));
    await drain();
    act(() => result.current.selectionStep.onSelectTarget(targetA));
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
    act(() => result.current.connectingStep.onCancelConnection());
    expect(props.onCancelled).toHaveBeenCalledOnce();
    vi.mocked(props.onOpenChange!).mockClear();
    await act(async () => {
      if (outcome === "reject") completion.reject(new Error("late membership failure"));
      else completion.resolve();
    });
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(result.current.error).not.toContain("late membership failure");
  },
);

it("完成资格等待期间收起时不交付，后台就绪只在显式继续后再次完成", async () => {
  const checking = Promise.withResolvers<void>();
  const delivered = vi.fn();
  const completion = vi.fn(async (_source: string | undefined, canDeliver?: () => boolean) => {
    await checking.promise;
    if (canDeliver?.()) delivered();
  });
  const props = defaults({
    completion: "device-management",
    onDeviceConnected: completion,
    onOpenChange: vi.fn(),
  });
  props.onConnect = vi.fn(async () => {
    useRemoteWorkspaceSessionStore.setState({
      sessionsById: {
        "session-a": { sessionId: "session-a", sourceServerId: "source-1" } as never,
      },
    });
    return "session-a";
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  await waitFor(() => expect(completion).toHaveBeenCalledOnce());
  act(() => result.current.connectingStep.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => checking.resolve());
  expect(delivered).not.toHaveBeenCalled();
  await waitFor(() => expect(result.current.minimizedProgress?.ready).toBe(true));
  ports.snapshot.servers = [{ sourceServerId: "source-1", displayName: "Device" } as never];
  ports.snapshot.states = [{ sourceServerId: "source-1", state: "online" } as never];
  act(() => result.current.minimizedProgress!.onResume());
  await waitFor(() => expect(delivered).toHaveBeenCalledOnce());
  expect(completion).toHaveBeenCalledTimes(2);
});

it("后台显式继续的资格读取再次收起后失败，只更新后台错误而不抢回弹窗", async () => {
  const connection = Promise.withResolvers<string>();
  const validation = Promise.withResolvers<void>();
  const complete = vi.fn(() => validation.promise);
  const props = defaults({
    completion: "device-management",
    onDeviceConnected: complete,
    onOpenChange: vi.fn(),
    onConnect: async () => {
      const sessionId = await connection.promise;
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: { [sessionId]: { sessionId, sourceServerId: "source-1" } as never },
      });
      return sessionId;
    },
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  act(() => result.current.connectingStep.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => connection.resolve("session-a"));
  await waitFor(() => expect(result.current.minimizedProgress?.ready).toBe(true));
  ports.snapshot.servers = [{ sourceServerId: "source-1", displayName: "Device" } as never];
  ports.snapshot.states = [{ sourceServerId: "source-1", state: "online" } as never];
  rerender({ ...props, open: true });
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  act(() => result.current.connectingStep.onMinimize());
  rerender({ ...props, open: false });
  vi.mocked(props.onOpenChange!).mockClear();
  await act(async () => validation.reject(new Error("membership read while minimized")));
  expect(result.current.minimizedProgress?.error).toContain("membership read while minimized");
  expect(props.onOpenChange).not.toHaveBeenCalledWith(true);
});

it("后台显式继续在 Source 与成员校验前恢复原草稿提交门禁", async () => {
  const connection = Promise.withResolvers<string>();
  const eligibility = Promise.withResolvers<void>();
  let submissionPending = true;
  let deliveryAllowed: (() => boolean) | undefined;
  const onOpenChange = vi.fn((visible: boolean) => {
    submissionPending = visible;
  });
  const completed = vi.fn(async (_source: string | undefined, canDeliver?: () => boolean) => {
    deliveryAllowed = canDeliver;
    await eligibility.promise;
  });
  const props = defaults({
    completion: "device-management",
    onDeviceConnected: completed,
    onOpenChange,
    onConnect: async () => {
      const sessionId = await connection.promise;
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: {
          [sessionId]: { sessionId, sourceServerId: "source-1" } as never,
        },
      });
      return sessionId;
    },
  });
  const { result, rerender } = renderHook((input) => useRemoteConnectionFlow(input), {
    initialProps: props,
  });
  await drain();
  act(() => result.current.selectionStep.onSelectTarget(targetA));
  act(() => result.current.connectingStep.onMinimize());
  rerender({ ...props, open: false });
  await act(async () => connection.resolve("session-a"));
  await waitFor(() => expect(result.current.minimizedProgress?.ready).toBe(true));
  ports.snapshot.servers = [{ sourceServerId: "source-1", displayName: "Device" } as never];
  ports.snapshot.states = [{ sourceServerId: "source-1", state: "online" } as never];
  onOpenChange.mockClear();
  const sourceCheck = Promise.withResolvers<SourceServerManagementSnapshot>();
  ports.management.getSnapshot.mockImplementationOnce(() => sourceCheck.promise);
  act(() => result.current.minimizedProgress!.onResume());
  expect(submissionPending).toBe(true);
  expect(completed).not.toHaveBeenCalled();
  await act(async () => sourceCheck.resolve(ports.snapshot));
  await waitFor(() => expect(completed).toHaveBeenCalledOnce());
  expect(deliveryAllowed?.()).toBe(true);
  expect(onOpenChange).toHaveBeenCalledWith(true);
  expect(submissionPending).toBe(true);
  await act(async () => eligibility.resolve());
});
