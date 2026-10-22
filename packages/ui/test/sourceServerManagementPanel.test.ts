// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type {
  SourceServerConnectionStateSnapshot,
  SourceServerManagementSnapshot,
} from "@zcode/shared";
import {
  getProjectCount,
  SourceServerManagementPanel,
} from "@/settings/SourceServerManagementPanel.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, number | string>) =>
        values?.projects
          ? `${id}:${values.projects}`
          : values?.attempt !== undefined
            ? `${id}:${values.attempt}/${values.limit}`
            : id,
    },
  }),
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", () => ({ toast: showToast }));
const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => confirmDialog }));
beforeEach(() => confirmDialog.mockReset().mockResolvedValue(true));
const platform = vi.hoisted(() => ({
  listSSHConfigAliases: vi.fn(async () => []),
  selectFile: vi.fn(),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => platform,
  useOptionalPlatform: () => platform,
}));

function identityPendingSnapshot(
  installState: "installed" | "uninstalled",
  pendingProfileId: string,
): SourceServerManagementSnapshot {
  const profileIds =
    pendingProfileId === "preferred" ? ["preferred"] : ["preferred", pendingProfileId];
  return {
    generation: 1,
    profiles: profileIds.map((profileId) => ({
      profileId,
      sourceServerId: "old-source",
      transport: "ssh",
      target: { kind: "ssh", host: `${profileId}.example.com`, username: "dev" },
      createdAt: 1,
      lifecycleState: "active",
    })),
    servers: [
      {
        sourceServerId: "old-source",
        displayName: "Reinstalled server",
        preferredProfileId: "preferred",
        installState,
        declaredWorkspaces: [],
      },
    ],
    workspaceHistory: [],
    states: profileIds.map((profileId) => ({
      profileId,
      sourceServerId: "old-source",
      state: profileId === pendingProfileId ? "identity-change-pending" : "offline",
      ...(profileId === pendingProfileId ? { pendingSourceServerId: "new-source" } : {}),
      updatedAt: 1,
    })),
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SourceServerManagementPanel", () => {
  it("当前连接在第二行，默认连接留在其他连接；最近项目按打开时间倒序且可展开全部", async () => {
    const snapshot = identityPendingSnapshot("installed", "other");
    snapshot.states[0]!.state = "offline";
    snapshot.states[1]!.state = "online";
    snapshot.workspaceHistory = (
      [
        ["alpha", 1],
        ["beta", 4],
        ["gamma", 3],
        ["delta", 2],
      ] as const
    ).map(([name, lastOpenedAt]) => ({
      sourceServerId: "old-source",
      profileId: "other",
      workspacePath: `/work/${name}`,
      workspaceIdentity: `remote:${name}`,
      lastOpenedAt,
    }));
    const open = vi.fn(async () => {});
    const setPreferredProfile = vi.fn(async () => snapshot);
    const { container } = render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
          setPreferredProfile,
        } as never,
        onOpenProject: open,
        workspaceTabs: [
          {
            id: "beta-tab",
            kind: "workspace",
            label: "beta",
            workspacePath: "/work/beta",
            workspaceIdentity: "remote:server:old-source:/work/beta",
          },
        ],
      }),
    );
    await screen.findByText("Reinstalled server");
    const line = container.querySelector("[data-device-connection]")!;
    expect(line.textContent).toContain("other.example.com");
    expect(line.textContent).toContain("settings.source.currentProfile");
    expect(line.textContent).not.toContain("settings.source.defaultProfile");
    fireEvent.click(screen.getByRole("button", { name: "settings.source.setDefault" }));
    await waitFor(() => expect(setPreferredProfile).toHaveBeenCalledWith("old-source", "other"));
    const projectNames = () =>
      [...container.querySelectorAll("[data-device-project]")].map((row) =>
        row.getAttribute("aria-label"),
      );
    // 最近打开的排前面，默认只露出三行；不能再出现无法点击的 +N。
    expect(projectNames()).toEqual(["beta", "gamma", "delta"]);
    expect(screen.queryByText("+1")).toBeNull();
    const betaRow = container.querySelector('[data-device-project][aria-label="beta"]')!;
    expect(betaRow.textContent).toContain("/work/beta");
    expect(betaRow.textContent).toContain("settings.source.projectOpened");
    expect(
      container.querySelector('[data-device-project][aria-label="gamma"]')!.textContent,
    ).not.toContain("settings.source.projectOpened");
    fireEvent.click(screen.getByRole("button", { name: "settings.source.showAllProjects" }));
    expect(projectNames()).toEqual(["beta", "gamma", "delta", "alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("old-source", "/work/alpha", "other"));
    fireEvent.click(screen.getByRole("button", { name: "settings.source.showLessProjects" }));
    expect(projectNames()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "settings.source.otherSavedConnections" }));
    expect(screen.getByText("dev@preferred.example.com:22")).toBeTruthy();
    expect(screen.getByText("settings.source.defaultProfile")).toBeTruthy();
  });

  it("单条连接不显示当前/默认标签，连接行展示远端版本", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0]!.state = "online";
    snapshot.servers[0]!.lastSeenVersion = "v1.4.2";
    const { container } = render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );
    await screen.findByText("Reinstalled server");
    const line = container.querySelector("[data-device-connection]")!;
    expect(line.textContent).toContain("dev@preferred.example.com:22");
    expect(line.textContent).toContain("1.4.2");
    expect(line.textContent).not.toContain("settings.source.currentProfile");
    expect(line.textContent).not.toContain("settings.source.defaultProfile");
    expect(container.querySelector("[data-device-projects]")?.textContent).toContain(
      "settings.source.projectCount",
    );
  });

  it("可选更新稍后在面板重挂和重连后保持隐藏，新版本重新显示", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      ...snapshot.states[0]!,
      state: "online",
      updateAvailability: "available",
      availableVersion: "defer-test-1",
      upgradeTarget: "server",
    };
    const management = {
      getSnapshot: async () => snapshot,
      onDidChangeState: new Emitter().event,
    } as never;
    const first = render(createElement(SourceServerManagementPanel, { management }));
    fireEvent.click(await screen.findByRole("button", { name: "updateDialog.later" }));
    expect(screen.queryByText("settings.source.updateAvailableVersion")).toBeNull();
    first.unmount();
    const second = render(createElement(SourceServerManagementPanel, { management }));
    await screen.findByText("Reinstalled server");
    expect(screen.queryByText("settings.source.updateAvailableVersion")).toBeNull();
    second.unmount();
    snapshot.states[0]!.availableVersion = "defer-test-2";
    render(createElement(SourceServerManagementPanel, { management }));
    expect(await screen.findByRole("button", { name: "updateDialog.later" })).toBeTruthy();
  });

  it("强制更新确认列出 Host 返回的运行任务，取消不发送 force=true", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      ...snapshot.states[0]!,
      state: "needs-upgrade",
      updateAvailability: "required",
      upgradeTarget: "server",
      runningTasks: [{ sessionId: "running-session", workspacePath: "/work/alpha" }],
    };
    const updateSource = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("busy"), { code: "source-server-update-running-tasks" }),
      );
    confirmDialog.mockResolvedValue(false);
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
          updateSource,
        } as never,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "remote.action.update-server" }));
    await waitFor(() =>
      expect(confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining("running-session — /work/alpha"),
        }),
      ),
    );
    expect(updateSource.mock.calls).toEqual([[{ profileId: "preferred", force: false }]]);
  });

  it("离开设置后更新失败，toast 详情通过稳定导航重新打开设备", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      ...snapshot.states[0]!,
      state: "needs-upgrade",
      updateAvailability: "required",
      upgradeTarget: "server",
    };
    const pending = Promise.withResolvers<SourceServerManagementSnapshot>();
    const updateSource = vi.fn(() => pending.promise);
    const onShowUpdateDetails = vi.fn();
    const view = render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
          updateSource,
        } as never,
        onShowUpdateDetails,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "remote.action.update-server" }));
    await waitFor(() => expect(updateSource).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => pending.reject(new Error("update failed")));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "sourceServer.updateFailedToast",
        expect.objectContaining({ actionLabel: "remote.action.details" }),
      ),
    );
    showToast.mock.calls.at(-1)![1].onAction();
    expect(onShowUpdateDetails).toHaveBeenCalledWith("old-source");
  });

  it("未完成连接展开后可读取最近日志，清理时跳过刚识别的设备", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.servers = [];
    snapshot.profiles[0]!.profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
    delete snapshot.profiles[0]!.sourceServerId;
    snapshot.states[0] = {
      profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
      state: "failed",
      updatedAt: 1,
      errorCode: "remote-host-unreachable",
    };
    let current = snapshot;
    const removeProfile = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => current,
          onDidChangeState: new Emitter().event,
          removeProfile,
          getRecentOperationLogs: async () => [
            {
              timestamp: 1,
              level: "error",
              phase: "connect",
              operation: "connect",
              message: "Connection refused",
              profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
            },
          ],
        } as never,
      }),
    );
    fireEvent.click(await screen.findByText("settings.source.unfinishedConnections"));
    fireEvent.click(await screen.findByRole("button", { name: "settings.source.recentLog" }));
    expect(await screen.findByText("Connection refused")).toBeTruthy();
    current = identityPendingSnapshot("installed", "preferred");
    fireEvent.click(screen.getByRole("button", { name: "settings.source.clearUnfinished" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(removeProfile).not.toHaveBeenCalled();
  });

  it("更新中覆盖连接记录保留的旧错误", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0]!.state = "updating";
    snapshot.profiles[0]!.lastConnectError = "OLD_INSTALL_FAILURE";
    const emitter = new Emitter();
    render(
      createElement(SourceServerManagementPanel, {
        management: { getSnapshot: async () => snapshot, onDidChangeState: emitter.event } as never,
      }),
    );
    expect(await screen.findByText("remote.status.updating")).toBeTruthy();
    expect(screen.queryByText("settings.source.lastConnectError")).toBeNull();
  });

  it("设备卡修复产生错误的连接，而不是离线的首选连接", async () => {
    const snapshot = identityPendingSnapshot("installed", "other");
    snapshot.states[1] = {
      profileId: "other",
      sourceServerId: "old-source",
      state: "failed",
      error: "host not found",
      errorCode: "remote-host-not-found",
      updatedAt: 2,
    };
    const emitter = new Emitter();
    const management = {
      getSnapshot: async () => snapshot,
      onDidChangeState: emitter.event,
    } as never;
    render(createElement(SourceServerManagementPanel, { management, onConnectProfile: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "remote.action.edit-host" }));
    expect((screen.getByLabelText("ssh.host") as HTMLInputElement).value).toBe("other.example.com");
  });

  it.each(["remote-permission-denied", "remote-host-not-found"] as const)(
    "%s 的主操作查看详情或编辑主机，不会盲目重连",
    async (errorCode) => {
      const snapshot = identityPendingSnapshot("installed", "preferred");
      snapshot.states[0] = {
        profileId: "preferred",
        sourceServerId: "old-source",
        state: "failed",
        error: "diagnostic details",
        errorCode,
        updatedAt: 2,
      };
      const emitter = new Emitter();
      const management = {
        getSnapshot: async () => snapshot,
        onDidChangeState: emitter.event,
      } as never;
      const onConnectProfile = vi.fn();
      render(createElement(SourceServerManagementPanel, { management, onConnectProfile }));
      fireEvent.click(
        await screen.findByRole("button", {
          name:
            errorCode === "remote-permission-denied"
              ? "remote.action.details"
              : "remote.action.edit-host",
        }),
      );
      expect(await screen.findByRole("dialog")).toBeTruthy();
      expect(onConnectProfile).not.toHaveBeenCalled();
      if (errorCode === "remote-host-not-found")
        expect(screen.getByLabelText("ssh.host").getAttribute("aria-invalid")).toBe("true");
      else
        expect(screen.getByRole("dialog").textContent).toContain(
          "remote.error.permissionDenied.reason",
        );
    },
  );

  it("本机过旧时显示更新桌面端，仍可打开连接配置", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      profileId: "preferred",
      sourceServerId: "old-source",
      state: "needs-upgrade",
      updateAvailability: "required",
      upgradeTarget: "controller",
      updatedAt: 2,
    };
    const stateEmitter = new Emitter();
    const management = {
      getSnapshot: async () => snapshot,
      onDidChangeState: stateEmitter.event,
    } as never;
    const onConnectProfile = vi.fn();
    render(createElement(SourceServerManagementPanel, { management, onConnectProfile }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "remote.action.update-desktop" }).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByText("remote.status.needsUpdate")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "remote.action.connect" }));
    expect(onConnectProfile).toHaveBeenCalledWith("preferred");
    expect(screen.queryByRole("button", { name: "remote.action.update-server" })).toBeNull();
  });

  it("更新桌面提示旁的备用连接也防重，并接住异步失败", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      profileId: "preferred",
      sourceServerId: "old-source",
      state: "needs-upgrade",
      updateAvailability: "required",
      upgradeTarget: "controller",
      updatedAt: 2,
    };
    let reject!: (error: Error) => void;
    const connect = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
        onConnectProfile: connect,
      }),
    );
    const button = await screen.findByRole("button", { name: "remote.action.connect" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(connect).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => reject(new Error("connection failed")));
    expect(screen.getByRole("alert").textContent).toContain("settings.source.operationFailed");
  });

  it("关闭再打开设置仍可查询设备最近一次失败日志", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0]!.state = "failed";
    const stateEmitter = new Emitter();
    const getRecentOperationLogs = vi.fn(async () => [
      {
        profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
        operation: "connect",
        phase: "probe",
        level: "error",
        message: "Connection refused",
        timestamp: 10,
      },
    ]);
    const management = {
      getSnapshot: async () => snapshot,
      getRecentOperationLogs,
      onDidChangeState: stateEmitter.event,
    } as never;
    // 失败设备的最近日志默认展开；用户手动收起后以用户选择为准。
    const first = render(createElement(SourceServerManagementPanel, { management }));
    await waitFor(() => expect(screen.getByText("Connection refused")).toBeTruthy());
    fireEvent.click(screen.getByText("settings.source.recentLog"));
    expect(screen.queryByText("Connection refused")).toBeNull();
    first.unmount();
    render(createElement(SourceServerManagementPanel, { management }));
    await waitFor(() => expect(screen.getByText("Connection refused")).toBeTruthy());
    expect(getRecentOperationLogs).toHaveBeenCalledWith("preferred");
  });

  it.each([
    ["installed", "preferred"],
    ["uninstalled", "preferred"],
    ["installed", "alternative"],
    ["uninstalled", "alternative"],
  ] as const)(
    "%s 设备的 %s 线路换代确认始终可达；取消无副作用，确认使用原服务",
    async (installState, pendingProfileId) => {
      const snapshot = identityPendingSnapshot(installState, pendingProfileId);
      let complete!: (value: SourceServerManagementSnapshot) => void;
      const confirmIdentityChange = vi.fn(
        () =>
          new Promise<SourceServerManagementSnapshot>((resolve) => {
            complete = resolve;
          }),
      );
      const onCreateConnection = vi.fn();
      const onConnectProfile = vi.fn();
      render(
        createElement(SourceServerManagementPanel, {
          management: {
            getSnapshot: vi.fn(async () => snapshot),
            onDidChangeState: new Emitter().event,
            confirmIdentityChange,
          } as never,
          onCreateConnection,
          onConnectProfile,
        }),
      );
      const button = await screen.findByRole("button", {
        name: "settings.source.identityChangeConfirm",
      });
      expect(confirmIdentityChange).not.toHaveBeenCalled();
      confirmDialog.mockResolvedValueOnce(false);
      fireEvent.click(button);
      await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
      expect(confirmIdentityChange).not.toHaveBeenCalled();
      fireEvent.click(button);
      await waitFor(() =>
        expect(confirmIdentityChange).toHaveBeenCalledExactlyOnceWith(pendingProfileId),
      );
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(onCreateConnection).not.toHaveBeenCalled();
      expect(onConnectProfile).not.toHaveBeenCalled();
      await act(async () => complete({ ...snapshot, generation: 2, states: [] }));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "settings.source.identityChangeConfirm" }),
        ).toBeNull(),
      );
    },
  );

  it("已卸载设备的多条待确认线路无需展开即可分别操作，首选线路优先", async () => {
    const snapshot = identityPendingSnapshot("uninstalled", "alternative");
    snapshot.states = snapshot.states.map((state) => ({
      ...state,
      state: "identity-change-pending",
      pendingSourceServerId: "new-source",
    }));
    const confirmIdentityChange = vi.fn(async () => snapshot);
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          confirmIdentityChange,
        } as never,
      }),
    );
    await screen.findByText("Reinstalled server");
    const buttons = screen.getAllByRole("button", {
      name: "settings.source.identityChangeConfirm",
    });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(confirmIdentityChange).toHaveBeenCalledWith("preferred"));
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(confirmIdentityChange).toHaveBeenLastCalledWith("alternative"));
  });

  it("身份确认失败显示错误并保留入口，不自动重试或伪装已恢复", async () => {
    const snapshot = identityPendingSnapshot("uninstalled", "preferred");
    const confirmIdentityChange = vi.fn(async () => {
      throw new Error("connection lost");
    });
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          confirmIdentityChange,
        } as never,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "settings.source.identityChangeConfirm" }),
    );
    expect(await screen.findByText("settings.source.operationFailed")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "settings.source.identityChangeConfirm" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(confirmIdentityChange).toHaveBeenCalledExactlyOnceWith("preferred");
  });

  it("only exposes startup reconnect as a global connection preference", async () => {
    const onUpdateSettings = vi.fn(async () => undefined);
    const snapshot: SourceServerManagementSnapshot = {
      generation: 0,
      profiles: [],
      servers: [],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };

    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
        } as never,
        settings: { remoteStartupAutoReconnectEnabled: false },
        onUpdateSettings,
      }),
    );

    expect(await screen.findByText("settings.source.connectionPreferences")).toBeTruthy();

    const toggle = screen.getByRole("switch", {
      name: "settings.source.startupAutoReconnect",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(onUpdateSettings).toHaveBeenCalledWith({
        remoteStartupAutoReconnectEnabled: true,
      }),
    );
  });

  it("加载完成前只有加载态，完成后空态可新建连接", async () => {
    let complete!: (snapshot: SourceServerManagementSnapshot) => void;
    const create = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: () =>
            new Promise<SourceServerManagementSnapshot>((resolve) => {
              complete = resolve;
            }),
          onDidChangeState: new Emitter().event,
        } as never,
        onCreateConnection: create,
      }),
    );
    expect(screen.getByRole("status").textContent).toContain("common.loading");
    expect(screen.queryByText("settings.source.empty")).toBeNull();
    const empty = identityPendingSnapshot("installed", "preferred");
    await act(async () => complete({ ...empty, servers: [], profiles: [], states: [] }));
    expect(screen.getByText("settings.source.empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "settings.source.newConnection" }));
    expect(create).toHaveBeenCalledOnce();
  });

  it("开关等待保存时禁止重复提交，失败回滚并提示", async () => {
    let reject!: (cause: Error) => void;
    const save = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => identityPendingSnapshot("installed", "preferred"),
          onDidChangeState: new Emitter().event,
        } as never,
        settings: { remoteStartupAutoReconnectEnabled: true },
        onUpdateSettings: save,
      }),
    );
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("disk full")));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("settings.source.operationFailed");
  });

  it("断开无确认并显示任务继续提示，等待期间拒绝第二次断开", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0]!.state = "online";
    let complete!: () => void;
    const disconnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
        onDisconnectSource: disconnect,
      }),
    );
    const button = await screen.findByRole("button", { name: "remote.action.disconnect" });
    // 任务继续提示只在断开按钮上说明，不再常驻占一行。
    expect(button.getAttribute("title")).toBe("settings.source.disconnectHint");
    expect(screen.queryByText("settings.source.disconnectHint")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("old-source");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(confirmDialog).not.toHaveBeenCalled();
    await act(async () => complete());
  });

  it("移除设备只列出该 Source 的已打开项目，定位回调携带 Source 身份", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0]!.state = "offline";
    const reveal = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
        onShowInSidebar: reveal,
        workspaceTabs: [
          {
            id: "a",
            kind: "workspace",
            label: "Project A",
            workspacePath: "/same-path",
            workspaceIdentity: "remote:server:old-source:/same-path",
          },
          {
            id: "b",
            kind: "workspace",
            label: "Project B",
            workspacePath: "/same-path",
            workspaceIdentity: "remote:server:other-source:/same-path",
          },
        ],
      }),
    );
    await screen.findByText("Reinstalled server");
    fireEvent.pointerDown(screen.getByRole("button", { name: "common.more" }));
    fireEvent.click(await screen.findByText("settings.source.showInSidebar"));
    expect(reveal).toHaveBeenCalledExactlyOnceWith("old-source");
    fireEvent.pointerDown(screen.getByRole("button", { name: "common.more" }));
    confirmDialog.mockResolvedValueOnce(false);
    fireEvent.click(await screen.findByText("settings.source.removeSourceServer"));
    const request = confirmDialog.mock.calls.at(-1)?.[0] as unknown as {
      title: string;
      confirmLabel: string;
      description: string;
    };
    expect(request.title).toBe(request.confirmLabel);
    expect(request.description).toContain("Project A (/same-path)");
    expect(request.description).not.toContain("Project B");
  });

  it("重新安装沿用此设备的连接档案，不打开空白新建表单", async () => {
    const snapshot = identityPendingSnapshot("uninstalled", "preferred");
    snapshot.states = [];
    const connect = vi.fn();
    const create = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
        onConnectProfile: connect,
        onCreateConnection: create,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "settings.source.reinstallAndConnect" }),
    );
    expect(connect).toHaveBeenCalledExactlyOnceWith("preferred");
    expect(create).not.toHaveBeenCalled();
  });

  it("更新失败只出现一次错误说明", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      profileId: "preferred",
      sourceServerId: "old-source",
      state: "failed",
      errorCode: "remote-host-unreachable",
      error: "Connection refused",
      updateAvailability: "required",
      updatedAt: 2,
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );
    await screen.findByText("Reinstalled server");
    expect(screen.getAllByText("remote.error.hostUnreachable")).toHaveLength(1);
  });

  it("项目数量过滤 Source 级 conversation backing workspace", () => {
    expect(
      getProjectCount(
        {
          workspaceHistory: [
            {
              sourceServerId: "source-1",
              workspacePath: "/remote/project",
              workspaceIdentity: "remote:server:source-1:/remote/project",
            },
            {
              sourceServerId: "source-1",
              workspacePath: "/remote/.zcode/workspace/default",
              workspaceIdentity: "remote:server:source-1:/remote/.zcode/workspace/default",
            },
          ],
        } as never,
        "source-1",
        {
          "source-1": {
            workspacePath: "/remote/.zcode/workspace/default",
            lastResolvedAt: 1,
          },
        },
      ),
    ).toBe(1);
  });

  it("reloads the authoritative directory snapshot after a state delta", async () => {
    const stateEmitter = new Emitter<{
      generation: number;
      state: SourceServerConnectionStateSnapshot;
    }>();
    const snapshot = (displayName: string, generation: number): SourceServerManagementSnapshot => ({
      generation,
      profiles: [],
      servers: [
        {
          sourceServerId: "3cd4f9da-cd79-426c-9d70-75f36e9f6a87",
          displayName,
          installState: "installed",
        },
      ],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    });
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot("Server A", 0))
      .mockResolvedValueOnce(snapshot("Server B", 1));
    const management = {
      getSnapshot,
      onDidChangeState: stateEmitter.event,
    } as never;

    render(createElement(SourceServerManagementPanel, { management }));
    expect(await screen.findByText("Server A")).toBeTruthy();

    stateEmitter.fire({
      generation: 1,
      state: {
        profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
        state: "online",
        updatedAt: 1,
      },
    });

    await waitFor(() => expect(screen.getByText("Server B")).toBeTruthy());
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("coalesces burst deltas while refresh is in flight", async () => {
    const stateEmitter = new Emitter<{
      generation: number;
      state: SourceServerConnectionStateSnapshot;
    }>();
    const empty: SourceServerManagementSnapshot = {
      generation: 0,
      profiles: [],
      servers: [],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    let resolveRefresh!: (snapshot: SourceServerManagementSnapshot) => void;
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockImplementationOnce(
        async () =>
          await new Promise<SourceServerManagementSnapshot>((resolve) => {
            resolveRefresh = resolve;
          }),
      )
      .mockResolvedValue(empty);
    render(
      createElement(SourceServerManagementPanel, {
        management: { getSnapshot, onDidChangeState: stateEmitter.event } as never,
      }),
    );
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    const state = { profileId: "p", state: "retrying", updatedAt: 1 } as const;
    stateEmitter.fire({ generation: 1, state });
    stateEmitter.fire({ generation: 2, state });
    await Promise.resolve();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    resolveRefresh(empty);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(3));
  });

  it("does not render an unstructured Host error", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "p",
          transport: "docker",
          target: { kind: "docker", container: "dev" },
          sourceServerId: "s",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [
        {
          profileId: "p",
          sourceServerId: "s",
          state: "failed",
          updatedAt: 1,
          error: "raw host detail",
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );
    expect(await screen.findByText("remote.error.unknown")).toBeTruthy();
    expect(screen.queryByText("raw host detail")).toBeNull();
  });

  it("renders concrete recovery attempt values after the retry budget is exhausted", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "p",
          transport: "docker",
          target: { kind: "docker", container: "dev" },
          sourceServerId: "s",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [
        {
          profileId: "p",
          sourceServerId: "s",
          state: "offline",
          updatedAt: 1,
          error: "network unavailable",
          errorCode: "remote-recovery-budget-exhausted",
          recoveryAttempt: 3,
          recoveryLimit: 3,
          recoveryBudgetExhausted: true,
          retryable: true,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );

    expect(await screen.findByText(/remote\.error\.recoveryBudgetExhausted:3\/3/u)).toBeTruthy();
  });

  it("shows version details and server update instead of reconnect when upgrade is required", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "p",
          transport: "docker",
          target: { kind: "docker", container: "dev" },
          sourceServerId: "s",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [
        {
          profileId: "p",
          sourceServerId: "s",
          state: "needs-upgrade",
          updateAvailability: "required",
          currentVersion: "3.6.0",
          minimumVersion: "3.7.0",
          availableVersion: "3.8.0",
          upgradeTarget: "server",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );

    expect(await screen.findByText("settings.source.versionDetails")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "remote.action.connect" })).toBeNull();
    screen.getByRole("button", {
      name: "remote.action.update-server",
    });
    screen.getByRole("button", {
      name: "settings.source.editConnection",
    });
    screen.getByRole("button", { name: "common.more" });
  });

  it("更新中覆盖旧的必须更新文案并展示明确进度", async () => {
    const operationLogEmitter = new Emitter<{
      profileId: string;
      operation: "update";
      phase: string;
      level: "info";
      message: string;
      progress?: number;
      timestamp: number;
    }>();
    const snapshot: SourceServerManagementSnapshot = {
      generation: 2,
      profiles: [
        {
          profileId: "p",
          transport: "ssh",
          target: { kind: "ssh", host: "h", username: "u" },
          sourceServerId: "s",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [
        {
          profileId: "p",
          sourceServerId: "s",
          state: "updating",
          updateAvailability: "required",
          currentVersion: "3.8.1",
          minimumVersion: "3.9.0",
          availableVersion: "3.9.0",
          upgradeTarget: "server",
          updatedAt: 2,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    let operationLogs: unknown[] = [];
    operationLogEmitter.event((entry) => {
      operationLogs = [{ ...entry, profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d" }];
    });
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          getRecentOperationLogs: vi.fn(async () => operationLogs),
          onDidChangeState: new Emitter().event,
          onDidAppendOperationLog: operationLogEmitter.event,
        } as never,
      }),
    );

    expect(await screen.findByText("settings.source.updateInProgress")).toBeTruthy();
    expect(screen.queryByText("settings.source.updateRequired")).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();

    act(() => {
      operationLogEmitter.fire({
        profileId: "p",
        operation: "update",
        phase: "upload",
        level: "info",
        message: "upload archive",
        progress: 0.5,
        timestamp: 3,
      });
    });
    expect(await screen.findByText("upload archive")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    for (const [phase, messageId] of [
      ["extract", "remote.phaseSub.extracting"],
      ["verify-archive", "remote.phaseSub.verifyingArchive"],
      ["verify", "remote.phaseSub.verifyingFiles"],
      ["restart", "remote.phaseSub.restarting"],
    ]) {
      act(() =>
        operationLogEmitter.fire({
          profileId: "p",
          operation: "update",
          phase: phase!,
          level: "info",
          message: phase!,
          timestamp: 4,
        }),
      );
      expect(await screen.findByText(messageId!)).toBeTruthy();
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
    }
  });

  it("edits the preferred connection in a dialog instead of inline", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "p",
          transport: "docker",
          displayName: "old name",
          target: { kind: "docker", container: "dev" },
          sourceServerId: "s",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const getSnapshot = vi.fn(async () => snapshot);
    render(
      createElement(SourceServerManagementPanel, {
        management: { getSnapshot, onDidChangeState: stateEmitter.event } as never,
      }),
    );
    expect(await screen.findByText("Dev")).toBeTruthy();
    expect(screen.queryByDisplayValue("Dev")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "settings.source.editConnection" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByDisplayValue("Dev")).toBeTruthy();
  });

  it("启动尚未连接时，不把历史失败重新显示为当前故障", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "p",
          transport: "ssh",
          displayName: "line",
          target: { kind: "ssh", host: "h", username: "u" },
          sourceServerId: "s",
          lastConnectError: "auth rejected",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: stateEmitter.event,
        } as never,
      }),
    );
    expect(await screen.findByText("remote.status.offline")).toBeTruthy();
    expect(screen.queryByText("settings.source.lastConnectError")).toBeNull();
  });

  it("shows one primary connection and collapses other saved connections", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "primary",
          transport: "ssh",
          displayName: "primary connection",
          target: { kind: "ssh", host: "primary.example.com", username: "dev" },
          sourceServerId: "source",
          createdAt: 1,
          lifecycleState: "active",
        },
        {
          profileId: "backup",
          transport: "ssh",
          displayName: "backup connection",
          target: { kind: "ssh", host: "backup.example.com", username: "dev" },
          sourceServerId: "source",
          createdAt: 2,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source",
          displayName: "Build server",
          preferredProfileId: "primary",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          updateProfile: vi.fn(),
        } as never,
      }),
    );

    expect(await screen.findByText("Build server")).toBeTruthy();
    expect(document.querySelector('[data-remote-connection-status="offline"]')).toBeTruthy();
    expect(document.querySelector('[data-remote-connection-kind="ssh"]')).toBeTruthy();
    expect(screen.getByText("dev@primary.example.com:22")).toBeTruthy();
    expect(screen.queryByText("dev@backup.example.com:22")).toBeNull();
    expect(
      screen.getAllByRole("button", {
        name: "settings.source.editConnection",
      }),
    ).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.source.otherSavedConnections",
      }),
    );
    screen.getByText("dev@backup.example.com:22");
    expect(screen.getByRole("button", { name: "settings.source.setDefault" })).toBeTruthy();
  });

  it("未识别连接只出现在默认折叠的未完成区域", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "unbound-profile",
          transport: "ssh",
          displayName: "linux-arm64-dev",
          target: {
            kind: "ssh",
            host: "localhost",
            port: 2223,
            username: "dev",
            sshConfigAlias: "linux-arm64-dev",
          },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      servers: [],
      workspaceHistory: [],
      states: [
        {
          profileId: "unbound-profile",
          state: "offline",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const { container } = render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          removeProfile: vi.fn(),
        } as never,
      }),
    );

    expect(await screen.findByText("settings.source.unfinishedConnections")).toBeTruthy();
    const unfinished = container.querySelector("[data-unfinished-connections]");
    expect(unfinished?.tagName).toBe("DETAILS");
    expect(unfinished?.hasAttribute("open")).toBe(false);
    expect(container.querySelector("[data-source-server-card]")).toBeNull();
    fireEvent.click(screen.getByText("settings.source.unfinishedConnections"));
    expect(screen.getByText("linux-arm64-dev")).toBeTruthy();
    expect(container.querySelector('[data-remote-connection-status="offline"]')).toBeTruthy();
    expect(screen.getByText("dev@localhost:2223")).toBeTruthy();
    const preferences = screen.getByText("settings.source.connectionPreferences");
    expect(
      unfinished!.compareDocumentPosition(preferences) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // 没有已识别设备时不显示设备列表标题。
    expect(screen.queryByText("settings.source.devicesHeading")).toBeNull();
  });

  it("does not expose migration diagnostics in the regular connection menu", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          transport: "ssh",
          target: { kind: "ssh", host: "example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Build server",
          preferredProfileId: "profile-a",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          state: "online",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [
        {
          sourceServerId: "source-a",
          status: "available",
          failedPathCount: 0,
          abandonedPathCount: 0,
        },
      ],
    };
    const getMigrationReport = vi.fn();
    const exportMigrationReport = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          getMigrationReport,
          exportMigrationReport,
        } as never,
      }),
    );

    expect(await screen.findByText("Build server")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "common.more" }));

    expect(screen.queryByText("settings.source.migrationReport")).toBeNull();
    expect(screen.queryByText("settings.source.exportMigrationJson")).toBeNull();
    expect(getMigrationReport).not.toHaveBeenCalled();
    expect(exportMigrationReport).not.toHaveBeenCalled();
  });

  it("keeps a user-facing connection-history alert for pending migration work", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          transport: "ssh",
          target: { kind: "ssh", host: "example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Build server",
          preferredProfileId: "profile-a",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          state: "online",
          updatedAt: 1,
        },
      ],
      failedPathCount: 1,
      abandonedPathCount: 0,
      migrationCounts: [
        {
          sourceServerId: "source-a",
          status: "available",
          failedPathCount: 1,
          abandonedPathCount: 0,
        },
      ],
    };
    const getMigrationReport = vi.fn(async () => ({ rows: [] }));
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          getMigrationReport,
        } as never,
      }),
    );

    expect(await screen.findByText("settings.source.connectionHistoryNeedsAttention")).toBeTruthy();
    expect(screen.queryByText(/产品边界/u)).toBeNull();
    expect(screen.queryByText("settings.source.migrationReport")).toBeNull();
    expect(screen.queryByText("settings.source.exportMigrationJson")).toBeNull();

    fireEvent.click(screen.getByText("settings.source.connectionHistoryNeedsAttention"));
    expect(await screen.findByText("settings.source.noMigrationIssues")).toBeTruthy();
    expect(getMigrationReport).toHaveBeenCalledWith("source-a");
    expect(screen.queryByRole("button", { name: /exportMigrationReport/u })).toBeNull();
  });

  it("routes every user connection action through the global dialog profile intent", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "bound-profile",
          sourceServerId: "source-a",
          transport: "ssh",
          target: { kind: "ssh", host: "bound.example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
        {
          profileId: "unbound-profile",
          transport: "docker",
          target: { kind: "docker", container: "pending-dev" },
          createdAt: 2,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Build server",
          preferredProfileId: "bound-profile",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const connectProfile = vi.fn();
    const onConnectProfile = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          connectProfile,
        } as never,
        onConnectProfile,
      }),
    );

    expect(await screen.findByText("Build server")).toBeTruthy();
    fireEvent.click(screen.getByText("settings.source.unfinishedConnections"));
    const connectButtons = screen.getAllByRole("button", {
      name: "remote.action.connect",
    });
    expect(connectButtons).toHaveLength(2);
    await act(async () => fireEvent.click(connectButtons[0]!));
    await act(async () => fireEvent.click(connectButtons[1]!));

    expect(onConnectProfile.mock.calls).toEqual([["bound-profile"], ["unbound-profile"]]);
    expect(connectProfile).not.toHaveBeenCalled();
  });

  it("routes device disconnect through the injected remote controller adapter", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          transport: "ssh",
          target: { kind: "ssh", host: "example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Build server",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          state: "online",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const onDisconnectSource = vi.fn(async () => undefined);
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
        } as never,
        onDisconnectSource,
      }),
    );

    expect(await screen.findByText("Build server")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "remote.action.disconnect" }));
    await waitFor(() => expect(onDisconnectSource).toHaveBeenCalledWith("source-a"));
  });

  it("离线设备的更多菜单仍提供「移除全部连接」并调用 Host 移除", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          transport: "ssh",
          target: { kind: "ssh", host: "example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Build server",
          preferredProfileId: "profile-a",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          state: "offline",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const removeSourceServer = vi.fn(async () => ({
      ...snapshot,
      generation: 2,
      profiles: [],
      servers: [],
      states: [],
    }));
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          removeSourceServer,
        } as never,
        onShowInSidebar: vi.fn(),
      }),
    );

    expect(await screen.findByText("Build server")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "common.more" }));
    // 离线设备不在侧边栏展示，但移除只删本机记录，不依赖连接。
    expect(await screen.findByText("settings.source.removeSourceServer")).toBeTruthy();
    expect(screen.queryByText("settings.source.showInSidebar")).toBeNull();
    const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');
    expect(screen.getByText("settings.source.copyDeviceId")).toBeTruthy();
    expect(menu?.querySelector("[data-device-info]")?.textContent).toContain("source-a");

    fireEvent.click(screen.getByText("settings.source.removeSourceServer"));
    await waitFor(() => expect(removeSourceServer).toHaveBeenCalledWith("source-a"));
  });
});

it("管理入口在快照到达后定位设备卡并消费一次意图，普通重挂不抢焦点", async () => {
  const snapshot = identityPendingSnapshot("installed", "preferred");
  const pending = Promise.withResolvers<typeof snapshot>();
  const management = {
    getSnapshot: () => pending.promise,
    onDidChangeState: new Emitter().event,
  } as never;
  const consumed = vi.fn();
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  const view = render(
    createElement(SourceServerManagementPanel, {
      management,
      targetSourceServerId: "old-source",
      onTargetSourceServerFocused: consumed,
    }),
  );
  expect(consumed).not.toHaveBeenCalled();
  await act(async () => pending.resolve(snapshot));
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("data-source-server-card")).toBe("old-source"),
  );
  expect(consumed).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenCalledWith({ block: "center" });
  view.unmount();
  render(createElement(SourceServerManagementPanel, { management }));
  await screen.findByText("Reinstalled server");
  expect(scroll).toHaveBeenCalledOnce();
  expect(document.activeElement?.getAttribute("data-source-server-card")).toBeNull();
});

it("设备操作按 Source 防重，无关设备与只读展开可继续，反序快照不回滚", async () => {
  const snapshot = identityPendingSnapshot("installed", "other");
  snapshot.states.forEach((state) => {
    state.state = "online";
    state.updateAvailability = "available";
    state.availableVersion = "2.0.0";
  });
  snapshot.servers.push({
    ...snapshot.servers[0]!,
    sourceServerId: "second",
    displayName: "Second",
    preferredProfileId: "second",
  });
  snapshot.profiles.push({
    ...snapshot.profiles[0]!,
    sourceServerId: "second",
    profileId: "second",
  });
  snapshot.states.push({
    ...snapshot.states[0]!,
    sourceServerId: "second",
    profileId: "second",
    state: "online",
  });
  snapshot.states[1] = {
    ...snapshot.states[1]!,
    state: "failed",
    errorCode: "remote-permission-denied",
  };
  const first = Promise.withResolvers<SourceServerManagementSnapshot>();
  const second = Promise.withResolvers<SourceServerManagementSnapshot>();
  const updateSource = vi.fn(({ profileId }: { profileId: string }) =>
    profileId === "second" ? second.promise : first.promise,
  );
  const management = {
    getSnapshot: async () => snapshot,
    onDidChangeState: new Emitter().event,
    updateSource,
  } as never;
  const { container } = render(
    createElement(SourceServerManagementPanel, {
      management,
      onDisconnectSource: vi.fn(async () => {}),
    }),
  );
  await screen.findByText("Second");
  const card = (id: string) => container.querySelector(`[data-source-server-card="${id}"]`)!;
  const action = (id: string) =>
    Array.from(card(id).querySelectorAll("button")).find(
      (button) => button.textContent === "remote.action.update-server",
    )!;
  fireEvent.click(action("old-source"));
  fireEvent.click(action("old-source"));
  expect(updateSource).toHaveBeenCalledTimes(1);
  expect(
    card("second")
      .querySelector('button[aria-label="settings.source.editConnection"]')!
      .matches(":disabled"),
  ).toBe(false);
  const expand = card("old-source").querySelector(
    'button[aria-label="settings.source.otherSavedConnections"]',
  )!;
  expect(expand.matches(":disabled")).toBe(false);
  fireEvent.click(expand);
  const otherLine = screen.getByText("dev@other.example.com:22").parentElement!;
  const lineButton = (name: string) =>
    Array.from(otherLine.querySelectorAll("button")).find((button) => button.textContent === name)!;
  expect(lineButton("remote.action.details").matches(":disabled")).toBe(false);
  expect(lineButton("settings.source.setDefault").matches(":disabled")).toBe(true);
  expect(lineButton("settings.source.removeProfile").matches(":disabled")).toBe(true);
  expect(
    card("old-source")
      .querySelector('button[aria-label="settings.source.editConnection"]')!
      .matches(":disabled"),
  ).toBe(true);
  fireEvent.click(action("second"));
  expect(updateSource).toHaveBeenCalledTimes(2);
  await act(async () =>
    second.resolve({
      ...snapshot,
      generation: 3,
      servers: snapshot.servers.map((server) => ({
        ...server,
        displayName: `${server.displayName} latest`,
      })),
    }),
  );
  await screen.findByText("Second latest");
  await act(async () => first.resolve({ ...snapshot, generation: 2 }));
  expect(screen.queryByText("Second")).toBeNull();
  expect(screen.getByText("Second latest")).toBeTruthy();
});

it("管理失败设备只定位，显式详情意图才打开对话框且同设备可再次消费", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const snapshot = identityPendingSnapshot("installed", "preferred");
  snapshot.states[0] = {
    ...snapshot.states[0]!,
    state: "failed",
    errorCode: "remote-host-unreachable",
    error: "connect ECONNREFUSED",
  };
  const management = {
    getSnapshot: async () => snapshot,
    onDidChangeState: new Emitter().event,
  } as never;
  const view = render(
    createElement(SourceServerManagementPanel, { management, targetSourceServerId: "old-source" }),
  );
  await screen.findByText("Reinstalled server");
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(createElement(SourceServerManagementPanel, { management }));
  view.rerender(
    createElement(SourceServerManagementPanel, {
      management,
      targetSourceServerId: "old-source",
      targetSourceServerDetails: true,
    }),
  );
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

it.each([false, true])("可选更新不吞同设备连接失败原因（同 Profile：%s）", async (sameProfile) => {
  const snapshot = identityPendingSnapshot("installed", "other");
  snapshot.states[0] = {
    ...snapshot.states[0]!,
    state: "failed",
    errorCode: "remote-host-unreachable",
    error: "connect ECONNREFUSED",
    updatedAt: 2,
  };
  snapshot.states[1] = { ...snapshot.states[1]!, state: "offline" };
  Object.assign(snapshot.states[sameProfile ? 0 : 1]!, {
    updateAvailability: "available",
    availableVersion: "2.0.0",
  });
  render(
    createElement(SourceServerManagementPanel, {
      management: {
        getSnapshot: async () => snapshot,
        onDidChangeState: new Emitter().event,
      } as never,
    }),
  );
  await screen.findByText("Reinstalled server");
  expect(screen.getByText("remote.error.hostUnreachable")).toBeTruthy();
  if (!sameProfile) expect(screen.getByText("settings.source.updateAvailableVersion")).toBeTruthy();
});

it("同连接的可选更新稍后隐藏后仍展示连接失败原因", async () => {
  const snapshot = identityPendingSnapshot("installed", "preferred");
  snapshot.states[0] = {
    ...snapshot.states[0]!,
    state: "failed",
    errorCode: "remote-host-unreachable",
    updateAvailability: "available",
    availableVersion: "deferred-regression",
  };
  render(
    createElement(SourceServerManagementPanel, {
      management: {
        getSnapshot: async () => snapshot,
        onDidChangeState: new Emitter().event,
      } as never,
    }),
  );
  await screen.findByText("remote.error.hostUnreachable");
  fireEvent.click(screen.getByRole("button", { name: "updateDialog.later" }));
  expect(screen.getByText("remote.error.hostUnreachable")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "updateDialog.later" })).toBeNull();
});
