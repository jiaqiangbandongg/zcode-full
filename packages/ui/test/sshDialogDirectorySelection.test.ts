import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";

// 回归背景（docs/remote-workspace-provider-sync-hang.md）：3.8.1 中 onSelectProject 的
// Promise 永久 pending 会让向导「选择目录」按钮永远停在加载中。修复保证该 Promise 必定
// settle 后，这里锁定向导侧的收口契约：rejection 必须复位 selecting 并把错误展示给用户。
const captured = vi.hoisted(() => ({
  kindProps: [] as Array<Record<string, unknown>>,
  settingsProps: [] as Array<Record<string, unknown>>,
  directoryProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("lucide-react", () => ({
  AlertTriangleIcon: () => null,
}));

vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => async () => true,
}));

vi.mock("@/hooks/useCancelPendingRemoteConnection.js", () => ({
  useCancelPendingRemoteConnection: () => vi.fn(async () => undefined),
}));

vi.mock("@/hooks/useRemoteConnectionLogs.js", () => ({
  useRemoteConnectionLogs: () => ({
    connectionLogs: [],
    resetConnectionLogs: () => {},
  }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({}),
}));

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/useRemoteConnectionForm.js", () => ({
  useRemoteConnectionForm: () => ({
    kind: "ssh",
    host: "demo.internal",
    port: "22",
    username: "root",
    sshAuthMethod: "password",
    assetInstallMode: "local-download-upload",
    password: "test-only-password",
    privateKeyPath: "",
    privateKeyPassphrase: "",
    wslDistro: "",
    wslUser: "",
    dockerContainer: "",
    manualDockerContainer: "",
    serverUrl: "",
    serverName: "",
    serverToken: "",
    serverWorkspacePath: "",
    sshConfigAliases: [],
    sshConfigAliasesLoading: false,
    sshConfigAliasesError: "",
    selectedSshConfigAlias: null,
    dockerAvailable: null,
    wslDistros: [],
    dockerContainers: [],
    availableKinds: ["ssh"],
    setKind: () => {},
    setHost: () => {},
    setPort: () => {},
    setUsername: () => {},
    setSshAuthMethod: () => {},
    setAssetInstallMode: () => {},
    setPassword: () => {},
    setPrivateKeyPath: () => {},
    setPrivateKeyPassphrase: () => {},
    setWslDistro: () => {},
    setWslUser: () => {},
    setDockerContainer: () => {},
    setManualDockerContainer: () => {},
    setServerUrl: () => {},
    setServerName: () => {},
    setServerToken: () => {},
    setServerWorkspacePath: () => {},
    refreshDockerContainers: () => {},
    applySshConfigAlias: () => {},
    clearSelectedSshConfigAlias: () => {},
    currentRuntimeOptionsLoading: false,
    currentRuntimeOptionsError: "",
  }),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children }: { children?: unknown }) =>
    createElement("button", { type: "button" }, children as never),
  buttonVariants: () => "",
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: unknown }) =>
    open ? createElement("div", null, children as never) : null,
  DialogContent: ({ children }: { children?: unknown }) =>
    createElement("div", null, children as never),
  DialogHeader: ({ children }: { children?: unknown }) =>
    createElement("div", null, children as never),
}));

vi.mock("@/RemoteConnectionWizardChrome.js", () => ({
  RemoteConnectionWizardSidebar: () => null,
  RemoteConnectionWizardHeader: () => null,
}));

vi.mock("@/RemoteConnectionDialogContent.js", () => ({
  RemoteConnectionKindStep: (props: Record<string, unknown>) => {
    captured.kindProps.push(props);
    return null;
  },
  RemoteConnectionSettingsStep: (props: Record<string, unknown>) => {
    captured.settingsProps.push(props);
    return null;
  },
  RemoteConnectionConnectingStep: () => null,
  RemoteConnectionDirectoryStep: (props: Record<string, unknown>) => {
    captured.directoryProps.push(props);
    return null;
  },
}));

import { RemoteConnectionDialog } from "@/SSHDialog.js";
import {
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom(createdTextValues: string[]) {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => {
      createdTextValues.push(nodeValue);
      return {
        nodeType: 3,
        nodeValue,
        ownerDocument: documentMock,
        parentNode: null,
      };
    },
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function latest<T>(entries: T[]): T {
  const entry = entries.at(-1);
  if (!entry) {
    throw new Error("expected at least one captured render");
  }
  return entry;
}

async function driveDialogToDirectoryStep(params: {
  root: Root;
  onSelectProject: (sessionId: string, path: string) => Promise<void>;
}) {
  const connect = deferred<string>();
  await act(async () => {
    params.root.render(
      createElement(RemoteConnectionDialog, {
        open: true,
        onConnect: () => connect.promise,
        onSelectProject: params.onSelectProject,
        onCancelSession: vi.fn(async () => undefined),
      }),
    );
  });
  await act(async () => {
    (latest(captured.kindProps).onNext as () => void)();
  });
  await act(async () => {
    (latest(captured.settingsProps).onConnect as () => void)();
  });
  await act(async () => {
    connect.resolve("session-1");
    await connect.promise;
  });
  expect(latest(captured.directoryProps).selecting).toBe(false);
}

describe("RemoteConnectionDialog 选目录失败收口", () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    unregisterRemoteWorkspaceSession("session-1");
    captured.kindProps.length = 0;
    captured.settingsProps.length = 0;
    captured.directoryProps.length = 0;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("onSelectProject reject 后复位 selecting、展示错误并停留在目录步骤", async () => {
    const createdTextValues: string[] = [];
    const container = installMinimalDom(createdTextValues);
    root = createRoot(container);
    // session 仍在 store 中：失败后应保留目录步骤供用户重试。
    registerRemoteWorkspaceSession({
      sessionId: "session-1",
      services: {} as IServiceAccessor,
    });
    const selection = deferred<void>();
    const onSelectProject = vi.fn(() => selection.promise);

    await driveDialogToDirectoryStep({ root, onSelectProject });

    await act(async () => {
      (latest(captured.directoryProps).onSelect as (path: string) => void)("/root/project");
    });
    expect(onSelectProject).toHaveBeenCalledWith("session-1", "/root/project", undefined);
    expect(latest(captured.directoryProps).selecting).toBe(true);

    await act(async () => {
      selection.reject(new Error("select failed boom"));
      await selection.promise.catch(() => undefined);
    });

    // 核心收口：按钮不得停留在「加载中」，错误必须可见，目录步骤保留可重试。
    expect(latest(captured.directoryProps).selecting).toBe(false);
    expect(createdTextValues).toContain("select failed boom");
  });

  it("session 已被回收时 reject 回落到设置步骤且 selecting 复位", async () => {
    const createdTextValues: string[] = [];
    const container = installMinimalDom(createdTextValues);
    root = createRoot(container);
    // 不注册 session-1：模拟同步失败路径里 handleCancelRemoteProject 已回收 session。
    const selection = deferred<void>();
    const onSelectProject = vi.fn(() => selection.promise);

    await driveDialogToDirectoryStep({ root, onSelectProject });

    const directoryRendersBeforeFailure = captured.directoryProps.length;
    await act(async () => {
      (latest(captured.directoryProps).onSelect as (path: string) => void)("/root/project");
    });
    expect(latest(captured.directoryProps).selecting).toBe(true);
    expect(captured.directoryProps.length).toBeGreaterThan(directoryRendersBeforeFailure);
    const settingsRendersBeforeFailure = captured.settingsProps.length;

    await act(async () => {
      selection.reject(new Error("sync rejected"));
      await selection.promise.catch(() => undefined);
    });

    // 失败状态判定（getRemoteConnectionDirectoryFailureState）：session 不在 → 回设置步骤。
    // 回落后 DirectoryStep 不再渲染，selecting 复位由目录步骤用例覆盖；这里断言
    // 向导没有卡死：设置步骤重新可交互（非 loading），错误对用户可见。
    expect(captured.settingsProps.length).toBeGreaterThan(settingsRendersBeforeFailure);
    expect(latest(captured.settingsProps).loading).toBe(false);
    expect(createdTextValues).toContain("sync rejected");
  });
});
