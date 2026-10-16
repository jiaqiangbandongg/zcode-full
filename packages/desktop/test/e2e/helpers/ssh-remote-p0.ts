/* eslint-disable max-lines -- SSH P0 helper 集中维护真实连接、远端身份、进程与 replay tunnel 生命周期，拆散会隐藏同一条安全边界。 */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Client as SSHClient, type ClientChannel, type TcpConnectionDetails } from "ssh2";
import {
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_REMOTE_KIND_SSH,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_SSH_HOST_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_PORT_INPUT,
  TID_SSH_SUCCESS,
  TID_SSH_USERNAME_INPUT,
  buildRemoteWorkspaceIdentity,
  type RemoteTarget,
} from "@zcode/shared";
import {
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForWorkspaceApp,
} from "./desktop-app.js";
import { resolveSeededReplayBaseUrl } from "./custom-openai-provider-store.js";
import { startNewV4Draft } from "./v4-conversation.js";
import {
  isMainRendererUrl,
  isResourceManagerUrl,
  listHostProcessIdentities,
  openResourceManager,
  switchToElectronRendererTarget,
  waitForResourceManagerReady,
} from "./resource-manager.js";

export const SSH_CONNECT_TIMEOUT_MS = 10 * 60_000;
export const SSH_WORKSPACE_READY_TIMEOUT_MS = 2 * 60_000;

export interface SSHConnectionConfig {
  host: string;
  password: string;
  port: number;
  username: string;
}

export interface SSHRuntimeConfig extends SSHConnectionConfig {
  workspacePaths: readonly [string, string];
}

export interface SingleSSHWorkspaceRuntimeConfig extends SSHConnectionConfig {
  workspacePath: string;
}

export interface DualSSHRuntimeConfig {
  targets: readonly [SSHConnectionConfig, SSHConnectionConfig];
  workspacePath: string;
}

export interface RemoteTabSnapshot {
  activeWorkspaceIdentity: string | null;
  activeWorkspacePath: string | null;
  remoteHost: string | null;
  remoteKind: string | null;
  remoteSessionId: string | null;
  secretPersistedInTab: boolean;
  workspaceIdentity: string | null;
  workspacePath: string | null;
}

export interface ReplayTunnel {
  baseURL: string;
  close(): Promise<void>;
}

export interface FirstConnectionStallingSSHProxy {
  firstConnectionAccepted: Promise<void>;
  port: number;
  waitForFirstConnectionClosed(): Promise<void>;
  close(): Promise<void>;
}

export async function createFirstConnectionStallingSSHProxy(
  config: Pick<SSHRuntimeConfig, "host" | "port">,
  caseMarker: string,
): Promise<FirstConnectionStallingSSHProxy> {
  let markFirstConnectionAccepted!: () => void;
  const firstConnectionAccepted = new Promise<void>((resolve) => {
    markFirstConnectionAccepted = resolve;
  });
  let markFirstConnectionClosed!: () => void;
  const firstConnectionClosed = new Promise<void>((resolve) => {
    markFirstConnectionClosed = resolve;
  });
  const sockets = new Set<Socket>();
  let connectionCount = 0;
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createServer((client) => {
    trackSocket(client);
    connectionCount += 1;
    if (connectionCount === 1) {
      // 第一个 TCP connection 故意不转发 SSH 握手，稳定保留 pending cancel 窗口。
      markFirstConnectionAccepted();
      client.once("error", () => client.destroy());
      client.once("close", markFirstConnectionClosed);
      return;
    }

    const upstream = createConnection({ host: config.host, port: config.port });
    trackSocket(upstream);
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once("error", closeBoth);
    upstream.once("error", closeBoth);
    upstream.once("connect", () => client.pipe(upstream).pipe(client));
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  const port = await listenOnLoopback(server, caseMarker);

  return {
    firstConnectionAccepted,
    port,
    waitForFirstConnectionClosed: () => firstConnectionClosed,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    },
  };
}

export function readSSHRuntimeConfig(caseMarker: string): SSHRuntimeConfig {
  const host = requireSecretEnv("ZCODE_E2E_SSH_HOST", caseMarker);
  const username = requireSecretEnv("ZCODE_E2E_SSH_USERNAME", caseMarker);
  const password = requireSecretEnv("ZCODE_E2E_SSH_PASSWORD", caseMarker);
  const portText = process.env.ZCODE_E2E_SSH_PORT?.trim() || "22";
  const port = Number.parseInt(portText, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_PORT 必须是 1..65535 的整数`);
  }

  const workspacePaths = (
    process.env.ZCODE_E2E_SSH_WORKSPACE_PATHS?.split(",") ?? ["/root", "/home"]
  )
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    workspacePaths.length !== 2 ||
    workspacePaths.some((value) => !value.startsWith("/")) ||
    workspacePaths[0] === workspacePaths[1]
  ) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_WORKSPACE_PATHS 必须是两个不同的绝对路径`);
  }

  return {
    host,
    password,
    port,
    username,
    workspacePaths: [workspacePaths[0]!, workspacePaths[1]!],
  };
}

export function readSingleSSHWorkspaceRuntimeConfig(
  caseMarker: string,
): SingleSSHWorkspaceRuntimeConfig {
  const host = requireSecretEnv("ZCODE_E2E_SSH_HOST", caseMarker);
  const username = requireSecretEnv("ZCODE_E2E_SSH_USERNAME", caseMarker);
  const password = requireSecretEnv("ZCODE_E2E_SSH_PASSWORD", caseMarker);
  const port = parseSSHPort(
    process.env.ZCODE_E2E_SSH_PORT?.trim() || "22",
    `${caseMarker}: ZCODE_E2E_SSH_PORT`,
  );
  const workspacePath =
    process.env.ZCODE_E2E_SSH_WORKSPACE_PATH?.trim() ||
    process.env.ZCODE_E2E_SSH_SHARED_WORKSPACE_PATH?.trim() ||
    "/root/workspace";
  if (!workspacePath.startsWith("/")) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_WORKSPACE_PATH 必须是绝对路径`);
  }

  return { host, password, port, username, workspacePath };
}

export function readDualSSHRuntimeConfig(caseMarker: string): DualSSHRuntimeConfig {
  const commonHost = process.env.ZCODE_E2E_SSH_HOST?.trim();
  const commonUsername = process.env.ZCODE_E2E_SSH_USERNAME?.trim();
  const commonPassword = process.env.ZCODE_E2E_SSH_PASSWORD?.trim();
  const workspacePath = process.env.ZCODE_E2E_SSH_SHARED_WORKSPACE_PATH?.trim() || "/workspace";
  if (!workspacePath.startsWith("/")) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_SHARED_WORKSPACE_PATH 必须是绝对路径`);
  }

  const readTarget = (suffix: "A" | "B"): SSHConnectionConfig => {
    const host = process.env[`ZCODE_E2E_SSH_${suffix}_HOST`]?.trim() || commonHost;
    const username = process.env[`ZCODE_E2E_SSH_${suffix}_USERNAME`]?.trim() || commonUsername;
    const password = process.env[`ZCODE_E2E_SSH_${suffix}_PASSWORD`]?.trim() || commonPassword;
    const portText = process.env[`ZCODE_E2E_SSH_${suffix}_PORT`]?.trim();
    if (!host || !username || !password || !portText) {
      throw new Error(`${caseMarker}: dual SSH target ${suffix} 缺少 host/username/password/port`);
    }
    const port = parseSSHPort(portText, `${caseMarker}: target ${suffix}`);
    return { host, password, port, username };
  };

  const targets = [readTarget("A"), readTarget("B")] as const;
  if (
    targets[0].host === targets[1].host &&
    targets[0].port === targets[1].port &&
    targets[0].username === targets[1].username
  ) {
    throw new Error(`${caseMarker}: dual SSH target 必须产生两个不同 remote identity`);
  }
  return { targets, workspacePath };
}

export async function connectSSHWorkspace(options: {
  caseMarker: string;
  config: SSHConnectionConfig;
  workspacePath: string;
}): Promise<RemoteTabSnapshot> {
  await startNewV4Draft();
  await openSSHRemoteDialog(options.caseMarker);
  await fillSSHPasswordSettings(options.config);
  await clickLastEnabledSSHDialogButton(options.caseMarker);
  await waitForSSHDirectoryStep(options.caseMarker);
  await selectSSHRemoteDirectory(options.workspacePath, options.caseMarker);
  await waitForWorkspaceApp(options.workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);

  const target: RemoteTarget = {
    kind: "ssh",
    host: options.config.host,
    port: options.config.port,
    username: options.config.username,
  };
  return waitForRemoteTab({
    caseMarker: options.caseMarker,
    expectedIdentity: buildRemoteWorkspaceIdentity(options.workspacePath, target),
    expectedPath: options.workspacePath,
  });
}

export async function openSSHRemoteDialog(caseMarker: string): Promise<void> {
  await clickTestIdByWebDriver(TID_COMPOSER_WORKSPACE_TRIGGER, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 空草稿没有显示 workspace 菜单`,
  });
  await clickTestIdByWebDriver(TID_COMPOSER_REMOTE_CONNECTION, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: workspace 菜单没有显示远程连接入口`,
  });
  await clickTestIdByWebDriver(TID_REMOTE_KIND_SSH, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 远程连接向导没有显示 SSH transport`,
  });
  await clickLastEnabledSSHDialogButton(caseMarker);
}

export async function fillSSHPasswordSettings(config: SSHConnectionConfig): Promise<void> {
  await setInputValueByTestIdDom(TID_SSH_HOST_INPUT, config.host);
  await setInputValueByTestIdDom(TID_SSH_PORT_INPUT, String(config.port));
  await setInputValueByTestIdDom(TID_SSH_USERNAME_INPUT, config.username);
  await setInputValueByTestIdDom(TID_SSH_PASSWORD_INPUT, config.password);
}

export async function clickLastEnabledSSHDialogButton(caseMarker: string): Promise<void> {
  let lastState = "dialog-missing";
  await browser.waitUntil(
    async () => {
      const result = await browser.execute((dialogTestId) => {
        const dialog = document.querySelector<HTMLElement>(`[data-testid="${dialogTestId}"]`);
        if (!dialog || dialog.getClientRects().length === 0) {
          return { clicked: false, reason: "dialog-missing" };
        }
        const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
          .filter((candidate) => candidate.getClientRects().length > 0)
          .at(-1);
        if (!button) return { clicked: false, reason: "button-missing" };
        if (button.disabled) {
          return { clicked: false, reason: "button-disabled" };
        }
        button.click();
        return { clicked: true, reason: "clicked" };
      }, TID_SSH_DIALOG);
      lastState = result.reason;
      return result.clicked;
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `${caseMarker}: SSH 向导主动作不可点击 (${lastState})`,
    },
  );
}

export async function waitForSSHError(
  caseMarker: string,
  timeout = SSH_CONNECT_TIMEOUT_MS,
): Promise<string> {
  let errorText = "";
  await browser.waitUntil(
    async () => {
      errorText = await browser.execute((errorTestId) => {
        const error = document.querySelector<HTMLElement>(`[data-testid="${errorTestId}"]`);
        return error?.getClientRects().length ? error.innerText.trim() : "";
      }, TID_SSH_ERROR);
      return Boolean(errorText);
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `${caseMarker}: SSH 失败后没有显示错误`,
    },
  );
  return errorText;
}

export async function waitForSSHDirectoryStep(caseMarker: string): Promise<void> {
  let state: { error: string; status: "connecting" | "error" | "success" } = {
    error: "",
    status: "connecting",
  };
  await browser.waitUntil(
    async () => {
      state = await browser.execute(
        (successTestId, errorTestId) => {
          const success = document.querySelector<HTMLElement>(`[data-testid="${successTestId}"]`);
          if (success?.getClientRects().length) {
            return { error: "", status: "success" as const };
          }
          const error = document.querySelector<HTMLElement>(`[data-testid="${errorTestId}"]`);
          if (error?.getClientRects().length) {
            return { error: error.innerText.trim(), status: "error" as const };
          }
          return { error: "", status: "connecting" as const };
        },
        TID_SSH_SUCCESS,
        TID_SSH_ERROR,
      );
      return state.status !== "connecting";
    },
    {
      timeout: SSH_CONNECT_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${caseMarker}: SSH 部署/连接没有完成`,
    },
  );
  if (state.status === "error") {
    throw new Error(`${caseMarker}: SSH 连接失败: ${state.error}`);
  }
}

export async function selectSSHRemoteDirectory(
  workspacePath: string,
  caseMarker: string,
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((successTestId) => {
        const success = document.querySelector<HTMLElement>(`[data-testid="${successTestId}"]`);
        return Boolean(success?.querySelector<HTMLInputElement>('input[type="text"]'));
      }, TID_SSH_SUCCESS),
    {
      timeout: 30_000,
      timeoutMsg: `${caseMarker}: SSH directory step 没有路径输入框`,
    },
  );

  const normalizedPath = workspacePath.replace(/\/+$/, "") || "/";
  const lastSlash = normalizedPath.lastIndexOf("/");
  const parentPath = lastSlash === 0 ? "/" : normalizedPath.slice(0, lastSlash);
  const directoryName = normalizedPath.slice(lastSlash + 1);
  if (!directoryName) {
    throw new Error(`${caseMarker}: P0 helper 暂不支持选择根目录`);
  }

  const pathInput = $(`[data-testid="${TID_SSH_SUCCESS}"] input[type="text"]`);
  await pathInput.setValue(parentPath);
  await browser.keys("Enter");

  // 先等父目录真实加载出目标项，再点击进入目标目录。仅等待受控 input 的值会把
  // inputPath 更新误判成 currentPath 已切换，导致仍然选择初始 homedir。
  await browser.waitUntil(
    async () =>
      browser.execute(
        (successTestId, expectedName) => {
          const success = document.querySelector<HTMLElement>(`[data-testid="${successTestId}"]`);
          const entry = Array.from(
            success?.querySelectorAll<HTMLButtonElement>("button") ?? [],
          ).find((button) => button.innerText.trim() === expectedName);
          if (!entry) return false;
          entry.click();
          return true;
        },
        TID_SSH_SUCCESS,
        directoryName,
      ),
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `${caseMarker}: 父目录没有显示目标目录 ${directoryName}`,
    },
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        (successTestId, expectedPath) => {
          const input = document
            .querySelector<HTMLElement>(`[data-testid="${successTestId}"]`)
            ?.querySelector<HTMLInputElement>('input[type="text"]');
          return input?.value === expectedPath;
        },
        TID_SSH_SUCCESS,
        normalizedPath,
      ),
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `${caseMarker}: directory browser 没有进入目标路径`,
    },
  );
  await clickLastEnabledSSHDialogButton(caseMarker);
  await browser.waitUntil(
    () =>
      browser.execute(
        (dialogTestId) => !document.querySelector(`[data-testid="${dialogTestId}"]`),
        TID_SSH_DIALOG,
      ),
    {
      timeout: SSH_WORKSPACE_READY_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${caseMarker}: 选择远端目录后 SSH 向导没有关闭`,
    },
  );
}

export async function waitForRemoteTab(options: {
  caseMarker: string;
  expectedIdentity: string;
  expectedPath: string;
  expectedRemoteSessionId?: string | null;
  requireActive?: boolean;
  timeoutMs?: number;
}): Promise<RemoteTabSnapshot> {
  let snapshot: RemoteTabSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await readRemoteTabSnapshot(options.expectedIdentity);
        return (
          snapshot.workspacePath === options.expectedPath &&
          snapshot.workspaceIdentity === options.expectedIdentity &&
          Boolean(snapshot.remoteSessionId) &&
          (!options.expectedRemoteSessionId ||
            snapshot.remoteSessionId === options.expectedRemoteSessionId) &&
          (options.requireActive === false ||
            (snapshot.activeWorkspacePath === options.expectedPath &&
              snapshot.activeWorkspaceIdentity === options.expectedIdentity))
        );
      },
      {
        timeout: options.timeoutMs ?? SSH_WORKSPACE_READY_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: `${options.caseMarker}: remote tab identity/session 没有收敛`,
      },
    );
  } catch (error) {
    throw new Error(
      `${options.caseMarker}: remote tab identity/session 没有收敛，latest=${JSON.stringify(snapshot)}`,
      { cause: error },
    );
  }
  if (!snapshot) {
    throw new Error(`${options.caseMarker}: remote tab snapshot 缺失`);
  }
  return snapshot;
}

export function readRemoteTabSnapshot(expectedIdentity: string): Promise<RemoteTabSnapshot> {
  return browser.execute((identity) => {
    type RemoteTab = {
      remoteSessionId?: string;
      remoteTarget?: Record<string, unknown>;
      workspaceIdentity?: string;
      workspacePath?: string;
    };
    const store = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState?: () => {
            activeWorkspaceIdentity?: string | null;
            activeWorkspacePath?: string | null;
            tabs?: RemoteTab[];
          };
        };
      }
    ).__zcodeTabStoreE2E;
    const state = store?.getState?.();
    const tab = state?.tabs?.find((candidate) => candidate.workspaceIdentity === identity);
    const target = tab?.remoteTarget;
    return {
      activeWorkspaceIdentity: state?.activeWorkspaceIdentity ?? null,
      activeWorkspacePath: state?.activeWorkspacePath ?? null,
      remoteHost: typeof target?.host === "string" ? target.host : null,
      remoteKind: typeof target?.kind === "string" ? target.kind : null,
      remoteSessionId: tab?.remoteSessionId ?? null,
      secretPersistedInTab: Boolean(
        target && ("password" in target || "privateKeyPassphrase" in target),
      ),
      workspaceIdentity: tab?.workspaceIdentity ?? null,
      workspacePath: tab?.workspacePath ?? null,
    };
  }, expectedIdentity);
}

export async function readHostProcesses(): Promise<Array<{ name: string; pid: number }>> {
  await openResourceManager();
  await switchToElectronRendererTarget(isResourceManagerUrl);
  await waitForResourceManagerReady();
  const hosts = await listHostProcessIdentities();
  await switchToElectronRendererTarget(isMainRendererUrl);
  return hosts;
}

export async function runSSHCommand(
  config: SSHConnectionConfig,
  command: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const client = await connectSSHClient(config);
  try {
    return await new Promise((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        collectSSHChannel(channel).then(resolve, reject);
      });
    });
  } finally {
    client.end();
  }
}

export async function createSSHReplayTunnel(
  config: SSHConnectionConfig,
  caseMarker: string,
): Promise<ReplayTunnel> {
  const replayBaseURL = await resolveSeededReplayBaseUrl();
  if (!replayBaseURL) {
    throw new Error(`${caseMarker}: 没有找到本轮 replay provider URL`);
  }
  const replayURL = new URL(replayBaseURL);
  const replayPort = Number.parseInt(replayURL.port, 10);
  if (!Number.isSafeInteger(replayPort) || replayPort < 1) {
    throw new Error(`${caseMarker}: replay provider URL 缺少有效端口`);
  }

  const client = new SSHClient();
  client.on("tcp connection", (_details: TcpConnectionDetails, accept) => {
    const channel = accept();
    const socket = createConnection({
      host: replayURL.hostname,
      port: replayPort,
    });
    const closeBoth = () => {
      channel.destroy();
      socket.destroy();
    };
    channel.once("error", closeBoth);
    socket.once("error", closeBoth);
    socket.once("connect", () => channel.pipe(socket).pipe(channel));
    socket.once("close", () => channel.destroy());
    channel.once("close", () => socket.destroy());
  });

  const remotePort = await new Promise<number>((resolve, reject) => {
    client.once("error", reject);
    client.once("ready", () => {
      client.forwardIn("127.0.0.1", 0, (error, assignedPort) => {
        if (error) reject(error);
        else resolve(assignedPort);
      });
    });
    client.connect(toSSHConnectOptions(config));
  });

  return {
    baseURL: `http://127.0.0.1:${remotePort}`,
    close: () =>
      new Promise<void>((resolve) => {
        client.unforwardIn("127.0.0.1", remotePort, () => {
          client.end();
          resolve();
        });
      }),
  };
}

function listenOnLoopback(server: Server, caseMarker: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error(`${caseMarker}: 无法解析 SSH pending proxy 监听端口`));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function requireSecretEnv(name: string, caseMarker: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${caseMarker}: 缺少 ${name}`);
  return value;
}

function parseSSHPort(portText: string, context: string): number {
  const port = Number.parseInt(portText, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${context}: SSH port 必须是 1..65535 的整数`);
  }
  return port;
}

function connectSSHClient(config: SSHConnectionConfig): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    client.once("error", reject);
    client.once("ready", () => resolve(client));
    client.connect(toSSHConnectOptions(config));
  });
}

function toSSHConnectOptions(config: SSHConnectionConfig) {
  return {
    host: config.host,
    password: config.password,
    port: config.port,
    readyTimeout: SSH_CONNECT_TIMEOUT_MS,
    username: config.username,
  };
}

function collectSSHChannel(
  channel: ClientChannel,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    channel.setEncoding("utf8");
    channel.stderr.setEncoding("utf8");
    channel.on("data", (chunk: string) => {
      stdout += chunk;
    });
    channel.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    channel.once("exit", (code: number | null) => {
      exitCode = code;
    });
    channel.once("error", reject);
    channel.once("close", () => resolve({ code: exitCode, stderr, stdout }));
  });
}
