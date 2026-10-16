/* eslint-disable max-lines -- 所有 transport 生命周期共享同一个 registry 状态机，必须原子演进。 */
import {
  buildSshRemoteHostKey,
  stripRemoteTargetSecrets,
  type RemoteTarget,
  type WindowHostAttachmentScope,
  type WindowHostRemoteWorkspaceDescriptor,
} from "@zcode/shared";

export interface WindowRemoteAssetDirs {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
}

export interface WindowRemoteConnectionCloseEvent {
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

export interface WindowRemoteConnectionHandle<TServices, TCapabilities = never> {
  services: TServices;
  capabilities?: TCapabilities;
  dispose(): void | Promise<void>;
  onDidClose?(
    listener: (event: WindowRemoteConnectionCloseEvent) => void,
  ): { dispose(): void };
}

export interface WindowRemoteConnectionConnectRequest {
  target: RemoteTarget;
  remoteAssets: WindowRemoteAssetDirs;
  signal: AbortSignal;
}

export type WindowRemoteConnectionState =
  | "connecting"
  | "online"
  | "closing"
  | "failed"
  | "disconnected";

export interface WindowRemoteLogicalSessionSnapshot {
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
}

export class WindowRemoteConnectCancelledError extends Error {
  constructor() {
    super("远程连接已取消");
    this.name = "WindowRemoteConnectCancelledError";
  }
}

export class WindowRemoteConnectionUnavailableError extends Error {
  constructor(remoteSessionId: string) {
    super(`远程连接当前不可用，remoteSessionId=${remoteSessionId}`);
    this.name = "WindowRemoteConnectionUnavailableError";
  }
}

interface ConnectionEntry<TServices, TCapabilities> {
  key: string;
  target: RemoteTarget;
  state: WindowRemoteConnectionState;
  abortController: AbortController;
  sessions: Set<string>;
  ready: Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  handle?: WindowRemoteConnectionHandle<TServices, TCapabilities>;
  closeSubscription?: { dispose(): void };
  disposePromise?: Promise<void>;
  disposed: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleReason: string;
  workspaceKeys: Set<string>;
  runningTaskCountByWorkspaceKey: Map<string, number>;
  workspaceRuntimeByKey: Map<string, WorkspaceRuntimeState>;
}

interface RemoteWorkspaceContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface WorkspaceRuntimeState {
  context: RemoteWorkspaceContext;
  generation: number;
  pendingReleaseGeneration?: number;
  releaseInFlight?: Promise<void>;
}

interface LogicalSession<TServices, TCapabilities> {
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
  entry: ConnectionEntry<TServices, TCapabilities>;
  workspaceKey?: string;
  workspaceGeneration?: number;
  workspaceReady: Promise<void>;
  workspaceReadyState: "pending" | "ready" | "failed";
  cancelled: boolean;
  rejectCancellation: (error: WindowRemoteConnectCancelledError) => void;
  cancellation: Promise<never>;
}

function normalizeWslSegment(value: string | undefined): string {
  return value?.trim() || "<default>";
}

function buildConnectionKey(target: RemoteTarget, remoteSessionId: string): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${normalizeWslSegment(target.distro)}\0${normalizeWslSegment(target.user)}`;
    case "docker":
    case "server":
      // Docker/Server 保持现有 dedicated logical session 生命周期，不按 target 复用。
      return `${target.kind}:dedicated:${remoteSessionId}`;
  }
}

function toSessionSnapshot<TServices, TCapabilities>(
  session: LogicalSession<TServices, TCapabilities>,
): WindowRemoteLogicalSessionSnapshot {
  return {
    remoteSessionId: session.remoteSessionId,
    requestId: session.requestId,
    target: stripRemoteTargetSecrets(session.target),
    ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
    ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    generation: session.generation,
    state: session.state,
    sourceAvailability: session.sourceAvailability,
  };
}

export function createWindowRemoteConnectionRegistry<TServices, TCapabilities = never>(options: {
  connect: (
    request: WindowRemoteConnectionConnectRequest,
  ) => Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  createId: () => string;
  onSessionClosed?: (
    event: WindowRemoteConnectionCloseEvent & { remoteSessionId: string },
  ) => void;
  releaseWorkspace?: (
    services: TServices,
    context: RemoteWorkspaceContext,
  ) => Promise<void>;
  onWorkspaceReleaseError?: (context: RemoteWorkspaceContext, error: unknown) => void;
  wslIdleTtlMs?: number;
}) {
  const entriesByKey = new Map<string, ConnectionEntry<TServices, TCapabilities>>();
  const sessionsById = new Map<string, LogicalSession<TServices, TCapabilities>>();
  const pendingSessionsByRequestId = new Map<string, LogicalSession<TServices, TCapabilities>>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const wslIdleTtlMs = options.wslIdleTtlMs ?? 60_000;

  function clearIdleTimer(entry: ConnectionEntry<TServices, TCapabilities>): void {
    if (!entry.idleTimer) {
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  function hasRunningTasks(entry: ConnectionEntry<TServices, TCapabilities>): boolean {
    return Array.from(entry.runningTaskCountByWorkspaceKey.values()).some((count) => count > 0);
  }

  function sessionOwnsWorkspace(
    session: LogicalSession<TServices, TCapabilities>,
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
  ): boolean {
    return (
      !session.cancelled &&
      session.entry === entry &&
      session.workspaceKey === workspaceKey &&
      sessionsById.get(session.remoteSessionId) === session
    );
  }

  function hasOtherWorkspaceOwner(
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
    excludedRemoteSessionId: string,
  ): boolean {
    return Array.from(sessionsById.values()).some(
      (candidate) =>
        candidate.remoteSessionId !== excludedRemoteSessionId &&
        sessionOwnsWorkspace(candidate, entry, workspaceKey),
    );
  }

  function startWorkspaceRelease(
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
    state: WorkspaceRuntimeState,
    generation: number,
  ): Promise<void> | undefined {
    if (
      entry.target.kind !== "wsl" ||
      state.generation !== generation ||
      state.releaseInFlight ||
      !entry.handle ||
      entry.state !== "online" ||
      !options.releaseWorkspace
    ) {
      return state.releaseInFlight;
    }
    state.pendingReleaseGeneration = undefined;
    const release = options
      .releaseWorkspace(entry.handle.services, state.context)
      .catch((error) => {
        options.onWorkspaceReleaseError?.(state.context, error);
        throw error;
      })
      .finally(() => {
        if (state.releaseInFlight === release) {
          state.releaseInFlight = undefined;
        }
        if (
          state.generation === generation &&
          !state.pendingReleaseGeneration &&
          !Array.from(sessionsById.values()).some((candidate) =>
            sessionOwnsWorkspace(candidate, entry, workspaceKey),
          )
        ) {
          entry.workspaceRuntimeByKey.delete(workspaceKey);
        }
      });
    // release 由 dispose/running-task 事件触发；失败由结构化回调记录，同时保留 rejecting
    // Promise 给同 workspace 的下一代 acquire，使其 fail-closed 而不是踩过未完成清理。
    void release.catch(() => undefined);
    state.releaseInFlight = release;
    return release;
  }

  function requestWorkspaceRelease(params: {
    entry: ConnectionEntry<TServices, TCapabilities>;
    remoteSessionId: string;
    workspaceKey?: string;
    workspaceGeneration?: number;
  }): Promise<void> | undefined {
    const { entry, workspaceKey, workspaceGeneration } = params;
    if (entry.target.kind !== "wsl" || !workspaceKey || !workspaceGeneration) {
      return undefined;
    }
    if (hasOtherWorkspaceOwner(entry, workspaceKey, params.remoteSessionId)) {
      return undefined;
    }
    const state = entry.workspaceRuntimeByKey.get(workspaceKey);
    if (!state || state.generation !== workspaceGeneration) {
      return undefined;
    }
    if ((entry.runningTaskCountByWorkspaceKey.get(workspaceKey) ?? 0) > 0) {
      state.pendingReleaseGeneration = workspaceGeneration;
      return undefined;
    }
    return startWorkspaceRelease(entry, workspaceKey, state, workspaceGeneration);
  }

  function prepareWorkspaceRuntime(
    session: LogicalSession<TServices, TCapabilities>,
  ): Promise<void> {
    if (
      session.entry.target.kind !== "wsl" ||
      !session.workspacePath ||
      !session.workspaceKey
    ) {
      session.workspaceReadyState = "ready";
      session.workspaceReady = Promise.resolve();
      return session.workspaceReady;
    }
    const workspaceKey = session.workspaceKey;
    const entry = session.entry;
    const existing = entry.workspaceRuntimeByKey.get(workspaceKey);
    const hasOtherOwner = hasOtherWorkspaceOwner(
      entry,
      workspaceKey,
      session.remoteSessionId,
    );
    const state =
      existing ??
      ({
        context: {
          workspacePath: session.workspacePath,
          ...(session.workspaceIdentity
            ? { workspaceIdentity: session.workspaceIdentity }
            : {}),
        },
        generation: 0,
      } satisfies WorkspaceRuntimeState);
    entry.workspaceRuntimeByKey.set(workspaceKey, state);
    state.context = {
      workspacePath: session.workspacePath,
      ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    };
    if (!hasOtherOwner) {
      state.generation += 1;
      // 上一代 release 仍因 running task 等待时，新 logical owner 已重新持有
      // workspace；尚未开始的旧 release 必须失效，不能在 task 归零后误清新 runtime。
    }
    state.pendingReleaseGeneration = undefined;
    session.workspaceGeneration = state.generation;
    session.workspaceReadyState = "pending";
    const releaseToWait = state.releaseInFlight;
    const ready = (releaseToWait ?? Promise.resolve())
      .then(() => {
        if (
          sessionsById.get(session.remoteSessionId) !== session ||
          session.cancelled ||
          entry.workspaceRuntimeByKey.get(workspaceKey)?.generation !==
            session.workspaceGeneration
        ) {
          throw new WindowRemoteConnectCancelledError();
        }
        session.workspaceReadyState = "ready";
      })
      .catch((error) => {
        session.workspaceReadyState = "failed";
        throw error;
      });
    session.workspaceReady = ready;
    return ready;
  }

  function scheduleWslIdleDispose(
    entry: ConnectionEntry<TServices, TCapabilities>,
    reason: string,
  ): void {
    clearIdleTimer(entry);
    entry.idleReason = reason;
    if (
      entry.target.kind !== "wsl" ||
      entry.disposed ||
      entry.sessions.size > 0 ||
      hasRunningTasks(entry)
    ) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (
        entriesByKey.get(entry.key) !== entry ||
        entry.disposed ||
        entry.sessions.size > 0 ||
        hasRunningTasks(entry)
      ) {
        return;
      }
      void disposeEntry(entry);
    }, wslIdleTtlMs);
  }

  async function disposeEntry(
    entry: ConnectionEntry<TServices, TCapabilities>,
  ): Promise<void> {
    if (entry.disposePromise) {
      return entry.disposePromise;
    }
    entry.disposed = true;
    clearIdleTimer(entry);
    entry.state = "closing";
    entry.abortController.abort();
    entry.closeSubscription?.dispose();
    entry.closeSubscription = undefined;
    if (entriesByKey.get(entry.key) === entry) {
      entriesByKey.delete(entry.key);
    }
    entry.disposePromise = Promise.resolve(entry.handle?.dispose()).then(() => undefined);
    return entry.disposePromise;
  }

  function handleConnectionClosed(
    entry: ConnectionEntry<TServices, TCapabilities>,
    event: WindowRemoteConnectionCloseEvent,
  ): void {
    if (entry.disposed || entry.state === "closing") {
      return;
    }
    entry.state = "disconnected";
    clearIdleTimer(entry);
    if (entriesByKey.get(entry.key) === entry) {
      entriesByKey.delete(entry.key);
    }
    for (const remoteSessionId of entry.sessions) {
      const session = sessionsById.get(remoteSessionId);
      if (!session) {
        continue;
      }
      session.state = "disconnected";
      session.sourceAvailability = "offline";
      options.onSessionClosed?.({ remoteSessionId, ...event });
    }
  }

  function createEntry(params: {
    key: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
  }): ConnectionEntry<TServices, TCapabilities> {
    const abortController = new AbortController();
    const entry: ConnectionEntry<TServices, TCapabilities> = {
      key: params.key,
      target: params.target,
      state: "connecting" as const,
      abortController,
      sessions: new Set<string>(),
      ready: Promise.resolve(undefined as never),
      disposed: false,
      idleReason: "wsl-host-idle",
      workspaceKeys: new Set(),
      runningTaskCountByWorkspaceKey: new Map(),
      workspaceRuntimeByKey: new Map(),
    };
    entry.ready = options
      .connect({
        target: params.target,
        remoteAssets: params.remoteAssets,
        signal: abortController.signal,
      })
      .then(async (handle) => {
        entry.handle = handle;
        if (entry.disposed || entry.sessions.size === 0) {
          // 底层 SSH/WSL connector 可能无法中断认证或部署。
          // 最后一个 logical owner 取消后，迟到的成功结果必须立即释放，不能复活旧连接。
          await disposeEntry(entry);
          return handle;
        }
        entry.state = "online";
        entry.closeSubscription = handle.onDidClose?.((event) => {
          handleConnectionClosed(entry, event);
        });
        for (const remoteSessionId of entry.sessions) {
          const session = sessionsById.get(remoteSessionId);
          if (!session || session.cancelled) {
            continue;
          }
          session.state = "online";
          session.sourceAvailability = "online";
        }
        return handle;
      })
      .catch((error) => {
        entry.state = "failed";
        if (entriesByKey.get(entry.key) === entry) {
          entriesByKey.delete(entry.key);
        }
        for (const remoteSessionId of Array.from(entry.sessions)) {
          const session = sessionsById.get(remoteSessionId);
          if (!session) {
            continue;
          }
          session.state = "failed";
          session.sourceAvailability = "offline";
          sessionsById.delete(remoteSessionId);
          pendingSessionsByRequestId.delete(session.requestId);
        }
        entry.sessions.clear();
        throw error;
      });
    entriesByKey.set(entry.key, entry);
    return entry;
  }

  function resolveEntry(params: {
    key: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
  }): ConnectionEntry<TServices, TCapabilities> {
    const existing = entriesByKey.get(params.key);
    if (
      existing &&
      !existing.disposed &&
      !existing.abortController.signal.aborted &&
      (existing.state === "connecting" || existing.state === "online")
    ) {
      clearIdleTimer(existing);
      return existing;
    }
    return createEntry(params);
  }

  async function connect(params: {
    requestId: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<WindowHostRemoteWorkspaceDescriptor> {
    if (disposed) {
      throw new Error("窗口 Host 的远程连接 registry 已释放");
    }
    if (pendingSessionsByRequestId.has(params.requestId)) {
      throw new Error(`远程连接 requestId 重复，requestId=${params.requestId}`);
    }

    const remoteSessionId = options.createId();
    const key = buildConnectionKey(params.target, remoteSessionId);
    const entry = resolveEntry({
      key,
      target: params.target,
      remoteAssets: params.remoteAssets,
    });
    let rejectCancellation!: (error: WindowRemoteConnectCancelledError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const session: LogicalSession<TServices, TCapabilities> = {
      remoteSessionId,
      requestId: params.requestId,
      target: params.target,
      ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      generation: 1,
      state: entry.state === "online" ? "online" : "connecting",
      sourceAvailability: entry.state === "online" ? "online" : "offline",
      entry,
      workspaceReady: Promise.resolve(),
      workspaceReadyState: "pending",
      cancelled: false,
      rejectCancellation,
      cancellation,
    };
    entry.sessions.add(remoteSessionId);
    const initialWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
    if (initialWorkspaceKey) {
      entry.workspaceKeys.add(initialWorkspaceKey);
      session.workspaceKey = initialWorkspaceKey;
    }
    sessionsById.set(remoteSessionId, session);
    pendingSessionsByRequestId.set(params.requestId, session);

    try {
      await Promise.race([entry.ready, cancellation]);
      await Promise.race([prepareWorkspaceRuntime(session), cancellation]);
      if (session.cancelled || !sessionsById.has(remoteSessionId)) {
        throw new WindowRemoteConnectCancelledError();
      }
      session.state = "online";
      session.sourceAvailability = "online";
      return {
        remoteSessionId,
        target: stripRemoteTargetSecrets(params.target),
        ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
        ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
        generation: session.generation,
      };
    } catch (error) {
      if (sessionsById.get(remoteSessionId) === session) {
        sessionsById.delete(remoteSessionId);
        entry.sessions.delete(remoteSessionId);
        session.state = "failed";
        session.sourceAvailability = "offline";
        if (
          entry.sessions.size === 0 &&
          (entry.target.kind === "docker" || entry.target.kind === "server")
        ) {
          await disposeEntry(entry);
        }
      }
      throw error;
    } finally {
      if (pendingSessionsByRequestId.get(params.requestId) === session) {
        pendingSessionsByRequestId.delete(params.requestId);
      }
    }
  }

  function cancelConnect(requestId: string): void {
    const session = pendingSessionsByRequestId.get(requestId);
    if (!session || session.cancelled) {
      return;
    }
    session.cancelled = true;
    pendingSessionsByRequestId.delete(requestId);
    sessionsById.delete(session.remoteSessionId);
    session.entry.sessions.delete(session.remoteSessionId);
    const workspaceRelease = requestWorkspaceRelease({
      entry: session.entry,
      remoteSessionId: session.remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    });
    void workspaceRelease?.catch(() => undefined);
    session.rejectCancellation(new WindowRemoteConnectCancelledError());
    if (session.entry.sessions.size === 0) {
      if (
        session.entry.target.kind === "ssh" &&
        session.entry.state === "connecting"
      ) {
        // Bug 根因：最后一个 waiter 取消后，旧 entry 仍以 connecting 留在复用表；立即重连会
        // 继续等待已经 aborted 的 readiness，并沿用上一次凭据。先按对象身份退休旧 entry，
        // 再触发底层取消；迟到的旧 completion 不能删除或复活同 key 的新连接。
        if (entriesByKey.get(session.entry.key) === session.entry) {
          entriesByKey.delete(session.entry.key);
        }
        session.entry.state = "closing";
        session.entry.abortController.abort();
      } else if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
        scheduleWslIdleDispose(session.entry, "cancelled-logical-connect");
      } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
        // ready SSH connection 是窗口 cache；取消一次 logical attach 不应把后续 workspace 的
        // 复用连接一并销毁，真实窗口 Host shutdown 时统一释放。
        clearIdleTimer(session.entry);
      } else if (session.entry.handle) {
        void disposeEntry(session.entry);
      }
    }
  }

  function bindWorkspaceContext(params: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<void> {
    const session = sessionsById.get(params.remoteSessionId);
    if (!session) {
      throw new Error(`未找到远程 logical session，remoteSessionId=${params.remoteSessionId}`);
    }
    const previousOwnership = {
      entry: session.entry,
      remoteSessionId: session.remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    };
    session.workspacePath = params.workspacePath;
    session.workspaceIdentity = params.workspaceIdentity;
    session.generation += 1;
    session.workspaceKey = params.workspaceIdentity.trim() || params.workspacePath;
    session.entry.workspaceKeys.add(session.workspaceKey);
    const ready = prepareWorkspaceRuntime(session);
    if (previousOwnership.workspaceKey !== session.workspaceKey) {
      const release = requestWorkspaceRelease(previousOwnership);
      void release?.catch(() => undefined);
    }
    return ready;
  }

  function resolveScopedHandle(
    scope: WindowHostAttachmentScope,
  ): WindowRemoteConnectionHandle<TServices, TCapabilities> {
    if (scope.kind !== "remote") {
      throw new Error("远程连接 registry 不能解析 local attachment scope");
    }
    const session = sessionsById.get(scope.remoteSessionId);
    if (!session) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    if (
      session.workspacePath !== scope.workspacePath ||
      session.workspaceIdentity !== scope.workspaceIdentity
    ) {
      throw new Error(
        `远程 attachment scope 与 logical session 不匹配，remoteSessionId=${scope.remoteSessionId}`,
      );
    }
    if (
      session.state !== "online" ||
      session.sourceAvailability !== "online" ||
      session.workspaceReadyState !== "ready" ||
      !session.entry.handle
    ) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    return session.entry.handle;
  }

  function resolveScopedServices(scope: WindowHostAttachmentScope): TServices {
    return resolveScopedHandle(scope).services;
  }

  function resolveScopedCapabilities(scope: WindowHostAttachmentScope): TCapabilities | undefined {
    return resolveScopedHandle(scope).capabilities;
  }

  async function disposeSession(remoteSessionId: string): Promise<void> {
    const session = sessionsById.get(remoteSessionId);
    if (!session) {
      return;
    }
    sessionsById.delete(remoteSessionId);
    pendingSessionsByRequestId.delete(session.requestId);
    session.entry.sessions.delete(remoteSessionId);
    const workspaceRelease = requestWorkspaceRelease({
      entry: session.entry,
      remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    });
    if (session.entry.sessions.size === 0) {
      if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
        scheduleWslIdleDispose(session.entry, "last-logical-session-disposed");
      } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
        // 只迁移 SSH pool 的 owner：ready connection 继续保持 window-scoped cache，
        // logical session 清空不等于连接退出；真实窗口 Host shutdown 时统一释放。
        clearIdleTimer(session.entry);
      } else {
        await disposeEntry(session.entry);
      }
    }
    await workspaceRelease?.catch(() => undefined);
  }

  return {
    connect,
    cancelConnect,
    bindWorkspaceContext,
    resolveScopedServices,
    resolveScopedCapabilities,
    getSession(remoteSessionId: string): WindowRemoteLogicalSessionSnapshot | null {
      const session = sessionsById.get(remoteSessionId);
      return session ? toSessionSnapshot(session) : null;
    },
    listSessions(): WindowRemoteLogicalSessionSnapshot[] {
      return Array.from(sessionsById.values(), toSessionSnapshot);
    },
    /**
     * 已就绪、未释放的连接（按连接去重，同一 SSH 连接上的多个 logical session 只出现一次）。
     * 供窗口级事实广播给每个远程 Host，例如动态工作流的用户选择（launch.md「The user's choice」）。
     */
    listReadyConnections(): Array<{ target: RemoteTarget; services: TServices }> {
      return Array.from(entriesByKey.values()).flatMap((entry) =>
        entry.handle && !entry.disposed
          ? [{ target: entry.target, services: entry.handle.services }]
          : [],
      );
    },
    findSessionForWorkspace(params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): WindowRemoteLogicalSessionSnapshot | null {
      const matches = Array.from(sessionsById.values()).filter(
        (session) =>
          session.workspacePath === params.workspacePath &&
          session.workspaceIdentity === params.workspaceIdentity,
      );
      const onlineMatches = matches.filter(
        (session) => session.state === "online" && session.sourceAvailability === "online",
      );
      if (onlineMatches.length > 1 || (onlineMatches.length === 0 && matches.length > 1)) {
        throw new Error(
          `远程 workspace scope 匹配到多个 logical session，workspacePath=${params.workspacePath}`,
        );
      }
      const match = onlineMatches[0] ?? matches[0];
      return match ? toSessionSnapshot(match) : null;
    },
    getStats(): { connectionCount: number; logicalSessionCount: number } {
      return {
        connectionCount: entriesByKey.size,
        logicalSessionCount: sessionsById.size,
      };
    },
    setWorkspaceRunningTaskCount(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      runningTaskCount: number;
    }): void {
      const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      for (const entry of entriesByKey.values()) {
        if (entry.target.kind !== "wsl" || !entry.workspaceKeys.has(workspaceKey)) {
          continue;
        }
        if (params.runningTaskCount > 0) {
          entry.runningTaskCountByWorkspaceKey.set(workspaceKey, params.runningTaskCount);
          clearIdleTimer(entry);
        } else {
          entry.runningTaskCountByWorkspaceKey.delete(workspaceKey);
          const state = entry.workspaceRuntimeByKey.get(workspaceKey);
          if (state?.pendingReleaseGeneration) {
            void startWorkspaceRelease(
              entry,
              workspaceKey,
              state,
              state.pendingReleaseGeneration,
            )?.catch(() => undefined);
          }
          scheduleWslIdleDispose(entry, entry.idleReason);
        }
      }
    },
    async waitForScopedServices(scope: WindowHostAttachmentScope): Promise<TServices> {
      if (scope.kind !== "remote") {
        throw new Error("远程连接 registry 不能解析 local attachment scope");
      }
      const session = sessionsById.get(scope.remoteSessionId);
      if (!session) {
        throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
      }
      await session.workspaceReady;
      return resolveScopedServices(scope);
    },
    disposeSession,
    async dispose(): Promise<void> {
      if (disposePromise) {
        return disposePromise;
      }
      disposed = true;
      for (const requestId of Array.from(pendingSessionsByRequestId.keys())) {
        cancelConnect(requestId);
      }
      const entries = new Set(Array.from(sessionsById.values(), (session) => session.entry));
      for (const entry of entriesByKey.values()) {
        entries.add(entry);
      }
      sessionsById.clear();
      pendingSessionsByRequestId.clear();
      disposePromise = Promise.all(Array.from(entries, disposeEntry)).then(() => undefined);
      return disposePromise;
    },
  };
}
