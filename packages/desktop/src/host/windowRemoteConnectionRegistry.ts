/* eslint-disable max-lines -- 所有 transport 生命周期共享同一个 registry 状态机，必须原子演进。 */
import {
  buildSshRemoteHostKey,
  buildServerRemoteWorkspaceIdentity,
  stripRemoteTargetSecrets,
  type RemoteTarget,
  type SourceServerArtifactPolicy,
  type WorkspacePurpose,
  type WindowHostAttachmentScope,
  type WindowHostRemoteWorkspaceDescriptor,
} from "@zcode/shared";

export interface WindowRemoteAssetDirs {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
}

export interface WindowRemoteConnectionCloseEvent {
  exitCode: number | null;
  signal: string | null;
  error?: string;
  recoverable?: boolean;
  recoveryAttempt?: number;
  recoveryLimit?: number;
  recoveryBudgetExhausted?: boolean;
  reasonCode?: string;
  retryable?: boolean;
}

export interface WindowRemoteConnectionHandle<TServices, TCapabilities = never> {
  services: TServices;
  reusedConnectionTarget?: RemoteTarget;
  capabilities?: TCapabilities;
  dispose(): void | Promise<void>;
  onDidClose?(listener: (event: WindowRemoteConnectionCloseEvent) => void): {
    dispose(): void;
  };
  /** 同一 Source transport 自动重连完成；services/capabilities getter 已切到新连接。 */
  onDidReconnect?(listener: () => void): { dispose(): void };
}

export interface WindowRemoteConnectionConnectRequest {
  membershipIntent?: "add" | "retain";
  existingSourceServerId?: string;
  target: RemoteTarget;
  remoteAssets: WindowRemoteAssetDirs;
  signal: AbortSignal;
  confirmSourceServerInstall?: boolean;
}

export type WindowRemoteConnectionState =
  | "connecting"
  | "online"
  | "closing"
  | "failed"
  | "disconnected";

export interface WindowRemoteLogicalSessionSnapshot {
  sourceServerId?: string;
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
}

export class WindowRemoteConnectCancelledError extends Error {
  public readonly code = "remote-connection-canceled";
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
  sourceServerId?: string;
  target: RemoteTarget;
  state: WindowRemoteConnectionState;
  abortController: AbortController;
  sessions: Set<string>;
  ready: Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  handle?: WindowRemoteConnectionHandle<TServices, TCapabilities>;
  closeSubscription?: { dispose(): void };
  reconnectSubscription?: { dispose(): void };
  reconnectFlight?: Promise<void>;
  replacementRetryTimer?: ReturnType<typeof setTimeout>;
  recoveryReplacements?: Array<{
    previous: LogicalSession<TServices, TCapabilities>;
    current: LogicalSession<TServices, TCapabilities>;
  }>;
  closePhase: "none" | "recovering" | "terminal";
  lastRecoveryAttemptNotified?: number;
  recoveryReady?: Promise<void>;
  recoveryFailure?: Error;
  resolveRecovery?: () => void;
  rejectRecovery?: (error: Error) => void;
  disposePromise?: Promise<void>;
  disposed: boolean;
  transitionEpoch: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleReason: string;
  workspaceKeys: Set<string>;
  runningTaskCountByWorkspaceKey: Map<string, number>;
  workspaceRuntimeByKey: Map<string, WorkspaceRuntimeState>;
}

class WindowRemoteConnectionTransitionStaleError extends Error {
  public constructor() {
    super("远程连接状态已在异步操作期间换代");
    this.name = "WindowRemoteConnectionTransitionStaleError";
  }
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
  sourceServerId?: string;
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  legacyWorkspaceIdentity?: string;
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

function normalizeServerConnectionUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/\/+$/u, "");
    url.pathname = path.endsWith("/ws/host")
      ? path.slice(0, -"/ws/host".length) || "/"
      : path.endsWith("/ws")
        ? path.slice(0, -"/ws".length) || "/"
        : path || "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

function buildConnectionKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${normalizeWslSegment(target.distro)}\0${normalizeWslSegment(target.user)}`;
    case "docker":
      return `docker:${target.container.trim()}`;
    case "server":
      return `server:${target.serverId?.trim() || normalizeServerConnectionUrl(target.url)}`;
  }
}

function toSessionSnapshot<TServices, TCapabilities>(
  session: LogicalSession<TServices, TCapabilities>,
): WindowRemoteLogicalSessionSnapshot {
  return {
    ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
    remoteSessionId: session.remoteSessionId,
    requestId: session.requestId,
    target: stripRemoteTargetSecrets(session.target),
    ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
    ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    ...(session.workspacePurpose ? { workspacePurpose: session.workspacePurpose } : {}),
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
  onConnectionChanged?: () => void;
  onSessionClosed?: (event: WindowRemoteConnectionCloseEvent & { remoteSessionId: string }) => void;
  onSessionReconnected?: (event: {
    previous: WindowRemoteLogicalSessionSnapshot;
    current: WindowRemoteLogicalSessionSnapshot;
    services: TServices;
    isCurrent: () => boolean;
    commit: () => boolean;
  }) => void | Promise<void>;
  onSessionReconnectError?: (error: unknown) => void;
  releaseWorkspace?: (services: TServices, context: RemoteWorkspaceContext) => Promise<void>;
  onWorkspaceReleaseError?: (context: RemoteWorkspaceContext, error: unknown) => void;
  resolveSourceServerId?: (
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
  ) => string | undefined;
  shouldKeepConnectionAlive?: (
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
  ) => boolean;
  prepareWorkspaceIdentity?: (
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
    input: {
      sourceServerId: string;
      workspacePath: string;
      stableWorkspaceIdentity: string;
      legacyRouteHint?: string;
      signal?: AbortSignal;
    },
  ) => Promise<void>;
  wslIdleTtlMs?: number;
  logicalReplacementRetryDelaysMs?: readonly number[];
}) {
  const entriesByKey = new Map<string, ConnectionEntry<TServices, TCapabilities>>();
  const entriesBySourceServerId = new Map<string, ConnectionEntry<TServices, TCapabilities>>();
  const sessionsById = new Map<string, LogicalSession<TServices, TCapabilities>>();
  const pendingSessionsByRequestId = new Map<string, LogicalSession<TServices, TCapabilities>>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const wslIdleTtlMs = options.wslIdleTtlMs ?? 60_000;
  const logicalReplacementRetryDelaysMs =
    options.logicalReplacementRetryDelaysMs ?? ([500, 1_000, 2_000] as const);

  function shouldKeepConnectionAlive(entry: ConnectionEntry<TServices, TCapabilities>): boolean {
    return Boolean(entry.handle && options.shouldKeepConnectionAlive?.(entry.handle));
  }

  function removeEntryOwners(entry: ConnectionEntry<TServices, TCapabilities>): void {
    for (const [key, owner] of entriesByKey) {
      if (owner === entry) entriesByKey.delete(key);
    }
    if (entry.sourceServerId && entriesBySourceServerId.get(entry.sourceServerId) === entry) {
      entriesBySourceServerId.delete(entry.sourceServerId);
    }
  }

  function canOwnManagedSource(entry: ConnectionEntry<TServices, TCapabilities>): boolean {
    return (
      !entry.disposed &&
      !entry.abortController.signal.aborted &&
      (entry.state === "connecting" ||
        entry.state === "online" ||
        (entry.state === "disconnected" &&
          entry.closePhase === "recovering" &&
          shouldKeepConnectionAlive(entry)))
    );
  }

  function assignSessionToSourceOwner(
    session: LogicalSession<TServices, TCapabilities>,
    owner: ConnectionEntry<TServices, TCapabilities>,
    sourceServerId: string,
  ): void {
    session.entry = owner;
    session.target = owner.target;
    session.state = owner.state === "online" ? "online" : owner.state;
    session.sourceAvailability = owner.state === "online" ? "online" : "offline";
    applyStableWorkspaceIdentity(session, sourceServerId);
  }

  /**
   * Source 身份已知后，logical session 的 workspace identity/workspaceKey 只允许是
   * `remote:server:<sourceServerId>:<path>`；调用方传入的 route identity 只保留为 legacyRouteHint。
   * 握手上线、Source owner 转交、在线 entry 直接 join 三条路径必须共用这一处规则。
   */
  function applyStableWorkspaceIdentity(
    session: LogicalSession<TServices, TCapabilities>,
    sourceServerId: string,
  ): void {
    session.sourceServerId = sourceServerId;
    if (!session.workspacePath) return;
    session.legacyWorkspaceIdentity ??= session.workspaceIdentity;
    session.workspaceIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: sourceServerId,
      workspacePath: session.workspacePath,
    });
    session.workspaceKey = session.workspaceIdentity;
    session.entry.workspaceKeys.add(session.workspaceIdentity);
  }

  function subscribeEntryHandle(
    entry: ConnectionEntry<TServices, TCapabilities>,
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
  ): void {
    entry.handle = handle;
    entry.closeSubscription = handle.onDidClose?.((event) => {
      handleConnectionClosed(entry, event);
    });
    entry.reconnectSubscription = handle.onDidReconnect?.(() => {
      handleConnectionReconnected(entry);
    });
  }

  async function takeOverRecoveringSourceOwner(
    provisional: ConnectionEntry<TServices, TCapabilities>,
    owner: ConnectionEntry<TServices, TCapabilities>,
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
    sourceServerId: string,
  ): Promise<void> {
    const previousHandle = owner.handle;
    owner.closeSubscription?.dispose();
    owner.closeSubscription = undefined;
    owner.reconnectSubscription?.dispose();
    owner.reconnectSubscription = undefined;
    if (owner.replacementRetryTimer) {
      clearTimeout(owner.replacementRetryTimer);
      owner.replacementRetryTimer = undefined;
    }
    owner.target = provisional.target;
    subscribeEntryHandle(owner, handle);

    for (const remoteSessionId of Array.from(provisional.sessions)) {
      const session = sessionsById.get(remoteSessionId);
      if (!session || session.entry !== provisional) continue;
      provisional.sessions.delete(remoteSessionId);
      owner.sessions.add(remoteSessionId);
      assignSessionToSourceOwner(session, owner, sourceServerId);
      // 当前 request 只是 recovery waiter，不能被 replaceDisconnectedSessions 当成上一代
      // logical owner 再换代一次；恢复完成后它会 join 真正的 replacement session。
      session.state = "connecting";
    }
    removeEntryOwners(provisional);
    entriesByKey.set(provisional.key, owner);
    provisional.handle = undefined;
    await disposeSupersededEntryTransport(provisional);
    await Promise.resolve(previousHandle?.dispose());
    handleConnectionReconnected(owner);
  }

  async function promoteOrJoinSourceOwner(
    entry: ConnectionEntry<TServices, TCapabilities>,
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
    sourceServerId: string,
  ): Promise<ConnectionEntry<TServices, TCapabilities>> {
    entry.sourceServerId = sourceServerId;
    const existing = entriesBySourceServerId.get(sourceServerId);
    if (!existing || existing === entry || !canOwnManagedSource(existing)) {
      entriesBySourceServerId.set(sourceServerId, entry);
      return entry;
    }

    if (
      existing.state === "disconnected" &&
      existing.closePhase === "recovering" &&
      !existing.reconnectFlight
    ) {
      // 不同 Profile 的手动连接已经拿到同一 Source 的新 handle，而旧 wrapper 尚未收到
      // reconnect（Manager 在发布点统一 fire，通常旧 wrapper 会先换代并把 entry 置回 online；
      // 只有它仍停在 recovering 且没有换代 flight 时才由新 handle 直接接管，避免 join 挂起）。
      await takeOverRecoveringSourceOwner(entry, existing, handle, sourceServerId);
      return existing;
    }

    // Bug 根因：route entry 在握手后曾直接成为 online owner，导致同一 Source 的多个
    // Profile 各自持有 logical wrapper。握手得到稳定身份后，竞争失败的 provisional
    // entry 必须在发布 online 前把 waiter/session 转交给 canonical Source entry。
    for (const remoteSessionId of Array.from(entry.sessions)) {
      const session = sessionsById.get(remoteSessionId);
      if (!session || session.entry !== entry) continue;
      entry.sessions.delete(remoteSessionId);
      existing.sessions.add(remoteSessionId);
      assignSessionToSourceOwner(session, existing, sourceServerId);
    }
    removeEntryOwners(entry);
    entriesByKey.set(entry.key, existing);
    await disposeSupersededEntryTransport(entry);
    return existing;
  }

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

  function beginRecovery(entry: ConnectionEntry<TServices, TCapabilities>): void {
    if (entry.recoveryReady) return;
    entry.recoveryFailure = undefined;
    entry.recoveryReady = new Promise<void>((resolve, reject) => {
      entry.resolveRecovery = resolve;
      entry.rejectRecovery = reject;
    });
    // 无手动 waiter 时终态拒绝也不得变成 unhandled rejection。
    void entry.recoveryReady.catch(() => undefined);
  }

  function completeRecovery(entry: ConnectionEntry<TServices, TCapabilities>): void {
    entry.resolveRecovery?.();
    entry.recoveryReady = undefined;
    entry.resolveRecovery = undefined;
    entry.rejectRecovery = undefined;
    entry.closePhase = "none";
    entry.lastRecoveryAttemptNotified = undefined;
    entry.recoveryFailure = undefined;
  }

  function notifyEntrySessionsClosed(
    entry: ConnectionEntry<TServices, TCapabilities>,
    event: WindowRemoteConnectionCloseEvent,
  ): void {
    for (const remoteSessionId of entry.sessions) {
      const session = sessionsById.get(remoteSessionId);
      if (!session || pendingSessionsByRequestId.get(session.requestId) === session) continue;
      options.onSessionClosed?.({ remoteSessionId, ...event });
    }
  }

  function failRecovery(entry: ConnectionEntry<TServices, TCapabilities>, error: Error): void {
    entry.recoveryFailure = error;
    entry.rejectRecovery?.(error);
    entry.recoveryReady = undefined;
    entry.resolveRecovery = undefined;
    entry.rejectRecovery = undefined;
  }

  function createRecoveryFailure(
    entry: ConnectionEntry<TServices, TCapabilities>,
    event: WindowRemoteConnectionCloseEvent,
  ): Error {
    const error = new Error(event.error || `Remote connection recovery exhausted: ${entry.key}`);
    if (event.reasonCode) Object.assign(error, { code: event.reasonCode });
    if (event.retryable !== undefined) Object.assign(error, { retryable: event.retryable });
    if (event.recoveryAttempt !== undefined) {
      Object.assign(error, { recoveryAttempt: event.recoveryAttempt });
    }
    if (event.recoveryLimit !== undefined) {
      Object.assign(error, { recoveryLimit: event.recoveryLimit });
    }
    return error;
  }

  function rollbackRecoveryReplacements(entry: ConnectionEntry<TServices, TCapabilities>): void {
    const replacements = entry.recoveryReplacements;
    if (!replacements) return;
    entry.recoveryReplacements = undefined;
    for (const { previous, current } of replacements) {
      if (sessionsById.get(current.remoteSessionId) === current) {
        sessionsById.delete(current.remoteSessionId);
      }
      entry.sessions.delete(current.remoteSessionId);
      previous.state = "disconnected";
      previous.sourceAvailability = "offline";
      sessionsById.set(previous.remoteSessionId, previous);
      entry.sessions.add(previous.remoteSessionId);
    }
  }

  function listDisconnectedSessions(
    entry: ConnectionEntry<TServices, TCapabilities>,
  ): LogicalSession<TServices, TCapabilities>[] {
    return [...entry.sessions]
      .map((remoteSessionId) => sessionsById.get(remoteSessionId))
      .filter(
        (session): session is LogicalSession<TServices, TCapabilities> =>
          Boolean(session) &&
          session?.state === "disconnected" &&
          pendingSessionsByRequestId.get(session.requestId) !== session,
      );
  }

  function isCurrentRecoveryReplacement(
    entry: ConnectionEntry<TServices, TCapabilities>,
    current: LogicalSession<TServices, TCapabilities>,
    transitionEpoch: number,
  ): boolean {
    return (
      !entry.disposed &&
      entriesByKey.get(entry.key) === entry &&
      entry.transitionEpoch === transitionEpoch &&
      entry.state === "online" &&
      sessionsById.get(current.remoteSessionId) === current &&
      entry.recoveryReplacements?.some((replacement) => replacement.current === current) === true
    );
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
    if (
      entry.target.kind !== "wsl" ||
      shouldKeepConnectionAlive(entry) ||
      !workspaceKey ||
      !workspaceGeneration
    ) {
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

  function abortError(): Error {
    return Object.assign(new Error("Remote workspace bind was aborted"), {
      name: "AbortError",
    });
  }

  async function waitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return await operation;
    if (signal.aborted) throw abortError();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  function prepareWorkspaceRuntime(
    session: LogicalSession<TServices, TCapabilities>,
    signal?: AbortSignal,
  ): Promise<void> {
    const expectedSessionGeneration = session.generation;
    const identityPreparation =
      session.entry.handle &&
      session.sourceServerId &&
      session.workspacePath &&
      session.workspaceIdentity &&
      options.prepareWorkspaceIdentity
        ? options.prepareWorkspaceIdentity(session.entry.handle, {
            sourceServerId: session.sourceServerId,
            workspacePath: session.workspacePath,
            stableWorkspaceIdentity: session.workspaceIdentity,
            ...(session.legacyWorkspaceIdentity
              ? { legacyRouteHint: session.legacyWorkspaceIdentity }
              : {}),
            ...(signal ? { signal } : {}),
          })
        : null;
    const identityReady = waitWithAbort(identityPreparation ?? Promise.resolve(), signal);
    if (session.entry.target.kind !== "wsl" || !session.workspacePath || !session.workspaceKey) {
      if (!identityPreparation) {
        session.workspaceReadyState = "ready";
        session.workspaceReady = Promise.resolve();
        return session.workspaceReady;
      }
      session.workspaceReadyState = "pending";
      session.workspaceReady = identityReady.then(
        () => {
          if (session.generation !== expectedSessionGeneration) throw abortError();
          session.workspaceReadyState = "ready";
        },
        (error) => {
          if (session.generation === expectedSessionGeneration) {
            session.workspaceReadyState = "failed";
          }
          throw error;
        },
      );
      return session.workspaceReady;
    }
    const workspaceKey = session.workspaceKey;
    const entry = session.entry;
    const existing = entry.workspaceRuntimeByKey.get(workspaceKey);
    const hasOtherOwner = hasOtherWorkspaceOwner(entry, workspaceKey, session.remoteSessionId);
    const state =
      existing ??
      ({
        context: {
          workspacePath: session.workspacePath,
          ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
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
    const ready = Promise.all([identityReady, releaseToWait ?? Promise.resolve()])
      .then(() => {
        if (
          sessionsById.get(session.remoteSessionId) !== session ||
          session.cancelled ||
          entry.workspaceRuntimeByKey.get(workspaceKey)?.generation !== session.workspaceGeneration
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

  async function disposeEntry(entry: ConnectionEntry<TServices, TCapabilities>): Promise<void> {
    if (entry.disposePromise) {
      return entry.disposePromise;
    }
    entry.disposed = true;
    clearIdleTimer(entry);
    if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
    entry.replacementRetryTimer = undefined;
    failRecovery(entry, new WindowRemoteConnectCancelledError());
    entry.state = "closing";
    entry.abortController.abort();
    entry.closeSubscription?.dispose();
    entry.closeSubscription = undefined;
    entry.reconnectSubscription?.dispose();
    entry.reconnectSubscription = undefined;
    removeEntryOwners(entry);
    options.onConnectionChanged?.();
    entry.disposePromise = Promise.resolve(entry.handle?.dispose()).then(() => undefined);
    return entry.disposePromise;
  }

  async function disposeSupersededEntryTransport(
    entry: ConnectionEntry<TServices, TCapabilities>,
  ): Promise<void> {
    if (entry.disposePromise) return entry.disposePromise;
    // Bug 原因：自动恢复的旧 entry 在手动重连抢占 connection key 后只是 return，
    // 旧 handle 上的 Manager state/reconnect 订阅永不释放。这里只回收失去 owner 的 transport
    // wrapper。旧 logical session 已经不可路由，必须在新 owner 接管时同步退休；否则每轮
    // 手动重连都会累积一份 disconnected session，下一次断开后 workspace scope 变成多解。
    for (const remoteSessionId of entry.sessions) {
      const session = sessionsById.get(remoteSessionId);
      if (
        !session ||
        session.entry !== entry ||
        session.state !== "disconnected" ||
        pendingSessionsByRequestId.get(session.requestId) === session
      ) {
        continue;
      }
      sessionsById.delete(remoteSessionId);
      entry.sessions.delete(remoteSessionId);
    }
    entry.disposed = true;
    clearIdleTimer(entry);
    if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
    entry.replacementRetryTimer = undefined;
    // Bug 原因：abort 只取消 transport，不能结束 connect 对 recoveryReady 的等待。
    // 旧 entry 被抢占后不再收到恢复事件，必须在释放订阅前主动拒绝其等待者。
    failRecovery(entry, new WindowRemoteConnectCancelledError());
    entry.abortController.abort();
    entry.closeSubscription?.dispose();
    entry.closeSubscription = undefined;
    entry.reconnectSubscription?.dispose();
    entry.reconnectSubscription = undefined;
    entry.disposePromise = Promise.resolve(entry.handle?.dispose()).then(() => undefined);
    return entry.disposePromise;
  }

  function handleConnectionClosed(
    entry: ConnectionEntry<TServices, TCapabilities>,
    event: WindowRemoteConnectionCloseEvent,
  ): void {
    // Bug 原因：逻辑替换重试曾跨物理断线存活，定时器会冒充重连把 entry 标回 online，
    // 耗尽预算后还会提前放行 recovery waiter。close 必须撤销旧 transport 的逻辑重试。
    if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
    entry.replacementRetryTimer = undefined;
    if (entry.disposed || entry.state === "closing") return;
    if (entry.state === "disconnected") {
      if (entry.closePhase === "recovering" && event.recoverable !== false) {
        if (
          event.recoveryAttempt !== undefined &&
          event.recoveryAttempt !== entry.lastRecoveryAttemptNotified
        ) {
          // Bug 原因：Manager 会发布 1/3、2/3、3/3，但 registry 曾把 disconnected 后的
          // recoverable close 全部丢弃，Renderer 永远停在首轮。只按 attempt 去重并继续投影。
          entry.lastRecoveryAttemptNotified = event.recoveryAttempt;
          notifyEntrySessionsClosed(entry, event);
        }
        return;
      }
      if (entry.closePhase !== "recovering" || event.recoverable !== false) return;
      entry.transitionEpoch += 1;
      entry.closePhase = "terminal";
      failRecovery(entry, createRecoveryFailure(entry, event));
      notifyEntrySessionsClosed(entry, event);
      return;
    }
    entry.transitionEpoch += 1;
    const hadRecoveryReplacement = Boolean(entry.recoveryReplacements?.length);
    if (hadRecoveryReplacement) {
      rollbackRecoveryReplacements(entry);
    }
    if (
      (entry.state === "connecting" || hadRecoveryReplacement || Boolean(entry.recoveryReady)) &&
      event.recoverable === false
    ) {
      // Bug 原因：恢复换代已经先发布了 provisional session id，终态 close 若直接沿用它，
      // Renderer 会收到一个从未完成连接的幽灵 id；同时 recoveryReady 无人 reject，join 永久等待。
      // 终态到达时先恢复上一代 logical session，再拒绝 recovery flight 并广播真实离线 owner。
      failRecovery(entry, createRecoveryFailure(entry, event));
    }
    entry.state = "disconnected";
    options.onConnectionChanged?.();
    entry.closePhase = event.recoverable === true ? "recovering" : "terminal";
    entry.lastRecoveryAttemptNotified = event.recoveryAttempt;
    if (entry.closePhase === "recovering") beginRecovery(entry);
    clearIdleTimer(entry);
    if (!shouldKeepConnectionAlive(entry) && entriesByKey.get(entry.key) === entry) {
      entriesByKey.delete(entry.key);
    }
    for (const remoteSessionId of entry.sessions) {
      const session = sessionsById.get(remoteSessionId);
      if (!session || pendingSessionsByRequestId.get(session.requestId) === session) continue;
      session.state = "disconnected";
      session.sourceAvailability = "offline";
      options.onSessionClosed?.({ remoteSessionId, ...event });
    }
  }

  async function replaceDisconnectedSessions(
    entry: ConnectionEntry<TServices, TCapabilities>,
  ): Promise<void> {
    if (
      entry.disposed ||
      !entry.handle ||
      (entry.state !== "disconnected" && entry.state !== "online")
    )
      return;
    const transitionEpoch = entry.transitionEpoch;
    // 物理 Source 已经恢复；logical replacement 的失败只属于对应 workspace，不能把
    // 已提交 sibling 的共享 transport 再标回 disconnected。
    entry.state = "online";
    entriesByKey.set(entry.key, entry);
    const disconnectedSessions = listDisconnectedSessions(entry);
    let firstReplacementError: unknown;
    let hasReplacementError = false;
    for (const previous of disconnectedSessions) {
      if (
        entry.disposed ||
        entriesByKey.get(entry.key) !== entry ||
        entry.transitionEpoch !== transitionEpoch ||
        entry.state !== "online"
      ) {
        throw new WindowRemoteConnectionTransitionStaleError();
      }
      if (
        sessionsById.get(previous.remoteSessionId) !== previous ||
        previous.state !== "disconnected"
      ) {
        continue;
      }
      const current: LogicalSession<TServices, TCapabilities> = {
        ...previous,
        remoteSessionId: options.createId(),
        target: entry.target,
        generation: previous.generation + 1,
        state: "connecting",
        sourceAvailability: "offline",
        sourceServerId: options.resolveSourceServerId?.(entry.handle) ?? previous.sourceServerId,
        workspaceReady: Promise.resolve(),
        workspaceReadyState: "pending",
        cancelled: false,
        rejectCancellation: () => undefined,
        cancellation: new Promise<never>(() => undefined),
      };
      entry.recoveryReplacements = [{ previous, current }];
      entry.sessions.delete(previous.remoteSessionId);
      sessionsById.delete(previous.remoteSessionId);
      sessionsById.set(current.remoteSessionId, current);
      entry.sessions.add(current.remoteSessionId);
      try {
        await prepareWorkspaceRuntime(current);
        if (!isCurrentRecoveryReplacement(entry, current, transitionEpoch)) {
          throw new WindowRemoteConnectionTransitionStaleError();
        }
        const commit = (): boolean => {
          if (!isCurrentRecoveryReplacement(entry, current, transitionEpoch)) {
            return false;
          }
          current.state = "online";
          current.sourceAvailability = "online";
          // 当前 workspace 的外部 owner 已提交；后续 sibling 失败不得再回滚本 generation。
          entry.recoveryReplacements = undefined;
          return true;
        };
        if (options.onSessionReconnected) {
          await options.onSessionReconnected({
            previous: toSessionSnapshot(previous),
            current: toSessionSnapshot(current),
            services: entry.handle.services,
            isCurrent: () => isCurrentRecoveryReplacement(entry, current, transitionEpoch),
            commit,
          });
        } else {
          commit();
        }
        if (
          sessionsById.get(current.remoteSessionId) !== current ||
          current.state !== "online" ||
          current.sourceAvailability !== "online" ||
          entry.recoveryReplacements !== undefined
        ) {
          throw new WindowRemoteConnectionTransitionStaleError();
        }
      } catch (error) {
        rollbackRecoveryReplacements(entry);
        if (
          sessionsById.get(current.remoteSessionId) === current &&
          current.state === "online" &&
          current.sourceAvailability === "online" &&
          entry.recoveryReplacements === undefined
        ) {
          // commit 是不可逆边界；提交后的旁路日志/通知异常只能上报，不能把已经对外发布的
          // generation 再塞回 rollback 路径。
          options.onSessionReconnectError?.(error);
          continue;
        }
        if (
          error instanceof WindowRemoteConnectionTransitionStaleError ||
          entry.disposed ||
          entriesByKey.get(entry.key) !== entry ||
          entry.transitionEpoch !== transitionEpoch ||
          entry.state !== "online"
        ) {
          throw new WindowRemoteConnectionTransitionStaleError();
        }
        // 单个 workspace 的 replacement 失败不能阻断同一 Source 上后续 sibling；继续提交
        // 其余 workspace，最后只为仍 disconnected 的 owner 安排下一轮 retry。
        if (!hasReplacementError) firstReplacementError = error;
        hasReplacementError = true;
      }
    }
    if (hasReplacementError) throw firstReplacementError;
    completeRecovery(entry);
  }

  function scheduleLogicalReplacementRetry(
    entry: ConnectionEntry<TServices, TCapabilities>,
    attempt: number,
    error: unknown,
  ): void {
    const delay = logicalReplacementRetryDelaysMs[attempt];
    if (entry.disposed || entry.state !== "online" || listDisconnectedSessions(entry).length === 0)
      return;
    if (delay === undefined) {
      const terminalError = error instanceof Error ? error : new Error(String(error));
      for (const session of listDisconnectedSessions(entry)) {
        options.onSessionClosed?.({
          remoteSessionId: session.remoteSessionId,
          exitCode: null,
          signal: null,
          recoverable: false,
          error: terminalError.message,
          ...("code" in terminalError && typeof terminalError.code === "string"
            ? { reasonCode: terminalError.code }
            : {}),
          ...("retryable" in terminalError && typeof terminalError.retryable === "boolean"
            ? { retryable: terminalError.retryable }
            : {}),
        });
      }
      // logical replacement 预算耗尽不能污染仍在线的 Source entry；等待中的手动 join
      // 继续使用已恢复 transport，并由自身 workspace admission 决定结果。
      completeRecovery(entry);
      return;
    }
    if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
    const retryEpoch = entry.transitionEpoch;
    entry.replacementRetryTimer = setTimeout(() => {
      // 迟到回调只属于安排时仍在线的 transport；先校验，避免摘掉新 epoch 的 timer。
      if (entry.state !== "online" || entry.transitionEpoch !== retryEpoch) return;
      entry.replacementRetryTimer = undefined;
      handleConnectionReconnected(entry, attempt + 1);
    }, delay);
  }

  function handleConnectionReconnected(
    entry: ConnectionEntry<TServices, TCapabilities>,
    attempt = 0,
  ): void {
    if (
      entry.reconnectFlight ||
      entry.disposed ||
      (entry.state !== "disconnected" && entry.state !== "online")
    )
      return;
    const currentOwner = entriesByKey.get(entry.key);
    if (currentOwner && currentOwner !== entry) {
      // Bug 原因：自动 retry 与用户手动重连可能共享 Manager 的新 connection。迟到的旧 entry
      // 曾无条件 set 回 connection key，制造两个 online logical session 并互相 dispose。
      // connection key 已有新 owner 时，旧恢复 flight 必须失效，交给 Host 清理离线 session。
      void disposeSupersededEntryTransport(entry);
      return;
    }
    if (entry.closePhase === "terminal") {
      // 新物理连接到达后，旧终态失败不能污染新线路的 join；挂回完成前用新屏障等待。
      entry.closePhase = "recovering";
      beginRecovery(entry);
    }
    let shouldRetry = false;
    let retryError: unknown;
    const flight = replaceDisconnectedSessions(entry)
      .catch((error) => {
        options.onSessionReconnectError?.(error);
        shouldRetry =
          !(error instanceof WindowRemoteConnectionTransitionStaleError) &&
          listDisconnectedSessions(entry).length > 0;
        retryError = error;
      })
      .finally(() => {
        if (entry.reconnectFlight === flight) entry.reconnectFlight = undefined;
        if (shouldRetry) scheduleLogicalReplacementRetry(entry, attempt, retryError);
      });
    entry.reconnectFlight = flight;
  }

  function createEntry(params: {
    key: string;
    membershipIntent?: "add" | "retain";
    existingSourceServerId?: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
    confirmSourceServerInstall?: boolean;
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
      transitionEpoch: 0,
      closePhase: "none",
      idleReason: "wsl-host-idle",
      workspaceKeys: new Set(),
      runningTaskCountByWorkspaceKey: new Map(),
      workspaceRuntimeByKey: new Map(),
    };
    entry.ready = options
      .connect({
        target: params.target,
        membershipIntent: params.membershipIntent,
        existingSourceServerId: params.existingSourceServerId,
        remoteAssets: params.remoteAssets,
        signal: abortController.signal,
        ...(params.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
      })
      .then(async (handle) => {
        // 关闭可能早于不可中断的握手返回；disposePromise 已完成时仍必须释放迟到的 socket。
        if (entry.disposed) {
          await handle.dispose();
          return handle;
        }
        entry.handle = handle;
        if (entry.disposed || (entry.sessions.size === 0 && !shouldKeepConnectionAlive(entry))) {
          // 修复原因：底层 SSH/WSL connector 可能无法中断认证或部署。
          // 最后一个 logical owner 取消后，迟到的成功结果必须立即释放，不能复活旧连接。
          await disposeEntry(entry);
          return handle;
        }
        const sourceServerId = options.resolveSourceServerId?.(handle);
        if (params.existingSourceServerId && sourceServerId !== params.existingSourceServerId) {
          await disposeEntry(entry);
          throw new WindowRemoteConnectionUnavailableError(params.existingSourceServerId);
        }
        const sourceOwner = sourceServerId
          ? await promoteOrJoinSourceOwner(entry, handle, sourceServerId)
          : entry;
        if (sourceOwner !== entry) return handle;
        entry.target = handle.reusedConnectionTarget ?? entry.target;
        entry.state = "online";
        subscribeEntryHandle(entry, handle);
        options.onConnectionChanged?.();
        for (const remoteSessionId of entry.sessions) {
          const session = sessionsById.get(remoteSessionId);
          if (!session || session.cancelled) {
            continue;
          }
          session.target = entry.target;
          session.state = "online";
          session.sourceAvailability = "online";
          if (sourceServerId) {
            applyStableWorkspaceIdentity(session, sourceServerId);
          }
        }
        return handle;
      })
      .catch((error) => {
        entry.state = "failed";
        removeEntryOwners(entry);
        options.onConnectionChanged?.();
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
    options.onConnectionChanged?.();
    return entry;
  }

  function resolveEntry(params: {
    key: string;
    membershipIntent?: "add" | "retain";
    existingSourceServerId?: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
    confirmSourceServerInstall?: boolean;
  }): ConnectionEntry<TServices, TCapabilities> {
    const existing = entriesByKey.get(params.key);
    if (
      existing &&
      !existing.disposed &&
      !existing.abortController.signal.aborted &&
      (existing.state !== "disconnected" ||
        (existing.closePhase === "recovering" && shouldKeepConnectionAlive(existing)))
    ) {
      clearIdleTimer(existing);
      return existing;
    }
    const created = createEntry(params);
    if (existing && existing !== created) {
      // Bug 原因：terminal entry 被新 owner 覆盖后仍保留 Manager close/reconnect 订阅，
      // 每次手动重连都会泄漏一代 wrapper。物理 Source 仍由 Manager 持有，只回收 wrapper。
      void disposeSupersededEntryTransport(existing);
    }
    return created;
  }

  async function connect(
    params: {
      requestId: string;
      target: RemoteTarget;
      remoteAssets: WindowRemoteAssetDirs;
      workspacePath?: string;
      workspaceIdentity?: string;
      workspacePurpose?: WorkspacePurpose;
      confirmSourceServerInstall?: boolean;
    },
    admission?: {
      entry: ConnectionEntry<TServices, TCapabilities>;
      services: TServices;
      assertCurrent(): Promise<void>;
    },
  ): Promise<WindowHostRemoteWorkspaceDescriptor> {
    if (disposed) {
      throw new Error("窗口 Host 的远程连接 registry 已释放");
    }
    if (pendingSessionsByRequestId.has(params.requestId)) {
      throw new Error(`远程连接 requestId 重复，requestId=${params.requestId}`);
    }

    const remoteSessionId = options.createId();
    const key = buildConnectionKey(params.target);
    const previousEntry = entriesByKey.get(key);
    const initialEntry =
      admission?.entry ??
      resolveEntry({
        key,
        target: params.target,
        remoteAssets: params.remoteAssets,
        ...(params.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
      });
    let reusedConnectionTarget =
      initialEntry.state === "online" ? stripRemoteTargetSecrets(initialEntry.target) : undefined;
    let rejectCancellation!: (error: WindowRemoteConnectCancelledError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const sourceServerId = initialEntry.handle
      ? options.resolveSourceServerId?.(initialEntry.handle)
      : undefined;
    // 复用已在线的 Host 时不会再触发握手回调，仍须先绑定稳定 workspace 身份。
    const workspaceIdentity =
      sourceServerId && params.workspacePath
        ? buildServerRemoteWorkspaceIdentity({
            serverId: sourceServerId,
            workspacePath: params.workspacePath,
          })
        : params.workspaceIdentity;
    const session: LogicalSession<TServices, TCapabilities> = {
      ...(sourceServerId ? { sourceServerId } : {}),
      remoteSessionId,
      requestId: params.requestId,
      target: initialEntry.target,
      ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(params.workspacePurpose ? { workspacePurpose: params.workspacePurpose } : {}),
      ...(params.workspaceIdentity ? { legacyWorkspaceIdentity: params.workspaceIdentity } : {}),
      generation: 1,
      state: initialEntry.state === "online" ? "online" : "connecting",
      sourceAvailability: initialEntry.state === "online" ? "online" : "offline",
      entry: initialEntry,
      workspaceReady: Promise.resolve(),
      workspaceReadyState: "pending",
      cancelled: false,
      rejectCancellation,
      cancellation,
    };
    initialEntry.sessions.add(remoteSessionId);
    if (sourceServerId) {
      // Bug 原因：entry 已在线时 connect 能直接拿到 sourceServerId，却没有像握手上线、Source owner
      // 转交和 bindWorkspaceContext 那样把 identity 归一成 remote:server:*。Renderer 对未换代的
      // legacy 条目手动重连、或 Host 为无 context 的 connect 补 route identity 时，owner 去重按原值
      // 比对必然不命中，会为同一 workspace 发布第二个 online logical session，并把 legacy identity
      // 当权威值返回；随后 bind 把它改写成 stable，两条 session 同 key，findSessionForWorkspace 多解。
      applyStableWorkspaceIdentity(session, sourceServerId);
    }
    if (!session.workspaceKey) {
      const initialWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      if (initialWorkspaceKey) {
        initialEntry.workspaceKeys.add(initialWorkspaceKey);
        session.workspaceKey = initialWorkspaceKey;
      }
    }
    sessionsById.set(remoteSessionId, session);
    pendingSessionsByRequestId.set(params.requestId, session);
    const preparationController = new AbortController();

    try {
      const initialTransitionEpoch = initialEntry.transitionEpoch;
      const readyHandle = await Promise.race([initialEntry.ready, cancellation]);
      reusedConnectionTarget ??= readyHandle.reusedConnectionTarget;
      // 加入别人的 connecting entry 也没有使用本次凭据；以最终 owner 的实际目标投影结果。
      if (previousEntry === initialEntry) {
        reusedConnectionTarget = stripRemoteTargetSecrets(session.entry.target);
      }
      const entry = session.entry;
      const transitionEpoch =
        entry === initialEntry ? initialTransitionEpoch : entry.transitionEpoch;
      if (entry.recoveryFailure) throw entry.recoveryFailure;
      if (entry.recoveryReady) {
        await Promise.race([entry.recoveryReady, cancellation]);
      }
      if (entry.recoveryFailure) throw entry.recoveryFailure;
      await Promise.race([
        prepareWorkspaceRuntime(session, preparationController.signal),
        cancellation,
      ]);
      if (admission) await Promise.race([admission.assertCurrent(), cancellation]);
      if (
        session.cancelled ||
        sessionsById.get(remoteSessionId) !== session ||
        entry.disposed ||
        entriesByKey.get(entry.key) !== entry ||
        entry.transitionEpoch !== transitionEpoch ||
        entry.state !== "online" ||
        (admission && entry.handle?.services !== admission.services)
      ) {
        if (!session.cancelled && sessionsById.get(remoteSessionId) === session) {
          throw new WindowRemoteConnectionUnavailableError(remoteSessionId);
        }
        throw new WindowRemoteConnectCancelledError();
      }
      const existingWorkspaceOwner =
        session.workspaceKey && session.workspacePath && session.workspaceIdentity
          ? Array.from(sessionsById.values()).find(
              (candidate) =>
                candidate !== session &&
                // Bug 根因：Manager 已按 sourceServerId 复用物理连接，但 Registry 曾只在
                // 同 route entry 内查找 workspace owner。不同 Profile 握手到同一 Source 后
                // 必须按稳定 Source 身份收敛；未识别 Source 仍只允许同 entry 复用。
                (candidate.entry === entry ||
                  (session.sourceServerId !== undefined &&
                    candidate.sourceServerId === session.sourceServerId)) &&
                candidate.workspaceKey === session.workspaceKey &&
                candidate.workspacePath === session.workspacePath &&
                candidate.workspaceIdentity === session.workspaceIdentity &&
                candidate.state === "online" &&
                candidate.sourceAvailability === "online" &&
                // Bug 原因：entry online 会先把 logical session 标成 online，但 workspace identity
                // preparation 可能仍在运行。join 只能复用已经可安全暴露 scoped services 的 owner。
                candidate.workspaceReadyState === "ready",
            )
          : undefined;
      if (existingWorkspaceOwner) {
        // Bug 原因：recovery replacement 与 Bot/手动 join 曾各创建一个 online logical
        // session。workspace owner 已恢复时，join caller 复用唯一 owner，不发布第二份 session。
        sessionsById.delete(remoteSessionId);
        entry.sessions.delete(remoteSessionId);
        if (existingWorkspaceOwner.entry !== entry && entry.sessions.size === 0) {
          // 不同 Profile 创建的 provisional wrapper 已失去最后一个 logical owner；只回收
          // wrapper/Manager 订阅，handle.dispose 不会断开 Manager 持有的物理 Source connection。
          await disposeEntry(entry);
        }
        return {
          ...(existingWorkspaceOwner.sourceServerId
            ? { sourceServerId: existingWorkspaceOwner.sourceServerId }
            : {}),
          ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
          remoteSessionId: existingWorkspaceOwner.remoteSessionId,
          target: stripRemoteTargetSecrets(existingWorkspaceOwner.target),
          workspacePath: existingWorkspaceOwner.workspacePath,
          workspaceIdentity: existingWorkspaceOwner.workspaceIdentity,
          ...(existingWorkspaceOwner.workspacePurpose
            ? { workspacePurpose: existingWorkspaceOwner.workspacePurpose }
            : {}),
          generation: existingWorkspaceOwner.generation,
        };
      }
      session.state = "online";
      session.sourceAvailability = "online";
      return {
        ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
        ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
        remoteSessionId,
        target: stripRemoteTargetSecrets(session.target),
        ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
        ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
        ...(session.workspacePurpose ? { workspacePurpose: session.workspacePurpose } : {}),
        generation: session.generation,
      };
    } catch (error) {
      const entry = session.entry;
      if (sessionsById.get(remoteSessionId) === session) {
        sessionsById.delete(remoteSessionId);
        entry.sessions.delete(remoteSessionId);
        session.state = "failed";
        session.sourceAvailability = "offline";
        if (
          entry.sessions.size === 0 &&
          !shouldKeepConnectionAlive(entry) &&
          (entry.target.kind === "docker" || entry.target.kind === "server")
        ) {
          await disposeEntry(entry);
        }
      }
      throw error;
    } finally {
      // logical caller 取消或已结束后，迟到的远端 stat 不得再进入身份绑定；信号只属于
      // 这次 preparation，不能 abort 同 Source 其他工作区共用的物理连接。
      preparationController.abort();
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
      if (session.entry.target.kind === "ssh" && session.entry.state === "connecting") {
        // Bug 根因：最后一个 waiter 取消后，旧 entry 仍以 connecting 留在复用表；立即重连会
        // 继续等待已经 aborted 的 readiness，并沿用上一次凭据。先按对象身份退休旧 entry，
        // 再触发底层取消；迟到的旧 completion 不能删除或复活同 key 的新连接。
        if (entriesByKey.get(session.entry.key) === session.entry) {
          entriesByKey.delete(session.entry.key);
        }
        session.entry.state = "closing";
        session.entry.abortController.abort();
      } else if (
        (session.entry.target.kind === "docker" || session.entry.target.kind === "server") &&
        session.entry.state === "connecting"
      ) {
        // Bug 根因：Docker/Server 的 pending transport 不可被 logical cancel 中断，但也不能继续
        // 占用 connection key，否则下一次 dedicated connect 会错误复用已经没有 waiter 的旧 flight。
        if (entriesByKey.get(session.entry.key) === session.entry) {
          entriesByKey.delete(session.entry.key);
        }
      } else if (shouldKeepConnectionAlive(session.entry)) {
        // Managed Source 的物理连接归 Manager；registry handle 只持有 logical wrapper/订阅。
        void disposeEntry(session.entry);
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
    workspacePurpose?: WorkspacePurpose;
    legacyWorkspaceIdentity?: string;
    signal?: AbortSignal;
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
    const previousSession = {
      workspacePath: session.workspacePath,
      legacyWorkspaceIdentity: session.legacyWorkspaceIdentity,
      workspaceIdentity: session.workspaceIdentity,
      workspacePurpose: session.workspacePurpose,
      generation: session.generation,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
      workspaceReady: session.workspaceReady,
      workspaceReadyState: session.workspaceReadyState,
    };
    session.workspacePath = params.workspacePath;
    session.legacyWorkspaceIdentity = params.legacyWorkspaceIdentity ?? params.workspaceIdentity;
    session.workspaceIdentity = session.sourceServerId
      ? buildServerRemoteWorkspaceIdentity({
          serverId: session.sourceServerId,
          workspacePath: params.workspacePath,
        })
      : params.workspaceIdentity;
    session.workspacePurpose = params.workspacePurpose ?? session.workspacePurpose;
    session.generation += 1;
    // Bug 原因：managed Source 会把 params 中的 route identity 换成 stable identity，
    // workspaceKey 若仍从原参数取值，session 就会同时持有两个身份源。
    session.workspaceKey = session.workspaceIdentity.trim() || params.workspacePath;
    session.entry.workspaceKeys.add(session.workspaceKey);
    const nextWorkspaceKey = session.workspaceKey;
    const ready = prepareWorkspaceRuntime(session, params.signal);
    return ready.then(
      () => {
        if (previousOwnership.workspaceKey !== nextWorkspaceKey) {
          const release = requestWorkspaceRelease(previousOwnership);
          void release?.catch(() => undefined);
        }
      },
      (error) => {
        const failedOwnership = {
          entry: session.entry,
          remoteSessionId: session.remoteSessionId,
          workspaceKey: nextWorkspaceKey,
          workspaceGeneration: session.workspaceGeneration,
        };
        session.workspacePath = previousSession.workspacePath;
        session.legacyWorkspaceIdentity = previousSession.legacyWorkspaceIdentity;
        session.workspaceIdentity = previousSession.workspaceIdentity;
        session.workspacePurpose = previousSession.workspacePurpose;
        session.generation = previousSession.generation;
        session.workspaceKey = previousSession.workspaceKey;
        session.workspaceGeneration = previousSession.workspaceGeneration;
        session.workspaceReady = previousSession.workspaceReady;
        session.workspaceReadyState = previousSession.workspaceReadyState;
        if (
          nextWorkspaceKey &&
          !Array.from(sessionsById.values()).some(
            (candidate) => candidate !== session && candidate.workspaceKey === nextWorkspaceKey,
          )
        ) {
          session.entry.workspaceKeys.delete(nextWorkspaceKey);
        }
        const release = requestWorkspaceRelease(failedOwnership);
        void release?.catch(() => undefined);
        throw error;
      },
    );
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
      if (shouldKeepConnectionAlive(session.entry)) {
        // Bug 原因：把“物理 Source 常驻”误当成“logical wrapper 常驻”，关最后 tab
        // 后 close/reconnect 订阅会永久残留。handle.dispose 不会断开 Manager 物理连接。
        await disposeEntry(session.entry);
      } else if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
        scheduleWslIdleDispose(session.entry, "last-logical-session-disposed");
      } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
        // R1 只迁移 SSH pool 的 owner：ready connection 继续保持 window-scoped cache，
        // logical session 清空不等于连接退出；真实窗口 Host shutdown 时统一释放。
        clearIdleTimer(session.entry);
      } else {
        await disposeEntry(session.entry);
      }
    }
    await workspaceRelease?.catch(() => undefined);
  }

  function getOnlineSource(sourceServerId: string) {
    const entry = entriesBySourceServerId.get(sourceServerId);
    return entry && !entry.disposed && entry.state === "online" ? entry.handle : undefined;
  }

  return {
    async connectSource(params: {
      target: RemoteTarget;
      remoteAssets: WindowRemoteAssetDirs;
      membershipIntent?: "add" | "retain";
      existingSourceServerId?: string;
    }) {
      if (disposed) throw new WindowRemoteConnectCancelledError();
      if (params.existingSourceServerId) {
        const current = getOnlineSource(params.existingSourceServerId);
        if (current) return { sourceServerId: params.existingSourceServerId, handle: current };
      }
      const entry = resolveEntry({ ...params, key: buildConnectionKey(params.target) });
      await entry.ready;
      const owner = entry.sourceServerId
        ? entriesBySourceServerId.get(entry.sourceServerId)
        : entry;
      if (
        !owner ||
        owner.disposed ||
        owner.state !== "online" ||
        !owner.sourceServerId ||
        !owner.handle
      )
        throw new WindowRemoteConnectionUnavailableError("host-connection");
      return { sourceServerId: owner.sourceServerId, handle: owner.handle };
    },
    getOnlineSource,
    listConnections() {
      return Array.from(new Set(entriesByKey.values()), (entry) => ({
        sourceServerId: entry.sourceServerId,
        target: stripRemoteTargetSecrets(entry.target),
        state: entry.state,
      }));
    },
    connect: (params: Parameters<typeof connect>[0]) => connect(params),
    async openWorkspaceOnSource(params: {
      requestId: string;
      sourceServerId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      workspacePurpose?: WorkspacePurpose;
      assertCurrent(): Promise<void>;
    }): Promise<WindowHostRemoteWorkspaceDescriptor> {
      const entry = entriesBySourceServerId.get(params.sourceServerId);
      // 手机项目导航只取得已在线连接，不走 resolveEntry/connector，也不等待后台恢复。
      if (!entry || entry.disposed || entry.state !== "online" || !entry.handle)
        throw new WindowRemoteConnectionUnavailableError(params.sourceServerId);
      return connect(
        { ...params, target: entry.target, remoteAssets: {} },
        {
          entry,
          services: entry.handle.services,
          assertCurrent: params.assertCurrent,
        },
      );
    },
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
        connectionCount: new Set(entriesByKey.values()).size,
        logicalSessionCount: sessionsById.size,
      };
    },
    setWorkspaceRunningTaskCount(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      runningTaskCount: number;
    }): void {
      const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      // 同一 Source entry 可能被多条 route alias 引用；workspace 生命周期副作用只执行一次。
      for (const entry of new Set(entriesByKey.values())) {
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
