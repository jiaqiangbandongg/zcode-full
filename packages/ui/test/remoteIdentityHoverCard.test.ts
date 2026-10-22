// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { RemoteIdentityHoverCard } from "@/project-sidebar/RemoteIdentityHoverCard.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, unknown>) =>
        values ? `${id}${JSON.stringify(values)}` : id,
    },
  }),
}));
const remote = vi.hoisted(() => ({
  device: undefined as Record<string, unknown> | undefined,
  logs: {} as Record<string, unknown[]>,
  requestedProfileIds: [] as string[][],
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({ useBaseWorkspaceServices: () => ({}) }));
vi.mock("@/hooks/useSourceServerStatuses.js", () => ({
  useRemoteDevicePresentationInput: (sourceServerId?: string) =>
    sourceServerId === "alpha" ? remote.device : undefined,
}));
vi.mock("@/hooks/useSourceServerOperationLogs.js", () => ({
  useSourceServerOperationLogs: (_management: unknown, profileIds: string[] = []) => {
    remote.requestedProfileIds.push(profileIds);
    return { logsByProfileId: remote.logs };
  },
}));
beforeAll(() => vi.stubGlobal("PointerEvent", MouseEvent));
afterEach(() => {
  cleanup();
  remote.device = undefined;
  remote.logs = {};
  remote.requestedProfileIds = [];
  vi.restoreAllMocks();
});
const host = {
  id: "remote:server:alpha",
  membershipId: "alpha",
  kind: "ssh" as const,
  target: { kind: "ssh" as const, host: "alpha.example.com", username: "dev", port: 22 },
  connectionStatus: "offline" as const,
  position: 0,
};
function mount() {
  return render(
    createElement(RemoteIdentityHoverCard, {
      host,
      title: "Task",
      projectName: "test2",
      deviceName: "Alpha",
      paths: ["/home/dev/test2"],
      children: createElement("button", { type: "button" }, "remote row"),
    }),
  );
}
it("shows offline device identity, stays open over content, and closes after leaving without a close action", async () => {
  mount();
  fireEvent.pointerEnter(screen.getByText("remote row"), { pointerType: "mouse" });
  const details = await screen.findByTestId("remote-identity-details");
  expect(details.textContent).toContain("Alpha");
  expect(details.textContent).toContain("alpha.example.com");
  expect(details.textContent).toContain("/home/dev/test2");
  expect(details.textContent).toContain("remote.status.offline");
  expect(details.querySelector("button")).toBeNull();
  fireEvent.pointerLeave(screen.getByText("remote row"), { pointerType: "mouse" });
  fireEvent.pointerEnter(details, { pointerType: "mouse" });
  expect(screen.getByTestId("remote-identity-details")).toBeTruthy();
  fireEvent.pointerLeave(details, { pointerType: "mouse" });
  await waitFor(() => expect(screen.queryByTestId("remote-identity-details")).toBeNull());
});
it("closes on keyboard blur and Escape, and never pins after clicking the row", async () => {
  mount();
  const row = screen.getByText("remote row");
  fireEvent.focus(row);
  await screen.findByTestId("remote-identity-details");
  fireEvent.blur(row);
  await waitFor(() => expect(screen.queryByTestId("remote-identity-details")).toBeNull());
  fireEvent.pointerEnter(row, { pointerType: "mouse" });
  await screen.findByTestId("remote-identity-details");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByTestId("remote-identity-details")).toBeNull());
  fireEvent.pointerEnter(row, { pointerType: "mouse" });
  await screen.findByTestId("remote-identity-details");
  fireEvent.click(row);
  fireEvent.pointerLeave(row, { pointerType: "mouse" });
  await waitFor(() => expect(screen.queryByTestId("remote-identity-details")).toBeNull());
});

it.each(["outside", "trigger", "keyboard"])(
  "does not pin selected path text when leaving through %s",
  async (leaveThrough) => {
    mount();
    const row = screen.getByText("remote row");
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    const details = await screen.findByTestId("remote-identity-details");
    fireEvent.pointerLeave(row, { pointerType: "mouse" });
    fireEvent.pointerEnter(details, { pointerType: "mouse" });
    const path = screen.getByText("/home/dev/test2");
    fireEvent.pointerDown(path);
    const range = document.createRange();
    range.selectNodeContents(path);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    fireEvent.pointerUp(path);
    // Radix 在 pointerup 后的下一任务记录选区；复现真实复制文字后的关闭分支。
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.getSelection()?.toString()).toBe("/home/dev/test2");
    expect(screen.getByTestId("remote-identity-details")).toBeTruthy();

    if (leaveThrough === "keyboard") {
      fireEvent.focus(row);
      fireEvent.blur(row, { relatedTarget: document.body });
    } else {
      fireEvent.pointerLeave(details, { pointerType: "mouse" });
      if (leaveThrough === "trigger") {
        fireEvent.pointerEnter(row, { pointerType: "mouse" });
        await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
        expect(screen.getByTestId("remote-identity-details")).toBeTruthy();
        fireEvent.pointerLeave(row, { pointerType: "mouse" });
      }
    }
    await waitFor(() => expect(screen.queryByTestId("remote-identity-details")).toBeNull());
  },
);

it("keeps a focused row's details open while selecting text inside them", async () => {
  mount();
  const row = screen.getByText("remote row");
  fireEvent.focus(row);
  const details = await screen.findByTestId("remote-identity-details");
  fireEvent.pointerEnter(details, { pointerType: "mouse" });
  fireEvent.pointerDown(screen.getByText("/home/dev/test2"));
  // 点击不可聚焦的详情文字会让原按钮失焦，但鼠标仍在详情内，不能中断复制。
  fireEvent.blur(row, { relatedTarget: null });
  await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
  expect(screen.getByTestId("remote-identity-details")).toBeTruthy();
  fireEvent.pointerUp(details);
  fireEvent.pointerLeave(details, { pointerType: "mouse" });
  await waitFor(() => expect(screen.queryByTestId("remote-identity-details")).toBeNull());
});

it("待处理设备显示具体短状态，并由底部入口定位设备设置后关闭", async () => {
  const onOpenDeviceSettings = vi.fn();
  render(
    createElement(RemoteIdentityHoverCard, {
      host: { ...host, lastConnectionStatus: "needs-upgrade" },
      title: "Task",
      paths: ["/home/dev/test2"],
      onOpenDeviceSettings,
      children: createElement("button", { type: "button" }, "remote row"),
    }),
  );
  fireEvent.pointerEnter(screen.getByText("remote row"), { pointerType: "mouse" });
  const details = await screen.findByTestId("remote-identity-details");
  // 曾只显示泛化的“需要处理”，用户无法知道要处理什么。
  expect(details.textContent).toContain("remote.status.needsUpdate");
  expect(details.textContent).not.toContain("remote.status.pending");
  const entry = screen.getByTestId("remote-identity-device-settings");
  expect(entry.textContent).toContain("remote.action.update-server");
  fireEvent.click(entry);
  expect(onOpenDeviceSettings).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByTestId("remote-identity-details")).toBeNull());
});

it.each([
  { name: "离线设备即使有入口回调", lastConnectionStatus: "offline", callback: true },
  {
    name: "待处理设备没有入口回调（手机/菜单）",
    lastConnectionStatus: "needs-install",
    callback: false,
  },
])("$name 时详情不显示设置入口", async ({ lastConnectionStatus, callback }) => {
  render(
    createElement(RemoteIdentityHoverCard, {
      host: { ...host, lastConnectionStatus },
      title: "Task",
      paths: ["/home/dev/test2"],
      ...(callback ? { onOpenDeviceSettings: vi.fn() } : {}),
      children: createElement("button", { type: "button" }, "remote row"),
    }),
  );
  fireEvent.pointerEnter(screen.getByText("remote row"), { pointerType: "mouse" });
  const details = await screen.findByTestId("remote-identity-details");
  expect(details.querySelector("button")).toBeNull();
});

it("桌面端版本过旧时入口显示“更新桌面端”，与设置页设备卡一致", async () => {
  render(
    createElement(RemoteIdentityHoverCard, {
      // 修复前投影没有 upgradeTarget，入口固定回退成 update-server。
      host: { ...host, lastConnectionStatus: "needs-upgrade", upgradeTarget: "controller" },
      title: "Task",
      paths: ["/home/dev/test2"],
      onOpenDeviceSettings: vi.fn(),
      children: createElement("button", { type: "button" }, "remote row"),
    }),
  );
  fireEvent.pointerEnter(screen.getByText("remote row"), { pointerType: "mouse" });
  await screen.findByTestId("remote-identity-details");
  expect(screen.getByTestId("remote-identity-device-settings").textContent).toContain(
    "remote.action.update-desktop",
  );
});

const PROFILE = "00000000-0000-4000-8000-000000000001";
function hoverConnecting(overrides: Record<string, unknown> = {}) {
  render(
    createElement(RemoteIdentityHoverCard, {
      host: {
        ...host,
        connectionStatus: "connecting",
        lastConnectionStatus: "retrying",
        ...overrides,
      },
      title: "Task",
      paths: ["/home/dev/test2"],
      children: createElement("button", { type: "button" }, "remote row"),
    }),
  );
  fireEvent.pointerEnter(screen.getByText("remote row"), { pointerType: "mouse" });
  return screen.findByTestId("remote-identity-details");
}

it("连接中在详情顶部显示阶段、上传进度、步数、耗时与自动恢复，不显示原始日志", async () => {
  // 修复前侧栏只有 (i) Tooltip，读取的 requestId 日志通道从未接通，连接期间看不到任何信息。
  vi.spyOn(Date, "now").mockReturnValue(40_000);
  remote.device = { profileId: PROFILE, state: "retrying", recoveryAttempt: 2, recoveryLimit: 3 };
  remote.logs = {
    [PROFILE]: [
      {
        profileId: PROFILE,
        operation: "connect",
        phase: "probe",
        level: "info",
        message: "Checking the remote device",
        timestamp: 8_000,
      },
      {
        profileId: PROFILE,
        operation: "connect",
        phase: "upload",
        level: "info",
        message: "zcode.tar.gz",
        progress: 0.43,
        timestamp: 39_000,
      },
    ],
  };
  const details = await hoverConnecting();
  const progress = screen.getByTestId("remote-connection-progress");
  expect(remote.requestedProfileIds.at(-1)).toEqual([PROFILE]);
  expect(progress.textContent).toContain("remote.phase.deploy");
  expect(progress.textContent).toContain("43%");
  expect(progress.textContent).toContain('remote.progress.step{"current":3,"total":4}');
  expect(progress.textContent).toContain('remote.progress.elapsedSeconds{"seconds":32}');
  expect(progress.textContent).toContain(
    'workspaceSidebar.recoveringAutomaticShort{"attempt":2,"limit":3}',
  );
  expect(
    [...progress.querySelectorAll("[data-progress-segment]")].map((node) =>
      node.getAttribute("data-progress-segment"),
    ),
  ).toEqual(["complete", "complete", "active", "pending"]);
  expect(details.textContent).not.toContain("Checking the remote device");
  expect(details.textContent).not.toContain("zcode.tar.gz");
  expect(screen.queryByTestId("remote-connection-failure")).toBeNull();
});

it("连接中尚无日志时停在第 1 步，不显示耗时", async () => {
  const details = await hoverConnecting();
  const progress = screen.getByTestId("remote-connection-progress");
  expect(progress.textContent).toContain("remote.phase.channel");
  expect(progress.textContent).toContain('remote.progress.step{"current":1,"total":4}');
  expect(details.textContent).not.toContain("remote.progress.elapsed");
});

it("连接失败显示可读原因和复制错误详情，原文只进剪贴板", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const error = "ssh: handshake failed: ssh: unable to authenticate";
  const details = await hoverConnecting({
    connectionStatus: "offline",
    lastConnectionStatus: "failed",
    lastConnectionError: error,
  });
  const failure = screen.getByTestId("remote-connection-failure");
  expect(details.textContent).toContain("remote.status.failed");
  expect(failure.textContent).not.toContain(error);
  expect(screen.queryByTestId("remote-connection-progress")).toBeNull();
  fireEvent.click(screen.getByTestId("remote-connection-copy-error"));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(error));
  vi.unstubAllGlobals();
  vi.stubGlobal("PointerEvent", MouseEvent);
});

it("离线且带错误时同样显示失败原因；在线和普通离线不显示连接区", async () => {
  await hoverConnecting({
    connectionStatus: "offline",
    lastConnectionStatus: "offline",
    lastConnectionError: "connect ECONNREFUSED",
  });
  expect(screen.getByTestId("remote-connection-failure")).toBeTruthy();
  cleanup();
  for (const lastConnectionStatus of ["online", "offline"]) {
    await hoverConnecting({ connectionStatus: lastConnectionStatus, lastConnectionStatus });
    expect(screen.queryByTestId("remote-connection-progress")).toBeNull();
    expect(screen.queryByTestId("remote-connection-failure")).toBeNull();
    cleanup();
  }
});

it("URL Server 直连不属于 Source 管理域，连接中不显示进度区且不读取日志", async () => {
  remote.device = { profileId: PROFILE };
  const details = await hoverConnecting({
    kind: "server",
    target: { kind: "server", url: "https://example.com" },
  });
  expect(remote.requestedProfileIds.at(-1)).toEqual([]);
  expect(screen.queryByTestId("remote-connection-progress")).toBeNull();
  expect(details.textContent).toContain("remote.status.connecting");
});

it("断线后首次重试前只显示自动恢复，不用上一次成功连接的阶段和耗时", async () => {
  // 修复原因：Host 最近日志仍是两小时前那次成功连接，曾显示“第 4/4 步 · 已用 120 分”。
  vi.spyOn(Date, "now").mockReturnValue(8_000 + 2 * 60 * 60 * 1000);
  remote.device = { profileId: PROFILE, state: "retrying", recoveryAttempt: 1, recoveryLimit: 3 };
  const entry = (phase: string, timestamp: number, progress?: number) => ({
    profileId: PROFILE,
    operation: "connect",
    phase,
    level: "info",
    message: phase,
    timestamp,
    ...(progress === undefined ? {} : { progress }),
  });
  remote.logs = {
    [PROFILE]: [entry("probe", 8_000), entry("daemon", 9_000), entry("ready", 10_000, 1)],
  };
  await hoverConnecting();
  const progress = screen.getByTestId("remote-connection-progress");
  expect(progress.textContent).toContain("remote.phase.channel");
  expect(progress.textContent).toContain('remote.progress.step{"current":1,"total":4}');
  expect(progress.textContent).not.toContain("remote.progress.elapsed");
  expect(progress.textContent).toContain(
    'workspaceSidebar.recoveringAutomaticShort{"attempt":1,"limit":3}',
  );
});

it("已复制只对应被复制的错误原文，错误变化后恢复为复制按钮", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const props = (lastConnectionError: string) => ({
    host: {
      ...host,
      connectionStatus: "offline",
      lastConnectionStatus: "failed",
      lastConnectionError,
    },
    title: "Task",
    paths: ["/home/dev/test2"],
    children: createElement("button", { type: "button" }, "remote row"),
  });
  const { rerender } = render(createElement(RemoteIdentityHoverCard, props("first failure")));
  fireEvent.pointerEnter(screen.getByText("remote row"), { pointerType: "mouse" });
  fireEvent.click(await screen.findByTestId("remote-connection-copy-error"));
  await waitFor(() =>
    expect(screen.getByTestId("remote-connection-copy-error").textContent).toBe(
      "remote.progress.copied",
    ),
  );
  rerender(createElement(RemoteIdentityHoverCard, props("second failure")));
  expect(screen.getByTestId("remote-connection-copy-error").textContent).toBe(
    "remote.progress.copyError",
  );
  vi.unstubAllGlobals();
  vi.stubGlobal("PointerEvent", MouseEvent);
});
