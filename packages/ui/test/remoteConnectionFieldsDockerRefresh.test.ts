import type { ReactElement, ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  DockerContainerInfo,
  IPlatformService,
  RemoteAssetInstallMode,
  RemoteTarget,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";

type MockSelectProps = {
  children?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  onValueChange?: (value: string) => void;
  value?: string;
};

const selectMockState = vi.hoisted(() => ({
  selectProps: [] as MockSelectProps[],
  popoverProps: [] as MockSelectProps[],
}));

vi.mock("@/components/ui/select.js", async () => {
  const React = await import("react");

  return {
    Select: ({ children, ...props }: MockSelectProps) => {
      selectMockState.selectProps.push(props);
      return React.createElement("div", { "data-testid": "mock-select" }, children);
    },
    SelectContent: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children),
    SelectItem: ({ children }: { children?: ReactNode; value: string }) =>
      React.createElement("div", null, children),
    SelectTrigger: ({ children }: { children?: ReactNode }) =>
      React.createElement("button", null, children),
    SelectValue: () => React.createElement("span", null),
  };
});

vi.mock("@/components/ui/popover.js", async () => {
  const React = await import("react");

  return {
    Popover: ({ children, ...props }: MockSelectProps) => {
      selectMockState.popoverProps.push(props);
      return React.createElement("div", { "data-testid": "mock-popover" }, children);
    },
    PopoverAnchor: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children),
    PopoverContent: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", { "data-testid": "mock-popover-content" }, children),
    PopoverTrigger: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children),
  };
});

import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { RemoteConnectionFields } from "@/RemoteConnectionFields.js";

type RemoteConnectionFieldsTestProps = {
  kind: RemoteTarget["kind"];
  host: string;
  port: string;
  username: string;
  sshAuthMethod: "password" | "privateKey";
  assetInstallMode: RemoteAssetInstallMode;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslDistro: string;
  wslDistros: WSLDistro[];
  dockerContainer: string;
  manualDockerContainer: string;
  serverUrl: string;
  serverName: string;
  serverToken: string;
  serverWorkspacePath: string;
  dockerContainers: DockerContainerInfo[];
  dockerAvailable: boolean | null;
  sshConfigAliases: SSHConfigAliasOption[];
  sshConfigAliasesLoading: boolean;
  sshConfigAliasesError: string;
  selectedSshConfigAlias: string | null;
  runtimeOptionsLoading: boolean;
  refreshDockerContainers: () => void;
  applySshConfigAlias: (value: SSHConfigAliasOption) => void;
  clearSelectedSshConfigAlias: () => void;
  setHost: (value: string) => void;
  setPort: (value: string) => void;
  setUsername: (value: string) => void;
  setSshAuthMethod: (value: "password" | "privateKey") => void;
  setAssetInstallMode: (value: RemoteAssetInstallMode) => void;
  setPassword: (value: string) => void;
  setPrivateKeyPath: (value: string) => void;
  setPrivateKeyPassphrase: (value: string) => void;
  setWslDistro: (value: string) => void;
  setDockerContainer: (value: string) => void;
  setManualDockerContainer: (value: string) => void;
  setServerUrl: (value: string) => void;
  setServerName: (value: string) => void;
  setServerToken: (value: string) => void;
  setServerWorkspacePath: (value: string) => void;
};

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

const dockerContainers: DockerContainerInfo[] = [
  {
    id: "abc123",
    image: "ubuntu:latest",
    name: "zcode-dev",
    state: "running",
    status: "Up 2 minutes",
  },
];

function renderDockerFields({
  dockerContainer,
  manualDockerContainer = "",
  dockerAvailable = true,
  dockerContainers: nextDockerContainers = dockerContainers,
  runtimeOptionsLoading = false,
  refreshDockerContainers,
}: {
  dockerContainer?: string;
  manualDockerContainer?: string;
  dockerAvailable?: boolean | null;
  dockerContainers?: DockerContainerInfo[];
  runtimeOptionsLoading?: boolean;
  refreshDockerContainers: () => void;
}) {
  const props: RemoteConnectionFieldsTestProps = {
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
    dockerContainer: dockerContainer ?? nextDockerContainers[0]?.name ?? "",
    manualDockerContainer,
    serverUrl: "",
    serverName: "",
    serverToken: "",
    serverWorkspacePath: "",
    dockerContainers: nextDockerContainers,
    dockerAvailable,
    sshConfigAliases: [],
    sshConfigAliasesLoading: false,
    sshConfigAliasesError: "",
    selectedSshConfigAlias: null,
    runtimeOptionsLoading,
    refreshDockerContainers,
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
  };
  const Component = RemoteConnectionFields as unknown as (
    props: RemoteConnectionFieldsTestProps,
  ) => ReactElement;

  selectMockState.selectProps = [];
  selectMockState.popoverProps = [];
  return renderToStaticMarkup(
    createElement(
      PlatformProvider,
      { platform },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(Component, props),
      ),
    ),
  );
}

describe("RemoteConnectionFields Docker refresh", () => {
  it("uses Popover instead of Select and refreshes running containers only when the Docker chooser opens", () => {
    const refreshDockerContainers = vi.fn();

    renderDockerFields({ refreshDockerContainers });

    expect(selectMockState.selectProps).toHaveLength(0);
    expect(selectMockState.popoverProps).toHaveLength(1);
    const [dockerPopoverProps] = selectMockState.popoverProps;

    dockerPopoverProps?.onOpenChange?.(false);
    expect(refreshDockerContainers).not.toHaveBeenCalled();

    dockerPopoverProps?.onOpenChange?.(true);
    expect(refreshDockerContainers).toHaveBeenCalledTimes(1);
  });

  it("shows loading feedback while refreshing containers from the opened chooser", () => {
    const html = renderDockerFields({
      runtimeOptionsLoading: true,
      refreshDockerContainers: vi.fn(),
    });

    expect(html).toContain("正在检测运行中的容器");
    expect(html).toContain("animate-spin");
  });

  it("shows an empty Docker container hint in the chooser when no containers are available", () => {
    const html = renderDockerFields({
      dockerContainers: [],
      refreshDockerContainers: vi.fn(),
    });

    expect(html).toContain("未检测到运行中容器");
  });

  it("shows the same short hint when Docker availability detection reports unavailable", () => {
    const html = renderDockerFields({
      dockerAvailable: false,
      dockerContainers: [],
      refreshDockerContainers: vi.fn(),
    });

    expect(html).toContain("未检测到运行中容器");
    expect(html).not.toContain("当前环境未检测到可用的 Docker 运行环境");
  });

  it("renders an independent manual container input without replacing the selected container label", () => {
    const html = renderDockerFields({
      dockerContainer: "zcode-dev",
      manualDockerContainer: "manual-dev",
      refreshDockerContainers: vi.fn(),
    });

    expect(html).toContain('data-testid="docker-container-input"');
    expect(html).toContain('value="manual-dev"');
    expect(html).toContain("zcode-dev");
  });

  it("shows a helper hint when the manual Docker container input is empty", () => {
    const html = renderDockerFields({
      manualDockerContainer: "",
      refreshDockerContainers: vi.fn(),
    });

    expect(html).toContain(
      "如果运行中的容器列表不完整，可以手动输入容器名或 ID 连接。",
    );
  });
});
