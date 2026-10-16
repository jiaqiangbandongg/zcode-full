import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

function renderRemoteConnectionFields(kind: "ssh" | "docker") {
  return renderToStaticMarkup(
    createElement(
      PlatformProvider,
      { platform },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(RemoteConnectionFields, {
          kind,
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
        }),
      ),
    ),
  );
}

describe("RemoteConnectionFields placeholder", () => {
  it("SSH 必填字段用输入提示承载示例，避免看起来像默认值", () => {
    const html = renderRemoteConnectionFields("ssh");

    expect(html).toContain('placeholder="输入主机地址或 IP，例如 192.168.1.100"');
    expect(html).toContain('placeholder="输入用户名，例如 root"');
  });

  it("Docker 容器选择器无可用容器时展示空态提示，并提供独立手动输入框", () => {
    const html = renderRemoteConnectionFields("docker");

    expect(html).toContain("未检测到运行中容器");
    expect(html).toContain('placeholder="输入容器名或 ID，例如 my-container"');
    expect(html).toContain(
      "如果运行中的容器列表不完整，可以手动输入容器名或 ID 连接。",
    );
  });
});
