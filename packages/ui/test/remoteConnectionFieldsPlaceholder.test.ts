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

function renderRemoteConnectionFields() {
  return renderToStaticMarkup(
    createElement(
      PlatformProvider,
      { platform },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(RemoteConnectionFields, {
          kind: "docker",
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
  it("Docker 手动模式保留切换列表入口与空输入提示", () => {
    const html = renderRemoteConnectionFields();

    expect(html).toContain("选择运行中的容器");
    expect(html).not.toContain('data-testid="docker-container-select"');
    expect(html).toContain("如果运行中的容器列表不完整，可以手动输入容器名或 ID 连接。");
  });
});
