import {
  RemoteConnectionProgressProvider,
  RemoteConnectionMinimizedProgress,
  useRemoteConnectionProgress,
} from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
function TestBackgroundProgress() {
  const progress = useRemoteConnectionProgress();
  return progress ? createElement(RemoteConnectionMinimizedProgress, progress) : null;
}
// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SourceServerManagementSnapshot,
  SSHConfigAliasOption,
  DockerContainerInfo,
  WSLDistro,
} from "@zcode/shared";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";

const ports = vi.hoisted(() => ({
  locale: "zh-CN",
  snapshot: {} as SourceServerManagementSnapshot,
  credentialService: { load: vi.fn(async () => null), save: vi.fn() },
  settingService: {
    get: vi.fn(async () => ({ remoteBoundaryIntroAcknowledgedVersion: 1 })),
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

import { RemoteConnectionDialog } from "@/SSHDialog.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

type DialogProps = ComponentProps<typeof RemoteConnectionDialog>;
function mountDialog(overrides: Partial<DialogProps> = {}) {
  const props: DialogProps = {
    open: true,
    onConnect: vi.fn(async () => "session-a"),
    onSelectProject: vi.fn(async () => undefined),
    onCancelSession: vi.fn(async () => undefined),
    ...overrides,
  };
  return { ...render(createElement(RemoteConnectionDialog, props)), props };
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe("远程连接向导用户流程", () => {
  it("缺少已保存密码时在阶段内聚焦密码，补齐后保留原目录和下载方式", async () => {
    ports.snapshot.profiles = [
      {
        profileId: "missing",
        lifecycleState: "active",
        transport: "ssh",
        displayName: "dev",
        target: {
          kind: "ssh",
          host: "dev.example.com",
          username: "dev",
          assetInstallMode: "remote-download",
          passwordCredentialKey: "saved-password",
        },
        createdAt: 1,
      },
    ];
    const { props } = mountDialog({
      preferredProfileId: "missing",
      preferredDirectoryPath: "/srv/project",
    });
    const password = await screen.findByTestId("ssh-password-input");
    expect(document.activeElement).toBe(password);
    expect(password.closest("li")).not.toBeNull();
    expect(screen.queryByTestId("remote-connection-settings-scroll")).toBeNull();
    expect(props.onConnect).not.toHaveBeenCalled();
    fireEvent.change(password, { target: { value: "replacement-password" } });
    fireEvent.click(screen.getByRole("button", { name: "建立连接" }));
    await waitFor(() =>
      expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/srv/project", undefined),
    );
    expect(props.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        password: "replacement-password",
        assetInstallMode: "remote-download",
      }),
      expect.any(String),
      undefined,
    );
  });
});

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("连接中可以取消，迟到成功只释放临时 session，不进入目录或重新打开向导", async () => {
  const connection = pending<string>();
  const { props } = mountDialog({
    preferredTarget: {
      kind: "ssh",
      host: "dev.example.com",
      username: "dev",
      privateKeyPath: "/keys/dev",
    },
    onConnect: vi.fn(() => connection.promise),
  });
  fireEvent.click(await screen.findByRole("button", { name: "建立连接" }));
  const cancel = await screen.findByRole("button", { name: "取消连接" });
  expect(cancel.hasAttribute("disabled")).toBe(false);
  fireEvent.click(cancel);
  await screen.findByText("已取消");
  expect(screen.queryByTestId("ssh-error")).toBeNull();
  expect(ports.platform.cancelPendingRemoteConnection).toHaveBeenCalledWith(expect.any(String));
  await act(async () => connection.resolve("late-session"));
  expect(props.onCancelSession).toHaveBeenCalledWith("late-session");
  expect(props.onSelectProject).not.toHaveBeenCalled();
  expect(screen.queryByTestId("ssh-success")).toBeNull();
});

it("取消安装显示已取消，并允许重新开始连接", async () => {
  const onConnect = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("install"), { code: "source-server-install-required" }),
    )
    .mockResolvedValueOnce("session-a");
  mountDialog({ preferredTarget: { kind: "docker", container: "dev" }, onConnect });
  fireEvent.click(await screen.findByRole("button", { name: "建立连接" }));
  fireEvent.click(await screen.findByRole("button", { name: "取消", exact: true }));
  await screen.findByText("已取消");
  expect(screen.queryByTestId("ssh-error")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByTestId("ssh-success");
});

const sshTarget = {
  kind: "ssh",
  host: "original.example.com",
  username: "dev",
  privateKeyPath: "/keys/dev",
  assetInstallMode: "remote-download",
} as const;
function addDockerProfile() {
  ports.snapshot.servers = [
    {
      sourceServerId: "source-a",
      displayName: "devbox",
      preferredProfileId: "docker-profile",
      declaredWorkspaces: [],
    },
  ];
  ports.snapshot.profiles = [
    {
      profileId: "docker-profile",
      sourceServerId: "source-a",
      lifecycleState: "active",
      transport: "docker",
      target: { kind: "docker", container: "dev-container" },
      displayName: "dev-line",
      createdAt: 1,
    },
  ];
}
async function clickStart() {
  fireEvent.click(await screen.findByRole("button", { name: "建立连接" }));
}
async function clickBack() {
  fireEvent.click(screen.getByRole("button", { name: "上一步", exact: true }));
}
async function closeAndReopen(
  view: ReturnType<typeof mountDialog>,
  next: Partial<DialogProps> = {},
) {
  fireEvent.click(screen.getByRole("button", { name: "关闭", exact: true }));
  await act(async () => undefined);
  view.rerender(createElement(RemoteConnectionDialog, { ...view.props, open: false }));
  view.rerender(createElement(RemoteConnectionDialog, { ...view.props, ...next }));
}
function registerSession(
  readdir: (params: {
    path: string;
  }) => Promise<import("@zcode/shared").FileEntry[]> = async () => [],
) {
  useRemoteWorkspaceSessionStore.getState().registerSession({
    sessionId: "session-a",
    target: sshTarget,
    services: {
      systemService: { info: async () => ({ homedir: "/srv/project" }) },
      fileService: { readdir },
    } as unknown as import("@zcode/services").IServiceAccessor,
  });
  HTMLElement.prototype.scrollTo = vi.fn();
}

it.each(["profile", "source"] as const)(
  "从 %s 入口沿保存连接直接进入目录，不自动选择项目",
  async (entry) => {
    addDockerProfile();
    const { props } = mountDialog(
      entry === "profile"
        ? { preferredProfileId: "docker-profile" }
        : { preferredSourceServerId: "source-a" },
    );
    await screen.findByTestId("ssh-success");
    expect(props.onConnect).toHaveBeenCalledWith(
      { kind: "docker", container: "dev-container" },
      expect.any(String),
      undefined,
    );
    expect(props.onSelectProject).not.toHaveBeenCalled();
  },
);

it("新连接成功后自动进入目录，等待用户明确选择", async () => {
  registerSession();
  const { props } = mountDialog({ preferredTarget: sshTarget });
  await clickStart();
  await screen.findByTestId("ssh-success");
  expect(props.onSelectProject).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "在此目录打开工作区", exact: true }));
  await waitFor(() =>
    expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/srv/project", undefined),
  );
});

it.each([false, true])("目录选择失败恢复可操作状态，session 被回收=%s", async (removed) => {
  registerSession();
  const selection = pending<void>();
  const { props } = mountDialog({
    preferredTarget: sshTarget,
    onSelectProject: vi.fn(() => selection.promise),
  });
  await clickStart();
  const select = await screen.findByRole("button", { name: "在此目录打开工作区", exact: true });
  await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
  fireEvent.click(select);
  expect(props.onSelectProject).toHaveBeenCalledOnce();
  if (removed) useRemoteWorkspaceSessionStore.getState().unregisterSession("session-a");
  await act(async () => selection.reject(new Error("directory admission failed")));
  await screen.findByText("directory admission failed");
  const next = await screen.findByRole("button", {
    name: removed ? "建立连接" : "在此目录打开工作区",
    exact: true,
  });
  expect(next.hasAttribute("disabled")).toBe(false);
});

it("回填、收起、恢复保留当前密码和用户选择的下载侧", async () => {
  const view = mountDialog({
    preferredTarget: { kind: "ssh", host: "a.example.com", username: "dev" },
  });
  const password = await screen.findByTestId("ssh-password-input");
  fireEvent.change(password, { target: { value: "same-target-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "高级选项" }));
  fireEvent.click(screen.getByRole("button", { name: "远端服务器下载" }));
  fireEvent.click(screen.getByRole("button", { name: /收起/u }));
  view.rerender(createElement(RemoteConnectionDialog, { ...view.props, open: false }));
  view.rerender(createElement(RemoteConnectionDialog, view.props));
  expect((screen.getByTestId("ssh-password-input") as HTMLInputElement).value).toBe(
    "same-target-secret",
  );
  await clickStart();
  await waitFor(() =>
    expect(view.props.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        password: "same-target-secret",
        assetInstallMode: "remote-download",
      }),
      expect.any(String),
      undefined,
    ),
  );
});

it.each(["target", "profile"] as const)(
  "换到另一 %s 时清空旧密码，不向新设备提交旧凭据",
  async (entry) => {
    ports.snapshot.profiles = [
      {
        profileId: "missing",
        transport: "ssh",
        target: {
          kind: "ssh",
          host: "b.example.com",
          username: "bob",
          passwordCredentialKey: "missing",
        },
        createdAt: 1,
      },
    ];
    const view = mountDialog({
      preferredTarget: { kind: "ssh", host: "a.example.com", username: "alice" },
    });
    fireEvent.change(await screen.findByTestId("ssh-password-input"), {
      target: { value: "old-secret" },
    });
    const snapshot = pending<SourceServerManagementSnapshot>();
    if (entry === "profile") ports.management.getSnapshot.mockReturnValueOnce(snapshot.promise);
    await closeAndReopen(
      view,
      entry === "target"
        ? { preferredTarget: { kind: "ssh", host: "b.example.com", username: "bob" } }
        : { preferredTarget: undefined, preferredProfileId: "missing" },
    );
    if (entry === "profile") {
      // 延后快照返回，确定性覆盖旧配置页仍在、新 Profile 尚未进入连接阶段的窗口。
      expect(screen.queryByTestId("remote-connection-stages")).toBeNull();
      expect(view.props.onConnect).not.toHaveBeenCalled();
      await act(async () => snapshot.resolve(ports.snapshot));
    }
    // 两屏复用密码框 test id；全局查询可能拿到随后卸载的旧节点，输入事件不会更新新凭据。
    // Profile 必须等待连接阶段的补凭据表单，手动 target 则继续操作配置页。
    const input =
      entry === "profile"
        ? await within(await screen.findByTestId("remote-connection-stages")).findByTestId(
            "ssh-password-input",
          )
        : await screen.findByTestId("ssh-password-input");
    expect((input as HTMLInputElement).value).toBe("");
    await clickStart();
    expect(view.props.onConnect).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "new-secret" } });
    await clickStart();
    await waitFor(() =>
      expect(view.props.onConnect).toHaveBeenCalledWith(
        expect.objectContaining({ host: "b.example.com", password: "new-secret" }),
        expect.any(String),
        undefined,
      ),
    );
  },
);

it.each(["ssh", "server"] as const)("关闭后换目标清空 %s 口令", async (kind) => {
  const target = kind === "ssh" ? sshTarget : { kind, url: "http://server-a" };
  const view = mountDialog({ preferredTarget: target });
  const selector =
    kind === "ssh" ? 'input[name="remote-ssh-private-key-passphrase"]' : 'input[type="password"]';
  await screen.findByRole("button", { name: "建立连接" });
  const input = document.querySelector<HTMLInputElement>(selector)!;
  fireEvent.change(input, { target: { value: "old-token" } });
  await closeAndReopen(view, {
    preferredTarget:
      kind === "ssh" ? { ...sshTarget, host: "new.example.com" } : { kind, url: "http://server-b" },
  });
  await screen.findByRole("button", { name: "建立连接" });
  expect(document.querySelector<HTMLInputElement>(selector)!.value).toBe("");
});

it.each([false, true])("原项目意图跨连接和安装确认保留，需安装=%s", async (install) => {
  const onConnect = vi.fn().mockResolvedValue("session-a");
  if (install)
    onConnect.mockRejectedValueOnce(
      Object.assign(new Error("install"), { code: "source-server-install-required" }),
    );
  const { props } = mountDialog({
    preferredTarget: sshTarget,
    preferredDirectoryPath: "/srv/original",
    onConnect,
  });
  await clickStart();
  if (install) fireEvent.click(await screen.findByRole("button", { name: "安装并继续" }));
  await waitFor(() =>
    expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/srv/original", undefined),
  );
  expect(onConnect).toHaveBeenLastCalledWith(
    expect.objectContaining({ assetInstallMode: "remote-download" }),
    expect.any(String),
    install ? { confirmSourceServerInstall: true } : undefined,
  );
});

it.each(["new", "saved"] as const)("主动改选 %s 连接释放旧项目意图", async (entry) => {
  addDockerProfile();
  const onProjectIntentCleared = vi.fn();
  const { props } = mountDialog({
    preferredTarget: sshTarget,
    preferredDirectoryPath: "/srv/old",
    onProjectIntentCleared,
  });
  await screen.findByRole("button", { name: "建立连接" });
  fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
  if (screen.queryByRole("button", { name: "上一步", exact: true })) await clickBack();
  if (entry === "new") {
    fireEvent.click(screen.getByRole("button", { name: "手动输入 Docker" }));
    fireEvent.change(screen.getByTestId("docker-container-input"), { target: { value: "dev" } });
    await clickStart();
  } else {
    fireEvent.click(screen.getByRole("button", { name: /devbox/ }));
  }
  await screen.findByTestId("ssh-success");
  expect(props.onSelectProject).not.toHaveBeenCalled();
  expect(onProjectIntentCleared).toHaveBeenCalledOnce();
});

it("失败流程收起后恢复原错误，不重复连接", async () => {
  addDockerProfile();
  const view = mountDialog({
    preferredProfileId: "docker-profile",
    onConnect: vi.fn(async () => {
      throw new Error("connection failed");
    }),
    onOpenChange: vi.fn(),
  });
  await screen.findByTestId("ssh-error");
  fireEvent.click(screen.getByRole("button", { name: /收起/u }));
  expect(view.props.onOpenChange).toHaveBeenCalledWith(false);
  view.rerender(createElement(RemoteConnectionDialog, { ...view.props, open: false }));
  view.rerender(createElement(RemoteConnectionDialog, view.props));
  await screen.findByTestId("ssh-error");
  expect(view.props.onConnect).toHaveBeenCalledOnce();
});

it.each(["success", "failure", "force", "force-cancel"] as const)(
  "自动更新保留连接意图并处理 %s 结果",
  async (outcome) => {
    addDockerProfile();
    ports.snapshot.states = [
      {
        profileId: "docker-profile",
        sourceServerId: "source-a",
        state: "needs-upgrade",
        upgradeTarget: "server",
        updateAvailability: "required",
        updatedAt: 1,
        runningTasks: [{ sessionId: "task-running", workspacePath: "/work/project" }],
      },
    ];
    const update = pending<SourceServerManagementSnapshot>();
    ports.management.updateSource.mockImplementation(() => update.promise);
    if (outcome.startsWith("force"))
      ports.management.updateSource.mockRejectedValueOnce(
        Object.assign(new Error("tasks running"), { code: "source-server-update-running-tasks" }),
      );
    const onConnect = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("upgrade"), { code: "source-server-upgrade-required" }),
      )
      .mockResolvedValueOnce("session-a");
    const { props } = mountDialog({
      preferredProfileId: "docker-profile",
      preferredDirectoryPath: "/srv/kept",
      onConnect,
    });
    if (outcome.startsWith("force")) {
      await screen.findByText("task-running");
      expect(screen.getByText("/work/project").closest("li")).not.toBeNull();
      expect(ports.confirm).not.toHaveBeenCalled();
      expect(ports.management.updateSource).toHaveBeenCalledTimes(1);
      if (outcome === "force-cancel") {
        fireEvent.click(screen.getAllByRole("button", { name: "取消连接" }).at(-1)!);
        await screen.findByText("已取消");
        expect(screen.queryByText("正在更新远端服务")).toBeNull();
        expect(ports.management.updateSource).toHaveBeenCalledTimes(1);
        onConnect
          .mockReset()
          .mockRejectedValueOnce(
            Object.assign(new Error("upgrade"), { code: "source-server-upgrade-required" }),
          )
          .mockResolvedValue("session-a");
        fireEvent.click(screen.getByRole("button", { name: "重试" }));
        await waitFor(() => expect(ports.management.updateSource).toHaveBeenCalledTimes(2));
        await act(async () => update.resolve({ ...ports.snapshot, generation: 2, states: [] }));
        await waitFor(() =>
          expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/srv/kept", undefined),
        );
        return;
      }
      fireEvent.click(screen.getByRole("button", { name: "强制更新" }));
    }
    await waitFor(() =>
      expect(ports.management.updateSource).toHaveBeenCalledWith({
        profileId: "docker-profile",
        expectedTarget: { kind: "docker", container: "dev-container" },
        force: outcome === "force",
      }),
    );
    await screen.findByText("正在更新远端服务");
    if (outcome === "failure") {
      await act(async () => update.reject(new Error("archive verification failed")));
      await screen.findByTestId("ssh-error");
      expect(onConnect).toHaveBeenCalledOnce();
    } else {
      await act(async () => update.resolve({ ...ports.snapshot, generation: 2, states: [] }));
      await waitFor(() =>
        expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/srv/kept", undefined),
      );
      expect(onConnect).toHaveBeenCalledTimes(2);
    }
  },
);

it.each([
  ["zh-CN", "ssh", "正在连接 SSH 主机", "已连接 SSH 主机"],
  ["zh-CN", "wsl", "正在启动并连接发行版", "已连接发行版"],
  ["zh-CN", "docker", "正在连接容器", "已连接容器"],
  ["en-US", "ssh", "Connecting to SSH host", "Connected to the SSH host"],
  ["en-US", "wsl", "Starting and connecting to distribution", "Connected to the distribution"],
  ["en-US", "docker", "Connecting to container", "Connected to the container"],
] as const)("%s 的 %s 保存连接显示对应阶段及阶段说明", async (locale, kind, title, description) => {
  ports.locale = locale;
  const target =
    kind === "ssh"
      ? sshTarget
      : kind === "wsl"
        ? { kind, distro: "Ubuntu" }
        : { kind, container: "dev" };
  ports.snapshot.profiles = [{ profileId: "profile", transport: kind, target, createdAt: 1 }];
  const onConnect = vi.fn(() => new Promise<string>(() => undefined));
  mountDialog({ preferredProfileId: "profile", isWindowsDesktop: true, onConnect });
  await waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
  await screen.findByText(title);
  const requestId = vi.mocked(onConnect).mock.calls[0] as unknown as [unknown, string];
  const listener = ports.platform.onRemoteConnectionLog.mock.calls.at(-1)?.[0] as unknown as (
    entry: unknown,
  ) => void;
  act(() =>
    listener({
      requestId: requestId[1],
      level: "info",
      message: "[source-server:identify] identified",
      timestamp: Date.now(),
    }),
  );
  await screen.findByText(description);
});

it("关闭后迟到失败不重新打开向导，凭据加载的迟到结果不拨号", async () => {
  const credential = pending<null>();
  ports.credentialService.load.mockImplementationOnce(() => credential.promise);
  ports.snapshot.profiles = [
    {
      profileId: "profile",
      transport: "ssh",
      target: {
        kind: "ssh",
        host: "dev.example.com",
        username: "dev",
        passwordCredentialKey: "pending",
      },
      createdAt: 1,
    },
  ];
  const view = mountDialog({ preferredProfileId: "profile", onOpenChange: vi.fn() });
  await waitFor(() => expect(ports.credentialService.load).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await act(async () => undefined);
  view.rerender(createElement(RemoteConnectionDialog, { ...view.props, open: false }));
  await act(async () => credential.resolve(null));
  expect(view.props.onConnect).not.toHaveBeenCalled();
  expect(view.props.onOpenChange).toHaveBeenLastCalledWith(false);
});

it("取消后立即重试，旧请求完成不清除新请求的忙碌状态", async () => {
  const first = pending<string>();
  const second = pending<string>();
  const onConnect = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  mountDialog({ preferredTarget: sshTarget, onConnect });
  await clickStart();
  fireEvent.click(await screen.findByRole("button", { name: "取消连接" }));
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await act(async () => first.reject(new Error("old failure")));
  expect(screen.getByRole("button", { name: "取消连接" }).hasAttribute("disabled")).toBe(false);
  expect(screen.queryByTestId("ssh-error")).toBeNull();
  await act(async () => second.resolve("session-a"));
  await screen.findByTestId("ssh-success");
});

it("收起进行中的流程后成功不抢前台，显式继续才展示目录", async () => {
  const connection = pending<string>();
  const onCancelSession = vi.fn();
  render(
    createElement(
      RemoteConnectionProgressProvider,
      null,
      createElement(TestBackgroundProgress),
      createElement(RemoteConnectionDialog, {
        preferredTarget: sshTarget,
        onConnect: () => connection.promise,
        onSelectProject: vi.fn(),
        onCancelSession,
      }),
    ),
  );
  fireEvent.click(screen.getByTestId("ssh-connect-trigger"));
  await clickStart();
  fireEvent.click(screen.getByRole("button", { name: /收起/u }));
  await act(async () => connection.resolve("session-a"));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(await screen.findByTestId("remote-connection-minimized"));
  await screen.findByTestId("ssh-success");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(onCancelSession).toHaveBeenCalledWith("session-a"));
});

it("取消等待中的升级快照后不能再发起更新", async () => {
  addDockerProfile();
  const snapshot = pending<SourceServerManagementSnapshot>();
  ports.management.getSnapshot
    .mockResolvedValueOnce(ports.snapshot)
    .mockImplementation(() => snapshot.promise);
  const onConnect = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("upgrade"), { code: "source-server-upgrade-required" }),
    );
  mountDialog({ preferredProfileId: "docker-profile", onConnect });
  await waitFor(() => expect(ports.management.getSnapshot).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getAllByRole("button", { name: "取消连接" }).at(-1)!);
  await act(async () =>
    snapshot.resolve({
      ...ports.snapshot,
      states: [
        {
          profileId: "docker-profile",
          state: "needs-upgrade",
          upgradeTarget: "server",
          updateAvailability: "required",
          updatedAt: 1,
        },
      ],
    }),
  );
  expect(ports.management.updateSource).not.toHaveBeenCalled();
  await screen.findByText("已取消");
});

it.each(["success", "failure"] as const)(
  "历史目录提交迟到 %s 不改变取消后的流程",
  async (outcome) => {
    const selection = pending<void>();
    const view = mountDialog({
      preferredTarget: sshTarget,
      preferredDirectoryPath: "/srv/original",
      onSelectProject: vi.fn(() => selection.promise),
    });
    await clickStart();
    await waitFor(() => expect(view.props.onSelectProject).toHaveBeenCalledOnce());
    fireEvent.click(screen.getAllByRole("button", { name: "取消连接" }).at(-1)!);
    await act(async () =>
      outcome === "success"
        ? selection.resolve()
        : selection.reject(new Error("late directory failure")),
    );
    await screen.findByText("已取消");
    expect(screen.queryByTestId("ssh-error")).toBeNull();
    expect(screen.queryByTestId("ssh-success")).toBeNull();
    if (outcome === "failure") expect(view.props.onCancelSession).toHaveBeenCalledWith("session-a");
    else expect(view.props.onCancelSession).not.toHaveBeenCalled();
  },
);

it("原目录恢复成功后结束活动流程，后续连接不被忙碌状态阻挡", async () => {
  const onFlowActiveChange = vi.fn();
  const view = mountDialog({
    preferredTarget: sshTarget,
    preferredDirectoryPath: "/srv/original",
    onFlowActiveChange,
  });
  await clickStart();
  await waitFor(() => expect(view.props.onSelectProject).toHaveBeenCalledOnce());
  await waitFor(() => expect(onFlowActiveChange).toHaveBeenLastCalledWith(false));
  view.rerender(createElement(RemoteConnectionDialog, { ...view.props, open: false }));
  view.rerender(
    createElement(RemoteConnectionDialog, {
      ...view.props,
      preferredTarget: { ...sshTarget, host: "next.example.com" },
    }),
  );
  await clickStart();
  await waitFor(() => expect(view.props.onConnect).toHaveBeenCalledTimes(2));
});

it("原地重连失败交接只展示连接屏与日志，用户重试才再次连接", async () => {
  const { props } = mountDialog({
    preferredTarget: {
      kind: "ssh",
      host: "dev.example.com",
      username: "dev",
      privateKeyPath: "/keys/dev",
    },
    preferredDirectoryPath: "/srv/project",
    initialFailure: {
      code: "remote-host-unreachable",
      message: "connect ECONNREFUSED",
      logs: [
        {
          id: "failed",
          level: "error",
          message: "E2E_RECONNECT_FAILURE_LOG",
          timestamp: "12:00:00",
        },
      ],
    },
  });
  expect(await screen.findByText("E2E_RECONNECT_FAILURE_LOG")).toBeTruthy();
  expect(props.onConnect).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "重试" }).at(-1)!);
  await waitFor(() =>
    expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/srv/project", undefined),
  );
});

it("无目录连接可稍后选择：释放临时 attachment，关闭向导而不新增项目", async () => {
  ports.snapshot.profiles = [
    {
      profileId: "later",
      lifecycleState: "active",
      transport: "docker",
      displayName: "dev",
      target: { kind: "docker", container: "dev" },
      createdAt: 1,
    },
  ];
  const { props } = mountDialog({ preferredProfileId: "later" });
  fireEvent.click(await screen.findByRole("button", { name: "稍后选择" }));
  await waitFor(() => expect(props.onCancelSession).toHaveBeenCalledWith("session-a"));
  expect(props.onSelectProject).not.toHaveBeenCalled();
  expect(ports.confirm).not.toHaveBeenCalled();
});

it("查看 A 的失败后改选 B，不能把 A 的失败或安装等待交给 B", async () => {
  const a = {
    profileId: "a",
    sourceServerId: "source-a",
    transport: "docker" as const,
    displayName: "A",
    target: { kind: "docker" as const, container: "a" },
    createdAt: 1,
  };
  const b = {
    ...a,
    sourceServerId: "source-b",
    profileId: "b",
    displayName: "B",
    target: { kind: "docker" as const, container: "b" },
  };
  ports.snapshot.profiles = [a, b];
  ports.snapshot.servers = [
    { sourceServerId: "source-b", displayName: "B", preferredProfileId: "b" },
  ];
  const { props } = mountDialog({
    preferredProfileId: "a",
    initialFailure: { code: "source-server-install-required", message: "A needs install" },
  });
  await screen.findByRole("button", { name: "安装并继续" });
  fireEvent.click(screen.getByRole("button", { name: "返回配置" }));
  fireEvent.click(await screen.findByRole("button", { name: "返回列表" }));
  fireEvent.click(await screen.findByRole("button", { name: /^B/ }));
  await waitFor(() =>
    expect(props.onConnect).toHaveBeenCalledWith(b.target, expect.any(String), undefined),
  );
});

it("身份等待只在用户确认后继续原目录，确认完成不遗留 busy", async () => {
  const { renderHook } = await import("@testing-library/react");
  const { useRemoteConnectionFlow } = await import("@/remote-connection-flow/index.js");
  ports.snapshot.profiles = [
    {
      profileId: "identity",
      transport: "docker",
      displayName: "device",
      target: { kind: "docker", container: "dev" },
      createdAt: 1,
    },
  ];
  const onConnect = vi.fn(async () => "session");
  const onSelectProject = vi.fn();
  const { result } = renderHook(() =>
    useRemoteConnectionFlow({
      open: true,
      preferredProfileId: "identity",
      preferredDirectoryPath: "/repo",
      initialFailure: {
        code: "source-server-identity-change-pending",
        message: "identity changed",
      },
      onConnect,
      onSelectProject,
      onCancelSession: vi.fn(),
    }),
  );
  await waitFor(() =>
    expect(result.current.connectingStep.errorCode).toBe("source-server-identity-change-pending"),
  );
  expect(ports.management.confirmIdentityChange).not.toHaveBeenCalled();
  act(() => result.current.connectingStep.onRetry());
  await waitFor(() => expect(onSelectProject).toHaveBeenCalledWith("session", "/repo", undefined));
  expect(ports.management.confirmIdentityChange).toHaveBeenCalledWith("identity");
  expect(result.current.connectingStep.loading).toBe(false);
});

it("首屏直接列出 config Host，搜索后点击并在连接屏补密码", async () => {
  ports.platform.listSSHConfigAliases.mockResolvedValue([
    { alias: "build-box", host: "build.example.com", username: "builder", port: 2222 },
    { alias: "other-box", host: "other.example.com", username: "dev" },
  ]);
  const { props } = mountDialog();
  const search = await screen.findByRole("searchbox");
  expect(document.activeElement).toBe(search);
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  fireEvent.change(search, { target: { value: "build" } });
  fireEvent.click(await screen.findByRole("button", { name: /build-box/ }));
  expect(screen.queryByRole("button", { name: /other-box/ })).toBeNull();
  expect(props.onConnect).not.toHaveBeenCalled();
  const password = await screen.findByLabelText("密码");
  expect(document.activeElement).toBe(password);
  fireEvent.change(password, { target: { value: "config-secret" } });
  fireEvent.submit(password.closest("form")!);
  await waitFor(() =>
    expect(props.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ssh",
        host: "build.example.com",
        username: "builder",
        port: 2222,
        sshConfigAlias: "build-box",
        password: "config-secret",
      }),
      expect.any(String),
      undefined,
    ),
  );
});

it("新建 SSH 使用表单校验端口，回车提交时修剪地址和用户名", async () => {
  const { props } = mountDialog();
  fireEvent.click(await screen.findByRole("button", { name: "新建 SSH 连接" }));
  const host = screen.getByTestId("ssh-host-input");
  expect(document.activeElement).toBe(host);
  fireEvent.change(host, { target: { value: " dev.example.com " } });
  fireEvent.change(screen.getByTestId("ssh-username-input"), { target: { value: " dev " } });
  fireEvent.change(screen.getByTestId("ssh-password-input"), { target: { value: "secret" } });
  const port = screen.getByTestId("ssh-port-input");
  fireEvent.change(port, { target: { value: "bad-port" } });
  fireEvent.submit(host.closest("form")!);
  expect(props.onConnect).not.toHaveBeenCalled();
  expect(port.getAttribute("aria-invalid")).toBe("true");
  await screen.findByText("端口须为 1–65535 的整数");
  fireEvent.change(port, { target: { value: "2222" } });
  // 端口变更代表另一目标，须重新输入该目标的凭据。
  expect(screen.getByTestId("ssh-password-input")).toHaveProperty("value", "");
  fireEvent.change(screen.getByTestId("ssh-password-input"), { target: { value: "secret" } });
  fireEvent.submit(host.closest("form")!);
  await waitFor(() =>
    expect(props.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "dev.example.com", username: "dev", port: 2222 }),
      expect.any(String),
      undefined,
      { announceReusedConnection: true },
    ),
  );
});

it("离线设备的最近目录可连接并打开，搜索也匹配目录", async () => {
  addDockerProfile();
  ports.snapshot.workspaceHistory = [
    {
      sourceServerId: "source-a",
      profileId: "docker-profile",
      workspacePath: "/srv/recent",
      lastOpenedAt: 1,
    },
  ];
  const { props } = mountDialog();
  fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "recent" } });
  fireEvent.click(await screen.findByRole("button", { name: "/srv/recent" }));
  await waitFor(() =>
    expect(props.onSelectProject).toHaveBeenCalledWith("session-a", "/srv/recent", undefined),
  );
  expect(props.onConnect).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "docker", container: "dev-container" }),
    expect.any(String),
    undefined,
  );
});

it("关闭清空同一会话草稿，收起后点击卡片保留失败结果且不重复连接", async () => {
  const connection = pending<string>();
  const onConnect = vi.fn(() => connection.promise);
  render(
    createElement(
      RemoteConnectionProgressProvider,
      null,
      createElement(TestBackgroundProgress),
      createElement(RemoteConnectionDialog, {
        onConnect,
        onSelectProject: vi.fn(),
        onCancelSession: vi.fn(),
      }),
    ),
  );
  fireEvent.click(screen.getByTestId("ssh-connect-trigger"));
  fireEvent.click(await screen.findByRole("button", { name: "新建 SSH 连接" }));
  fireEvent.change(screen.getByTestId("ssh-host-input"), {
    target: { value: "failed.example.com" },
  });
  fireEvent.change(screen.getByTestId("ssh-username-input"), { target: { value: "dev" } });
  fireEvent.change(screen.getByTestId("ssh-password-input"), { target: { value: "secret" } });
  await clickStart();
  fireEvent.click(screen.getByRole("button", { name: /收起/u }));
  expect(await screen.findByTestId("remote-connection-minimized")).toBeTruthy();
  await act(async () =>
    connection.reject(
      Object.assign(new Error("Connection refused"), { code: "remote-host-unreachable" }),
    ),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  const card = screen.getByTestId("remote-connection-minimized");
  expect(card.textContent).toContain("失败");
  expect(card.textContent).toContain("无法连接到主机");
  fireEvent.click(card);
  await screen.findByTestId("ssh-error");
  expect(onConnect).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("remote-connection-minimized")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "关闭" }).at(-1)!);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByTestId("ssh-connect-trigger"));
  fireEvent.click(await screen.findByRole("button", { name: "新建 SSH 连接" }));
  expect((screen.getByTestId("ssh-host-input") as HTMLInputElement).value).toBe("");
  expect((screen.getByTestId("ssh-username-input") as HTMLInputElement).value).toBe("");
  expect((screen.getByTestId("ssh-password-input") as HTMLInputElement).value).toBe("");
  expect((screen.getByTestId("ssh-port-input") as HTMLInputElement).value).toBe("22");
});

it.each([false, true])(
  "WSL 只在 Windows 出现（Windows=%s），发现条目直接连接",
  async (isWindowsDesktop) => {
    ports.platform.listWSLDistros.mockResolvedValue([
      { name: "Ubuntu", isDefault: true, state: "Running", version: 2 },
    ]);
    const { props } = mountDialog({ isWindowsDesktop });
    await screen.findByRole("searchbox");
    if (isWindowsDesktop) {
      fireEvent.click(await screen.findByRole("button", { name: /Ubuntu/ }));
      await waitFor(() =>
        expect(props.onConnect).toHaveBeenCalledWith(
          { kind: "wsl", distro: "Ubuntu" },
          expect.any(String),
          undefined,
        ),
      );
    } else {
      expect(screen.queryByRole("button", { name: /WSL/ })).toBeNull();
      expect(ports.platform.listWSLDistros).not.toHaveBeenCalled();
    }
  },
);

it("Docker 下拉与手动输入互斥，选择运行中容器立即连接", async () => {
  ports.platform.listDockerContainers.mockResolvedValue([
    { id: "container-a", name: "running-box", image: "ubuntu", state: "running", status: "Up" },
  ]);
  const { props } = mountDialog();
  const running = await screen.findByRole("button", { name: /running-box/ });
  fireEvent.click(running);
  await waitFor(() =>
    expect(props.onConnect).toHaveBeenCalledWith(
      { kind: "docker", container: "running-box" },
      expect.any(String),
      undefined,
    ),
  );
});

it("Docker 手动输入和列表选择有互斥的可访问控件", async () => {
  mountDialog();
  fireEvent.click(await screen.findByRole("button", { name: "手动输入 Docker" }));
  await screen.findByTestId("docker-container-input");
  expect(screen.queryByTestId("docker-container-select")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "选择运行中的容器" }));
  expect(screen.queryByTestId("docker-container-input")).toBeNull();
  await screen.findByTestId("docker-container-select");
  await screen.findByText("没有运行中的容器");
});

it("正式版没有开发 Server 提示，未选别名没有填充提示，密码可以显示隐藏", async () => {
  vi.stubEnv("DEV", false);
  ports.platform.isLocalDevelopmentRuntime = false;
  mountDialog();
  await screen.findByRole("searchbox");
  expect(screen.queryByText(/Server/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "新建 SSH 连接" }));
  expect(screen.queryByText(zhCN["ssh.configAliasDescription"])).toBeNull();
  const password = screen.getByTestId("ssh-password-input");
  fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
  expect(password.getAttribute("type")).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "隐藏密码" }));
  expect(password.getAttribute("type")).toBe("password");
});

it("Docker 不可用与无运行容器分开提示，打开下拉刷新发现结果", async () => {
  ports.platform.isDockerAvailable.mockResolvedValue(false);
  mountDialog();
  fireEvent.click(await screen.findByRole("button", { name: "手动输入 Docker" }));
  fireEvent.click(screen.getByRole("button", { name: "选择运行中的容器" }));
  await screen.findByText("Docker 不可用");
  expect(screen.queryByText("没有运行中的容器")).toBeNull();
  ports.platform.isDockerAvailable.mockResolvedValue(true);
  ports.platform.listDockerContainers.mockResolvedValue([
    { id: "new", name: "new-container", image: "ubuntu", state: "running", status: "Up" },
  ]);
  fireEvent.click(screen.getByTestId("docker-container-select"));
  fireEvent.click(await screen.findByRole("option", { name: "new-container" }));
  expect(screen.getByTestId("docker-container-select").textContent).toContain("new-container");
  expect(screen.queryByTestId("docker-container-input")).toBeNull();
});

it("手动 WSL 入口可填写未被发现的发行版并回车连接", async () => {
  ports.platform.listWSLDistros.mockResolvedValue([
    { name: "Ubuntu", isDefault: true, state: "Running", version: 2 },
  ]);
  const { props } = mountDialog({ isWindowsDesktop: true });
  await screen.findByRole("button", { name: /Ubuntu/ });
  fireEvent.click(screen.getByRole("button", { name: "手动输入 WSL" }));
  const distro = screen.getByLabelText("发行版");
  fireEvent.change(distro, { target: { value: "Custom-Distro" } });
  fireEvent.submit(distro.closest("form")!);
  await waitFor(() =>
    expect(props.onConnect).toHaveBeenCalledWith(
      { kind: "wsl", distro: "Custom-Distro" },
      expect.any(String),
      undefined,
      { announceReusedConnection: true },
    ),
  );
});

it("WSL 外部入口保留指定发行版，收起恢复不覆盖用户草稿", async () => {
  const view = mountDialog({
    isWindowsDesktop: true,
    preferredKind: "wsl",
    preferredWslDistro: "Ubuntu-24.04",
  });
  const distro = await screen.findByLabelText("发行版");
  expect((distro as HTMLInputElement).value).toBe("Ubuntu-24.04");
  fireEvent.change(distro, { target: { value: "Custom-Distro" } });
  fireEvent.click(screen.getByRole("button", { name: /收起/ }));
  view.rerender(createElement(RemoteConnectionDialog, { ...view.props, open: false }));
  view.rerender(createElement(RemoteConnectionDialog, view.props));
  expect((screen.getByLabelText("发行版") as HTMLInputElement).value).toBe("Custom-Distro");
});

it("收起恢复时 config 发现失败不会丢失当前 Host 的别名", async () => {
  ports.platform.listSSHConfigAliases.mockResolvedValueOnce([
    { alias: "jump-box", host: "private", username: "dev" },
  ]);
  const view = mountDialog();
  fireEvent.click(await screen.findByRole("button", { name: /jump-box/ }));
  fireEvent.change(await screen.findByLabelText("密码"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: /收起/ }));
  ports.platform.listSSHConfigAliases.mockRejectedValue(new Error("temporary config read failure"));
  view.rerender(createElement(RemoteConnectionDialog, { ...view.props, open: false }));
  view.rerender(createElement(RemoteConnectionDialog, view.props));
  await act(async () => undefined);
  fireEvent.submit(screen.getByLabelText("密码").closest("form")!);
  await waitFor(() =>
    expect(view.props.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ sshConfigAlias: "jump-box", host: "private", password: "secret" }),
      expect.any(String),
      undefined,
    ),
  );
});

it("配置和目录屏收起都有恢复卡片，恢复后保留表单及已导航目录", async () => {
  registerSession();
  const onSelectProject = vi.fn();
  render(
    createElement(
      RemoteConnectionProgressProvider,
      null,
      createElement(TestBackgroundProgress),
      createElement(RemoteConnectionDialog, {
        preferredTarget: sshTarget,
        onConnect: async () => "session-a",
        onSelectProject,
        onCancelSession: vi.fn(),
      }),
    ),
  );
  fireEvent.click(screen.getByTestId("ssh-connect-trigger"));
  const host = await screen.findByTestId("ssh-host-input");
  fireEvent.change(host, { target: { value: "kept.example.com" } });
  fireEvent.click(screen.getByRole("button", { name: /收起/ }));
  fireEvent.click(await screen.findByRole("button", { name: /继续配置远程连接/ }));
  expect((screen.getByTestId("ssh-host-input") as HTMLInputElement).value).toBe("kept.example.com");
  await clickStart();
  const path = await screen.findByDisplayValue("/srv/project");
  fireEvent.change(path, { target: { value: "/srv/another" } });
  fireEvent.submit(path.closest("form")!);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "在此目录打开工作区", exact: true })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: /收起/ }));
  fireEvent.click(await screen.findByRole("button", { name: /选择目录/ }));
  await screen.findByDisplayValue("/srv/another");
  fireEvent.click(screen.getByRole("button", { name: "在此目录打开工作区", exact: true }));
  await waitFor(() =>
    expect(onSelectProject).toHaveBeenCalledWith("session-a", "/srv/another", undefined),
  );
});

it("旧目录浏览器的迟到结果不能覆盖收起恢复后选择的目录", async () => {
  const slow = pending<import("@zcode/shared").FileEntry[]>();
  registerSession(async ({ path }) => (path === "/slow" ? slow.promise : []));
  const view = mountDialog({ preferredTarget: sshTarget });
  await clickStart();
  let path = await screen.findByDisplayValue("/srv/project");
  fireEvent.change(path, { target: { value: "/slow" } });
  fireEvent.submit(path.closest("form")!);
  fireEvent.click(screen.getByRole("button", { name: /收起/ }));
  view.rerender(createElement(RemoteConnectionDialog, { ...view.props, open: false }));
  view.rerender(createElement(RemoteConnectionDialog, view.props));
  path = await screen.findByDisplayValue("/srv/project");
  fireEvent.change(path, { target: { value: "/new" } });
  fireEvent.submit(path.closest("form")!);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "在此目录打开工作区", exact: true })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  await act(async () => slow.resolve([]));
  fireEvent.click(screen.getByRole("button", { name: "在此目录打开工作区", exact: true }));
  await waitFor(() =>
    expect(view.props.onSelectProject).toHaveBeenCalledWith("session-a", "/new", undefined),
  );
});

it("收起的最近目录连接成功后保留卡片，显式继续恢复目录", async () => {
  addDockerProfile();
  ports.snapshot.workspaceHistory = [
    {
      sourceServerId: "source-a",
      profileId: "docker-profile",
      workspacePath: "/srv/recent",
      lastOpenedAt: 1,
    },
  ];
  const connection = pending<string>();
  const onSelectProject = vi.fn();
  render(
    createElement(
      RemoteConnectionProgressProvider,
      null,
      createElement(TestBackgroundProgress),
      createElement(RemoteConnectionDialog, {
        onConnect: () => connection.promise,
        onSelectProject,
        onCancelSession: vi.fn(),
      }),
    ),
  );
  fireEvent.click(screen.getByTestId("ssh-connect-trigger"));
  fireEvent.click(await screen.findByRole("button", { name: "/srv/recent" }));
  await act(async () => undefined);
  fireEvent.click(screen.getByRole("button", { name: /收起/ }));
  await screen.findByTestId("remote-connection-minimized");
  await act(async () => connection.resolve("session-a"));
  expect(onSelectProject).not.toHaveBeenCalled();
  expect(
    (await screen.findAllByRole("button", { name: "继续", exact: true })).length,
  ).toBeGreaterThan(0);
  fireEvent.click(await screen.findByTestId("remote-connection-minimized"));
  await waitFor(() =>
    expect(onSelectProject).toHaveBeenCalledWith("session-a", "/srv/recent", undefined),
  );
  await waitFor(() => expect(screen.queryByTestId("remote-connection-minimized")).toBeNull());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each([false, true])("认证失败在连接阶段补充凭据并保留原目录，私钥=%s", async (privateKey) => {
  const onConnect = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("SSH 认证失败：请检查用户名、密码或私钥配置"), {
        code: "remote-preflight-failed",
      }),
    )
    .mockResolvedValueOnce("session-a");
  mountDialog({
    preferredTarget: privateKey
      ? sshTarget
      : { ...sshTarget, privateKeyPath: undefined, password: "old" },
    preferredDirectoryPath: "/keep/path",
    onConnect,
  });
  if (!privateKey)
    fireEvent.change(await screen.findByTestId("ssh-password-input"), { target: { value: "old" } });
  await clickStart();
  await screen.findByTestId("ssh-error");
  const field = await screen.findByTestId(
    privateKey ? "ssh-private-key-passphrase-input" : "ssh-password-input",
  );
  expect(field.closest("li")).not.toBeNull();
  fireEvent.change(field, { target: { value: "fixed-secret" } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2));
  expect(onConnect.mock.calls[1]?.[0]).toMatchObject(
    privateKey
      ? { privateKeyPassphrase: "fixed-secret", privateKeyPath: "/keys/dev" }
      : { password: "fixed-secret" },
  );
  expect(ports.confirm).not.toHaveBeenCalled();
});

it("从已保存线路的认证失败返回配置时保留原用户名和私钥文件", async () => {
  ports.snapshot.profiles = [
    { profileId: "key-profile", transport: "ssh", createdAt: 1, target: sshTarget },
  ];
  mountDialog({
    preferredProfileId: "key-profile",
    onConnect: vi.fn().mockRejectedValue(
      Object.assign(new Error("All configured authentication methods failed"), {
        code: "remote-preflight-failed",
      }),
    ),
  });
  await screen.findByTestId("ssh-private-key-passphrase-input");
  fireEvent.click(screen.getByRole("button", { name: "返回配置" }));
  await waitFor(() =>
    expect((screen.getByTestId("ssh-host-input") as HTMLInputElement).value).toBe(
      "original.example.com",
    ),
  );
  expect((screen.getByTestId("ssh-username-input") as HTMLInputElement).value).toBe("dev");
  expect((screen.getByTestId("ssh-private-key-input") as HTMLInputElement).value).toBe("/keys/dev");
});

it("project-owned connections can omit background actions until their continuation is available", async () => {
  mountDialog({ allowBackground: false });
  expect(screen.queryByRole("button", { name: /收起/u })).toBeNull();
});
