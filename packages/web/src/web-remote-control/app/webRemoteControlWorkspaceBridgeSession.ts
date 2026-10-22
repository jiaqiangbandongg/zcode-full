import type {
  WebRemoteControlExternalWorkspaceBridge,
  WebRemoteControlWorkspaceBridge,
} from "@zcode/shared";
import {
  connectViaProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
} from "@zcode/client";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
  type RemoteWorkspaceSession,
} from "@zcode/ui/remote-workspace-session-store";

type WebRemoteControlBridgeWithRemoteSession =
  | WebRemoteControlExternalWorkspaceBridge
  | WebRemoteControlWorkspaceBridge;

export interface WebRemoteControlWorkspaceBridgeServiceRegistration {
  dispose: () => void;
}

export function replayWebRemoteControlWorkspaceBridgeFrames(params: {
  activeRelayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  pendingRelayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
}): void {
  // 能力校验未完成时新 bridge 仍是 pending；只重放 active 会让丢帧请求一直等到降级。
  // 先恢复 pending，避免旧 active 已降级时阻断新 bridge；重放仍由各自 adapter 去重和限时。
  params.pendingRelayProtocol?.replayUnacknowledged();
  if (params.activeRelayProtocol?.isDegraded()) return;
  // same-socket matched 也可能只丢了上一批 data/ACK；沿原序号去重和原始 45 秒期限重放。
  params.activeRelayProtocol?.replayUnacknowledged();
}

/** 先接入待就绪 bridge 的收帧路径，验证能力后才由调用者发布服务。 */
export async function connectWebRemoteControlWorkspaceBridgeServices(params: {
  relayProtocol: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  windowProjectDirectory: boolean;
  activateTransport(): () => void;
  isCurrent(): boolean;
  signal?: AbortSignal;
}) {
  const superseded = () => new Error("Workspace bridge request was superseded.");
  if (params.signal?.aborted || !params.isCurrent()) {
    params.relayProtocol.dispose();
    throw superseded();
  }
  const releaseTransport = params.activateTransport();
  let interrupt!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = reject;
  });
  const onAbort = () => interrupt(superseded());
  params.signal?.addEventListener("abort", onAbort, { once: true });
  const degraded = params.relayProtocol.onDegraded(() =>
    interrupt(new Error("Workspace bridge degraded before directory readiness.")),
  );
  try {
    const services = connectViaProtocol(params.relayProtocol.protocol, {
      windowProjectDirectory: params.windowProjectDirectory,
    });
    // 事件监听没有就绪回包。若先等待 RPC 再接入收帧，回复会落到旧 bridge 而永久等待。
    // 新导航或连接终止同时取消等待，迟到回复不能复活旧服务，也不回落 Source 目录。
    const capability = services.windowProjectDirectory
      ? services.windowProjectDirectory.changesService.getCapabilities().then((result) => {
          if (result?.version !== 1) throw new Error("window-project-directory.unsupported");
        })
      : Promise.resolve();
    await Promise.race([capability, interrupted]);
    if (!params.isCurrent() || params.signal?.aborted) throw superseded();
    return services;
  } catch (error) {
    releaseTransport();
    params.relayProtocol.dispose();
    throw error;
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
    degraded.dispose();
  }
}

export function registerWebRemoteControlWorkspaceBridgeServices(params: {
  bridge: WebRemoteControlBridgeWithRemoteSession;
  services: RemoteWorkspaceSession["services"];
}): WebRemoteControlWorkspaceBridgeServiceRegistration {
  const { bridge, services } = params;
  if (bridge.kind !== "remote") {
    return { dispose: () => {} };
  }

  // Bugfix: 手机 web relay 的远程 bridge 已经连上 host，但之前没有写入 remote session store。
  // 这会让 hooks 按 workspaceIdentity 解析不到 session，转而走断连代理并报 ZCODE_REMOTE_WORKSPACE_DISCONNECTED。
  registerRemoteWorkspaceSession({
    sessionId: bridge.remoteSessionId,
    services,
  });
  bindRemoteWorkspaceIdentity(bridge.workspaceIdentity, bridge.remoteSessionId);
  bindRemoteWorkspacePath(bridge.workspacePath, bridge.remoteSessionId);

  return {
    dispose: () => {
      // Bugfix: 手机硬恢复会为同一个 SSH session 重新创建 bridge，remoteSessionId 可能不变。
      // 旧 bridge 的 dispose 晚于新 bridge 注册时，不能只按 sessionId 清理，否则会把新 services
      // 和 identity/path 映射删掉，hooks 随后会误判为 ZCODE_REMOTE_WORKSPACE_DISCONNECTED。
      if (getRemoteWorkspaceSession(bridge.remoteSessionId)?.services !== services) {
        return;
      }
      unregisterRemoteWorkspaceSession(bridge.remoteSessionId);
    },
  };
}
