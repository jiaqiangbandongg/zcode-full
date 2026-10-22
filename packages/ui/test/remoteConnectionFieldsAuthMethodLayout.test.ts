// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { RemoteConnectionFields } from "@/RemoteConnectionFields.js";
import type { IPlatformService } from "@zcode/shared";

const platform: IPlatformService = {
  activateOrSetWorkspace: vi.fn(),
  cancelRemoteConnection: vi.fn(),
  connectRemote: vi.fn(),
  detectShell: vi.fn(),
  getDataBaseDir: vi.fn(),
  getDefaultShell: vi.fn(),
  getShells: vi.fn(),
  isDockerAvailable: vi.fn(),
  isWindowsDesktop: vi.fn(),
  listDockerContainers: vi.fn(),
  listSSHConfigAliases: vi.fn(),
  listWSLDistros: vi.fn(),
  log: vi.fn(),
  notifyRendererReady: vi.fn(),
  onOAuthCallback: vi.fn(),
  onRemoteConnectionLog: vi.fn(),
  openExternal: vi.fn(),
  registerOAuthState: vi.fn(),
  selectDirectory: vi.fn(),
  selectFile: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function renderRemoteConnectionFields(
  locale: "zh-CN" | "en-US",
  overrides: Partial<ComponentProps<typeof RemoteConnectionFields>> = {},
) {
  return render(
    createElement(
      PlatformProvider,
      { platform },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(RemoteConnectionFields, {
          kind: "ssh",
          host: "",
          port: "22",
          username: "",
          sshAuthMethod: "password",
          assetInstallMode: "local-download-upload",
          password: "",
          privateKeyPath: "",
          privateKeyPassphrase: "",
          wslDistro: "",
          wslDistros: [],
          dockerContainer: "",
          manualDockerContainer: "",
          serverUrl: "",
          serverName: "",
          serverToken: "",
          serverWorkspacePath: "",
          dockerContainers: [],
          dockerAvailable: null,
          sshConfigAliases: [],
          sshConfigAliasesLoading: false,
          sshConfigAliasesError: "",
          selectedSshConfigAlias: null,
          runtimeOptionsLoading: false,
          applySshConfigAlias: vi.fn(),
          clearSelectedSshConfigAlias: vi.fn(),
          setHost: vi.fn(),
          setPort: vi.fn(),
          setUsername: vi.fn(),
          setSshAuthMethod: vi.fn(),
          setAssetInstallMode: vi.fn(),
          setPassword: vi.fn(),
          setPrivateKeyPath: vi.fn(),
          setPrivateKeyPassphrase: vi.fn(),
          setWslDistro: vi.fn(),
          setDockerContainer: vi.fn(),
          setManualDockerContainer: vi.fn(),
          setServerUrl: vi.fn(),
          setServerName: vi.fn(),
          setServerToken: vi.fn(),
          setServerWorkspacePath: vi.fn(),
          ...overrides,
        }),
      ),
    ),
  );
}

it("认证与下载方式有组名和选中状态，密码可显示再隐藏", () => {
  renderRemoteConnectionFields("zh-CN");
  const auth = screen.getByRole("group", { name: "认证方式" });
  expect(within(auth).getByRole("button", { pressed: true }).textContent).toBe("密码");
  const password = screen.getByLabelText("密码");
  expect(password.getAttribute("type")).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
  expect(password.getAttribute("type")).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "隐藏密码" }));
  expect(password.getAttribute("type")).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: /高级/ }));
  const download = screen.getByRole("group", { name: "资源下载方式" });
  expect(within(download).getByRole("button", { pressed: true })).toBeTruthy();
  expect(within(download).getByRole("button", { pressed: false })).toBeTruthy();
});

it.each([
  { kind: "ssh", sshAuthMethod: "privateKey", label: "私钥口令（可选）" },
  { kind: "server", sshAuthMethod: "password", label: "Token（可选）" },
] as const)("$kind 的口令字段可以显示和隐藏且标签关联", ({ kind, sshAuthMethod, label }) => {
  renderRemoteConnectionFields("zh-CN", { kind, sshAuthMethod });
  const input = screen.getByLabelText(label);
  expect(input.getAttribute("type")).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
  expect(input.getAttribute("type")).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "隐藏密码" }));
  expect(input.getAttribute("type")).toBe("password");
});

it("Docker 容器列表可从搜索框使用方向键与回车选择", async () => {
  const setDockerContainer = vi.fn();
  renderRemoteConnectionFields("zh-CN", {
    kind: "docker",
    dockerContainer: "alpha",
    dockerAvailable: true,
    dockerContainers: ["alpha", "beta"].map((name) => ({
      id: name,
      name,
      image: "ubuntu",
      state: "running",
      status: "Up",
    })),
    setDockerContainer,
  });
  fireEvent.click(screen.getByTestId("docker-container-select"));
  const search = await screen.findByRole("combobox");
  await waitFor(() => expect(document.activeElement).toBe(search));
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(setDockerContainer).toHaveBeenCalledWith("beta");
});
