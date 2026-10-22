// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { RemoteConnectionStatusTag } from "@/remote-connection/RemoteConnectionTags.js";
import { RemoteConnectionNavigationDot } from "@/remote-connection/RemoteConnectionNavigationDot.js";
import { RemoteTaskDeviceLabel } from "@/remote-connection/RemoteTaskDeviceLabel.js";
import { RemoteProjectConnectionDetails } from "@/WorkspaceSidebar/RemoteProjectConnectionDetails.js";
import { RemoteConnectionConnectingStep } from "@/remote-connection/RemoteConnectionConnectingStep.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import zh from "@/i18n/locales/zh-CN.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        Object.entries(values ?? {}).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          zh[id] ?? id,
        ),
    },
  }),
}));
afterEach(cleanup);

it("恢复标签使用短句并分隔状态，详情保留完整恢复说明", () => {
  const presentation = resolveRemoteConnectionPresentation({
    state: "retrying",
    recoveryAttempt: 2,
    recoveryLimit: 3,
    target: { kind: "docker", container: "dev" },
  });
  const { container } = render(
    createElement(RemoteProjectConnectionDetails, {
      tab: {
        id: "project",
        kind: "workspace",
        label: "Project",
        workspacePath: "/srv/project",
        remoteTarget: { kind: "docker", container: "dev" },
      },
      deviceName: "Dev",
      presentation,
    }),
  );
  expect(container.querySelector("[data-remote-connection-status]")?.textContent).toBe(
    "连接中 · 自动恢复 2/3",
  );
  expect(screen.getByText("正在自动恢复连接（2/3）")).toBeTruthy();
  expect(screen.getByText("Docker · dev")).toBeTruthy();
});

it("状态标签与详情卡显示需要处理及更新方向", () => {
  const presentation = resolveRemoteConnectionPresentation({
    state: "needs-upgrade",
    upgradeTarget: "controller",
  });
  const { container } = render(
    createElement(RemoteProjectConnectionDetails, {
      tab: { id: "project", kind: "workspace", label: "Project", workspacePath: "/srv/project" },
      deviceName: "Dev",
      presentation,
    }),
  );
  expect(screen.getByText("需要处理", { exact: false })).toBeTruthy();
  expect(screen.getByText("需要更新")).toBeTruthy();
  expect(container.querySelector('[data-remote-connection-status="pending"]')?.className).toContain(
    "text-warning-surface-foreground",
  );
});

it("导航点读取模型的进行中色，恢复进度是可见文字", () => {
  const presentation = resolveRemoteConnectionPresentation({
    state: "retrying",
    recoveryAttempt: 2,
    recoveryLimit: 3,
  });
  const { container } = render(
    createElement(
      "div",
      null,
      createElement(RemoteConnectionNavigationDot, { presentation }),
      createElement(RemoteConnectionStatusTag, { presentation }),
    ),
  );
  expect(screen.getByText("自动恢复 2/3")).toBeTruthy();
  expect(
    container.querySelector('[data-remote-navigation-status="connecting"]')?.className,
  ).toContain("progress-surface-foreground");
});

it("任务行设备标签读取同一服务快照的安装门禁", async () => {
  const emitter = new Emitter();
  const management = {
    getSnapshot: async () => ({
      servers: [{ sourceServerId: "device", displayName: "Dev", installState: "installed" }],
      profiles: [
        {
          profileId: "profile",
          sourceServerId: "device",
          target: { kind: "docker", container: "dev" },
        },
      ],
      states: [{ profileId: "profile", state: "needs-install", updatedAt: 1 }],
    }),
    onDidChangeState: emitter.event,
  };
  render(
    createElement(ServiceProvider, {
      services: { sourceServerManagementService: management } as never,
      children: createElement(RemoteTaskDeviceLabel, {
        task: { workspacePath: "/srv", sourceServerId: "device", serverDisplayName: "Dev" },
      }),
    }),
  );
  expect(await screen.findByText("需要安装")).toBeTruthy();
});

it("向导按下载失败分类展示标题，只在本地下载时提供切换操作", () => {
  const onRetry = vi.fn();
  const target = {
    kind: "ssh" as const,
    host: "dev",
    username: "user",
    assetInstallMode: "remote-download" as const,
  };
  const child = createElement(RemoteConnectionConnectingStep, {
    kind: "ssh",
    target,
    loading: false,
    logs: [],
    errorMessage: "download failed",
    errorCode: "remote-download-failed",
    onBack: vi.fn(),
    onRetry,
    onUseRemoteDownload: vi.fn(),
  });
  render(createElement(PlatformProvider, { platform: {} as never, children: child }));
  expect(screen.getByText("资源下载失败")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "改用远端下载" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(onRetry).toHaveBeenCalledOnce();
});

it.each([false, true])("连接中补凭据可显隐且不触发提交：口令=%s", (passphrase) => {
  const onSubmit = vi.fn();
  const child = createElement(RemoteConnectionConnectingStep, {
    kind: "ssh",
    errorMessage: "",
    loading: false,
    logs: [],
    onBack: vi.fn(),
    onRetry: vi.fn(),
    credentials: { value: "secret", passphrase, onChange: vi.fn(), onSubmit },
  });
  render(createElement(PlatformProvider, { platform: {} as never, children: child }));
  const input = screen.getByLabelText(passphrase ? "私钥口令（可选）" : "密码");
  expect(input.getAttribute("type")).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
  expect(input.getAttribute("type")).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "隐藏密码" }));
  expect(input.getAttribute("type")).toBe("password");
  expect(onSubmit).not.toHaveBeenCalled();
});
