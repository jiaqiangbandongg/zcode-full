import { sourceServerRunningTasksSchema, type SourceServerRunningTask } from "@zcode/shared";
/* eslint-disable max-lines -- Source 连接状态机、重试、更新和单连接归并必须共享同一代际状态。 */
import { SourceServerOperationLogs } from "./sourceServerOperationLogs.js";
import { Emitter, type Event } from "@zcode/rpc";
import type {
  ConnectionProfile,
  RemoteTarget,
  ServerRemoteInfo,
  CompatibilityManifest,
  SourceServerArtifactPolicy,
  SourceServerConnectionStateSnapshot,
} from "@zcode/shared";
import {
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE,
  ZCODE_COMPATIBILITY_MANIFEST,
  compareCompatibilityVersions,
  evaluateSourceServerCompatibility,
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  createSourceServerTransportAdapter,
  type ServerReleaseAsset,
  type SourceServerFileTransfer,
  type SourceServerTransportAdapter,
  type TransportContext,
} from "@zcode/server/source-server";
import {
  connectServerRemoteOverDuplex,
  type ServerRemoteConnection,
  type ServerRemoteDuplexConnectionOptions,
} from "./serverRemoteConnection.js";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import { isSourceServerAutomaticRecoveryTerminalState } from "./sourceServerRecoveryPolicy.js";

export type {
  SourceServerConnectionState,
  SourceServerConnectionStateSnapshot,
} from "@zcode/shared";

export interface ManagedSourceServerConnection {
  /** 本次调用复用物理连接时的实际脱敏目标；不写入在线 owner。 */
  reusedConnectionTarget?: RemoteTarget;
  sourceServerId: string;
  profileId: string;
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
}

export type SourceServerConnectionInvalidatedEvent =
  | {
      sourceServerId: string;
      reason: "update";
    }
  | {
      sourceServerId: string;
      reason: "profile-removed";
      recoverable: false;
    };

export class SourceServerInstallRequiredError extends Error {
  public readonly code = SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE;
  public readonly retryable = false;
  public constructor(public readonly profileId: string) {
    super("Source Server installation requires explicit user confirmation");
    this.name = "SourceServerInstallRequiredError";
  }
}

export class SourceServerUpgradeRequiredError extends Error {
  public readonly code = SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE;
  public readonly retryable = false;
  public constructor(
    public readonly profileId: string,
    public readonly upgradeTarget: "controller" | "server",
    public readonly currentVersion: string,
    public readonly minimumVersion: string,
    public readonly reason: "compatibility" | "development-archive" = "compatibility",
  ) {
    super(
      reason === "development-archive"
        ? `Source Server ${currentVersion} release archive differs from the current development build and must be updated`
        : upgradeTarget === "server"
          ? `Source Server ${currentVersion} must be upgraded to at least ${minimumVersion}`
          : `ZCode Desktop ${currentVersion} must be upgraded to at least ${minimumVersion}`,
    );
    this.name = "SourceServerUpgradeRequiredError";
  }
}

export class SourceServerIdentityChangePendingError extends Error {
  public readonly code = SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE;
  public readonly retryable = false;
  public constructor(
    public readonly profileId: string,
    public readonly pendingSourceServerId: string,
  ) {
    super("Source Server identity changed after reinstall and requires confirmation");
    this.name = "SourceServerIdentityChangePendingError";
  }
}

class SourceServerExplicitDisconnectError extends Error {
  public readonly code = "remote-connection-canceled";
  public constructor(public readonly sourceServerId: string) {
    super(`Source Server explicitly disconnected: ${sourceServerId}`);
    this.name = "SourceServerExplicitDisconnectError";
  }
}

class SourceServerProfileRemovedError extends Error {
  public constructor(public readonly profileId: string) {
    super(`Connection Profile removed: ${profileId}`);
    this.name = "SourceServerProfileRemovedError";
  }
}

class SourceServerHandshakeClosedError extends Error {
  public readonly retryable = true;
  public constructor(reason: string) {
    super(`Source Server connection closed during handshake: ${reason}`);
    this.name = "SourceServerHandshakeClosedError";
  }
}

export interface SourceServerConnectionManagerOptions {
  /** 成员关系归持久化端口；连接管理器只负责 admission 和握手提交的时序。 */
  admitConnection?: (input: {
    profile: ConnectionProfile;
    intent: "add" | "retain";
    confirmIdentityChange: boolean;
  }) => Promise<(sourceServerId: string) => Promise<void>>;
  directory: {
    recordLastOnline?(sourceServerId: string, timestamp: number): Promise<void>;
    markSourceUninstalled?(profileId: string): Promise<void>;
    recordHandshake(
      profileId: string,
      handshake: Parameters<SourceServerDirectory["recordHandshake"]>[1],
      options?: Parameters<SourceServerDirectory["recordHandshake"]>[2],
    ): Promise<{
      identityChanged: boolean;
      effectiveProfile?: ConnectionProfile;
    }>;
  };
  createAdapter?: (kind: "ssh" | "wsl" | "docker") => SourceServerTransportAdapter;
  connectServer?: (options: ServerRemoteDuplexConnectionOptions) => Promise<ServerRemoteConnection>;
  now?: () => number;
  logWarn?: (message: string, error: Error) => void;
  onProjectChange?: (sourceServerId: string) => void;
  compatibilityManifest?: CompatibilityManifest;
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
  resolveRelease?: (
    probe: Awaited<ReturnType<SourceServerTransportAdapter["probe"]>>,
    target: Exclude<RemoteTarget, { kind: "server" }>,
    options?: { metadataOnly?: boolean },
  ) => Promise<ServerReleaseAsset>;
}

export interface ConnectSourceServerOptions {
  membershipIntent?: "add" | "retain";
  profile: ConnectionProfile;
  target: RemoteTarget;
  release?: ServerReleaseAsset;
  allowInstall?: boolean;
  confirmIdentityChange?: boolean;
  resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  context?: TransportContext;
  onDiagnosticPhase?: (phase: string) => void;
  /** 仅实际执行探测/握手的 flight 在升级等待点调用，join 请求不得提交另一份凭据。 */
  onAuthenticatedUpgradeRequired?: () => Promise<void>;
}

export interface StartupReconnectResult {
  profileId: string;
  status: "online" | "failed";
  error?: string;
}

interface OnlineConnection extends ManagedSourceServerConnection {
  connection: ServerRemoteConnection;
  profileIds: Set<string>;
  projectSubscription?: { dispose(): void };
}

interface ReconnectInput {
  profile: ConnectionProfile;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  context: TransportContext;
}

interface ConnectFlight {
  promise: Promise<ManagedSourceServerConnection>;
  sourceServerId?: string;
  controller: AbortController;
}

const ONLINE_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
const OFFLINE_PROBE_INTERVAL_MS = 2 * 60_000;

function readErrorRetryable(error: unknown): boolean | undefined {
  if (!error || typeof error !== "object" || !("retryable" in error)) {
    return undefined;
  }
  return typeof error.retryable === "boolean" ? error.retryable : undefined;
}

function isAutomaticRecoveryUserActionCode(code: unknown): boolean {
  return (
    code === SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE ||
    code === SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE ||
    code === SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE
  );
}

function buildCompatibilityState(
  controller: CompatibilityManifest,
  server: CompatibilityManifest,
): Pick<
  SourceServerConnectionStateSnapshot,
  "updateAvailability" | "currentVersion" | "availableVersion" | "minimumVersion" | "upgradeTarget"
> {
  const result = evaluateSourceServerCompatibility(controller, server);
  if (!result.compatible && result.upgradeTarget) {
    return {
      updateAvailability: "required",
      currentVersion: result.olderVersion,
      availableVersion: result.newerVersion,
      minimumVersion: result.requiredMinimumVersion,
      upgradeTarget: result.upgradeTarget,
    };
  }
  if (result.updateAvailable) {
    return {
      updateAvailability: "available",
      currentVersion: result.olderVersion,
      availableVersion: result.newerVersion,
      minimumVersion: result.requiredMinimumVersion,
      upgradeTarget: result.newerEndpoint === "controller" ? "server" : "controller",
    };
  }
  return {
    updateAvailability: "none",
    currentVersion: server.productVersion,
    availableVersion: server.productVersion,
    minimumVersion: result.requiredMinimumVersion,
  };
}

function preserveCompatibilityState(
  snapshot: SourceServerConnectionStateSnapshot,
): Pick<
  SourceServerConnectionStateSnapshot,
  "updateAvailability" | "currentVersion" | "availableVersion" | "minimumVersion" | "upgradeTarget"
> {
  return {
    ...(snapshot.updateAvailability ? { updateAvailability: snapshot.updateAvailability } : {}),
    ...(snapshot.currentVersion ? { currentVersion: snapshot.currentVersion } : {}),
    ...(snapshot.availableVersion ? { availableVersion: snapshot.availableVersion } : {}),
    ...(snapshot.minimumVersion ? { minimumVersion: snapshot.minimumVersion } : {}),
    ...(snapshot.upgradeTarget ? { upgradeTarget: snapshot.upgradeTarget } : {}),
  };
}

function createConcurrencyGate(limit: number): {
  acquire(): Promise<() => void>;
} {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    acquire: async () =>
      await new Promise<() => void>((resolve) => {
        const grant = () => {
          active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active -= 1;
            waiting.shift()?.();
          });
        };
        if (active < limit) grant();
        else waiting.push(grant);
      }),
  };
}

export class SourceServerConnectionManager {
  private readonly adapters = new Map<string, SourceServerTransportAdapter>();
  private readonly states = new Map<string, SourceServerConnectionStateSnapshot>();
  private readonly compatibilityByProfileId = new Map<
    string,
    ReturnType<typeof preserveCompatibilityState>
  >();
  private readonly onlineBySourceServerId = new Map<string, OnlineConnection>();
  private readonly connectFlights = new Map<string, ConnectFlight>();
  private readonly stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
  private readonly reconnectEmitter = new Emitter<ManagedSourceServerConnection>();
  private readonly connectionInvalidatedEmitter =
    new Emitter<SourceServerConnectionInvalidatedEvent>();
  private readonly reconnectInputs = new Map<string, ReconnectInput>();
  private readonly profileIdsBySourceServerId = new Map<string, Set<string>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly offlineProbeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly updateFlights = new Set<{
    profileId: string;
    sourceServerId?: string;
    controller: AbortController;
  }>();
  public readonly onDidChangeState: Event<SourceServerConnectionStateSnapshot> =
    this.stateEmitter.event;
  public readonly onDidReconnect: Event<ManagedSourceServerConnection> =
    this.reconnectEmitter.event;
  public readonly onDidInvalidateConnection: Event<SourceServerConnectionInvalidatedEvent> =
    this.connectionInvalidatedEmitter.event;
  private readonly createAdapter: NonNullable<
    SourceServerConnectionManagerOptions["createAdapter"]
  >;
  private readonly connectServer: NonNullable<
    SourceServerConnectionManagerOptions["connectServer"]
  >;
  private readonly now: () => number;
  private readonly compatibilityManifest: CompatibilityManifest;

  private readonly operationLogs = new SourceServerOperationLogs(() => this.now());
  public readonly onDidAppendOperationLog = this.operationLogs.onDidAppend;
  public getRecentOperationLogs(profile: Pick<ConnectionProfile, "profileId" | "sourceServerId">) {
    return this.operationLogs.read(profile);
  }

  public constructor(private readonly options: SourceServerConnectionManagerOptions) {
    this.createAdapter =
      options.createAdapter ?? ((kind) => createSourceServerTransportAdapter(kind));
    this.connectServer = options.connectServer ?? connectServerRemoteOverDuplex;
    this.now = options.now ?? Date.now;
    this.compatibilityManifest = options.compatibilityManifest ?? ZCODE_COMPATIBILITY_MANIFEST;
  }

  public async connect(
    options: ConnectSourceServerOptions,
  ): Promise<ManagedSourceServerConnection> {
    return await this.connectForSource(
      { ...options, membershipIntent: options.membershipIntent ?? "add" },
      options.profile.sourceServerId,
    );
  }

  private reusedConnection(
    connection: ManagedSourceServerConnection,
  ): ManagedSourceServerConnection {
    const target = this.reconnectInputs.get(connection.sourceServerId)?.target;
    return {
      sourceServerId: connection.sourceServerId,
      profileId: connection.profileId,
      serverInfo: connection.serverInfo,
      services: connection.services,
      ...(target ? { reusedConnectionTarget: stripRemoteTargetSecrets(target) } : {}),
    };
  }

  private async connectForSource(
    options: ConnectSourceServerOptions,
    sourceServerId: string | undefined,
    recordOperation = true,
  ): Promise<ManagedSourceServerConnection> {
    const existingFlight = this.connectFlights.get(options.profile.profileId);
    if (existingFlight) return this.reusedConnection(await existingFlight.promise);
    const controller = new AbortController();
    const flightOptions = sourceServerId
      ? {
          ...options,
          context: {
            ...options.context,
            signal: options.context?.signal
              ? AbortSignal.any([options.context.signal, controller.signal])
              : controller.signal,
          },
        }
      : options;
    let flight!: ConnectFlight;
    const connect = (context: TransportContext) =>
      this.connectOnce({ ...flightOptions, context }, controller.signal);
    const promise = (
      recordOperation
        ? this.operationLogs.run(
            "connect",
            options.profile,
            options.target,
            flightOptions.context,
            connect,
          )
        : connect(flightOptions.context ?? {})
    ).finally(() => {
      if (this.connectFlights.get(options.profile.profileId) === flight) {
        this.connectFlights.delete(options.profile.profileId);
      }
    });
    flight = {
      promise,
      ...(sourceServerId ? { sourceServerId } : {}),
      controller,
    };
    this.connectFlights.set(options.profile.profileId, flight);
    return await promise;
  }

  public getStateByProfile(profileId: string): SourceServerConnectionStateSnapshot {
    return (
      this.states.get(profileId) ?? {
        profileId,
        state: "absent",
        updatedAt: this.now(),
      }
    );
  }

  public listStates(): SourceServerConnectionStateSnapshot[] {
    return [...this.states.values()];
  }

  public async reconnectOnStartup(
    candidates: Array<{
      profile: ConnectionProfile;
      target: Exclude<RemoteTarget, { kind: "server" }>;
    }>,
    options: { maxConcurrency?: number; timeoutMs?: number } = {},
  ): Promise<StartupReconnectResult[]> {
    if (candidates.length === 0) return [];
    const timeoutMs = options.timeoutMs ?? 10_000;
    const globalGate = createConcurrencyGate(Math.max(1, options.maxConcurrency ?? 3));
    // Bug 原因：多个 Docker Source 共用本机 Docker daemon、磁盘和 CPU。三条冷启动 probe
    // 同时校验大体积 release 时，单条手动连接只需约 4.6 秒，三条并发却会一起撞上 10 秒
    // 上限。Docker 冷启动在 transport 内串行，SSH 仍可占用其余全局槽位。
    const dockerGate = createConcurrencyGate(1);
    const reconnectCandidate = async (
      candidate: (typeof candidates)[number],
    ): Promise<StartupReconnectResult> => {
      const releaseTransport =
        candidate.target.kind === "docker" ? await dockerGate.acquire() : undefined;
      const releaseGlobal = await globalGate.acquire();
      const abortController = new AbortController();
      const startedAt = Date.now();
      let diagnosticPhase = "queued";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.connect({
            profile: candidate.profile,
            target: candidate.target,
            membershipIntent: "retain",
            context: { signal: abortController.signal },
            onDiagnosticPhase: (phase) => {
              diagnosticPhase = phase;
            },
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Source Server startup reconnect timed out after ${timeoutMs}ms`));
              abortController.abort();
            }, timeoutMs);
          }),
        ]);
        return { profileId: candidate.profile.profileId, status: "online" };
      } catch (error) {
        if (error instanceof Error && error.message.includes("startup reconnect timed out")) {
          this.options.logWarn?.(
            `Source Server startup reconnect timeout diagnostic profile=${
              candidate.profile.profileId
            } transport=${candidate.target.kind} phase=${diagnosticPhase} elapsedMs=${Date.now() - startedAt}`,
            error,
          );
        }
        return {
          profileId: candidate.profile.profileId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (timer) clearTimeout(timer);
        releaseGlobal();
        releaseTransport?.();
      }
    };
    // 最近在线的 Source 对应用户最可能仍在使用的 workspace。首个候选独占启动窗口，
    // 避免和其余 Source 同时 probe/握手而在应用冷启动峰值中耗尽 10 秒预算；完成后其余
    // Source 再按全局 3 并发继续，不改变单 Source 超时和只尝试一次的合同。
    const [firstCandidate, ...remainingCandidates] = candidates;
    const firstResult = await reconnectCandidate(firstCandidate!);
    return [firstResult, ...(await Promise.all(remainingCandidates.map(reconnectCandidate)))];
  }

  public getOnlineConnection(sourceServerId: string): ManagedSourceServerConnection | undefined {
    return this.onlineBySourceServerId.get(sourceServerId);
  }

  public getFileTransfer(sourceServerId: string): SourceServerFileTransfer {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    const input = this.reconnectInputs.get(sourceServerId);
    if (!online || !input) throw new Error("Source Server file transfer is unavailable");
    const backend = this.getAdapter(input.profile.transport).createFileTransfer(input.target);
    const assertCurrent = () => {
      // 暂存属于当前 attachment generation；旧能力不能在重连后悄悄使用新线路或重建连接。
      if (this.onlineBySourceServerId.get(sourceServerId) !== online) {
        throw new Error("Source Server file transfer generation is unavailable");
      }
    };
    return {
      exec: async (command) => {
        assertCurrent();
        return backend.exec(command);
      },
      upload: async (localPath, remotePath, options) => {
        assertCurrent();
        await backend.upload(localPath, remotePath, options);
        assertCurrent();
      },
    };
  }

  public async updateServer(
    options: Parameters<SourceServerConnectionManager["updateServerOnce"]>[0],
  ): Promise<ManagedSourceServerConnection> {
    return this.operationLogs.run(
      "update",
      options.profile,
      options.target,
      options.context,
      (context) => this.updateServerOnce({ ...options, context }),
    );
  }

  private async updateServerOnce(options: {
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    force?: boolean;
    context?: TransportContext;
    release?: ServerReleaseAsset;
    resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  }): Promise<ManagedSourceServerConnection> {
    const sourceServerId = options.profile.sourceServerId;
    const previousState = this.getStateByProfile(options.profile.profileId);
    const previousCompatibility = preserveCompatibilityState(previousState);
    const controller = new AbortController();
    const flight = { profileId: options.profile.profileId, sourceServerId, controller };
    const context: TransportContext = {
      ...options.context,
      signal: options.context?.signal
        ? AbortSignal.any([options.context.signal, controller.signal])
        : controller.signal,
    };
    // Bug 原因：更新不在 connectFlights 中，断开后安装的迟到结果仍能重新发布连接。
    // 按操作身份登记，尚未握手的 Profile 也可取消；取消时先摘 owner，旧更新不再压住新连接的恢复。
    this.updateFlights.add(flight);
    if (sourceServerId) {
      this.clearRecoveryTimers(sourceServerId);
    }
    this.setState(options.profile.profileId, {
      state: "updating",
      ...(sourceServerId ? { sourceServerId } : {}),
      ...previousCompatibility,
    });
    let runningTasks: SourceServerRunningTask[] | undefined;
    try {
      context.signal?.throwIfAborted();
      const adapter = this.getAdapter(options.profile.transport);
      // Bug 原因：已握手分支曾改走远端 `zcode update`，但正常安装链没有配置远端 release
      // manifest URL，生产更新必然失败。所有 Profile 都由 Desktop 解析同一 archive 并经 Adapter 应用。
      const probe = await adapter.probe(options.target, context);
      context.signal?.throwIfAborted();
      const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
      const release =
        options.release ?? (releaseResolver ? await releaseResolver(probe, options.target) : null);
      context.signal?.throwIfAborted();
      if (!release) throw new Error("Source Server update release is unavailable");
      await adapter.installOrUpdate(options.target, release, context, {
        force: options.force === true,
      });
      context.signal?.throwIfAborted();
      const online = sourceServerId ? this.onlineBySourceServerId.get(sourceServerId) : undefined;
      if (sourceServerId && online) {
        this.invalidateOnlineConnectionForUpdate(sourceServerId, online);
      }
      // 失效事件的同步订阅者也可能提交断开，不能在该终态后进入 bootstrapping。
      context.signal?.throwIfAborted();
      // 重连事件由 connectOnce 的发布点统一 fire，这里不再重复发布。
      return await this.connectForSource(
        {
          profile: options.profile,
          target: options.target,
          context,
        },
        sourceServerId,
        false,
      );
    } catch (error) {
      // 终态由断开/删除/释放操作发布；旧更新的成功或失败都不能写回捕获的旧状态。
      controller.signal.throwIfAborted();
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "source-server-update-running-tasks"
      ) {
        // 清单走只读控制命令，不扩展持久化 status 格式，旧远端不支持时保持未知。
        try {
          const result = await this.getAdapter(options.profile.transport).exec(
            options.target,
            ["running-tasks", "--json"],
            context,
          );
          if (result.exitCode === 0) {
            const parsed = sourceServerRunningTasksSchema.safeParse(
              JSON.parse(result.stdout.trim()),
            );
            if (parsed.success) runningTasks = parsed.data;
          }
        } catch {
          /* 清单不可用不能绕过 force=false 的运行任务守卫。 */
        }
      }
      // running-tasks 读取同样会让出执行权，断开可能发生在错误收尾期间。
      controller.signal.throwIfAborted();
      const normalized = normalizeRemoteConnectionError(error);
      const errorCode = isPublicZCodeErrorCode(normalized.code) ? normalized.code : undefined;
      const retryable =
        error && typeof error === "object" && "retryable" in error
          ? (error as { retryable?: unknown }).retryable
          : undefined;
      if (sourceServerId && !this.onlineBySourceServerId.has(sourceServerId)) {
        // 更新期间 transport 已断开时不能恢复捕获的 online 快照，否则会产生无连接、无 timer 的假在线。
        if (this.reconnectInputs.has(sourceServerId)) {
          if (!this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)) {
            this.scheduleOnlineRetry(sourceServerId, 0);
          }
        } else {
          this.setState(options.profile.profileId, {
            state: "offline",
            sourceServerId,
            ...previousCompatibility,
            ...(runningTasks ? { runningTasks } : {}),
            ...(errorCode ? { errorCode } : {}),
            retryable: typeof retryable === "boolean" ? retryable : true,
            error: normalized.message,
          });
        }
      } else {
        this.setState(options.profile.profileId, {
          // 更新失败不是新的兼容性事实；真实连接仍在时恢复操作前状态。
          state: previousState.state === "absent" ? "failed" : previousState.state,
          ...(sourceServerId ? { sourceServerId } : {}),
          ...previousCompatibility,
          ...(runningTasks ? { runningTasks } : {}),
          ...(errorCode ? { errorCode } : {}),
          retryable: typeof retryable === "boolean" ? retryable : true,
          error: normalized.message,
        });
      }
      throw error;
    } finally {
      this.updateFlights.delete(flight);
    }
  }

  public disconnect(sourceServerId: string): void {
    this.disconnectSource(sourceServerId);
  }

  public removeProfile(profileId: string): void {
    this.operationLogs.removeProfile(profileId);
    const canceledUpdateSources = new Set<string>();
    for (const flight of this.updateFlights) {
      if (flight.profileId !== profileId) continue;
      if (flight.sourceServerId) canceledUpdateSources.add(flight.sourceServerId);
      this.updateFlights.delete(flight);
      flight.controller.abort(new SourceServerProfileRemovedError(profileId));
    }
    const connectingSourceServerId = this.connectFlights.get(profileId)?.sourceServerId;
    const sourceOwnedOnlyByConnectingProfile =
      connectingSourceServerId &&
      !this.reconnectInputs.has(connectingSourceServerId) &&
      !this.onlineBySourceServerId.has(connectingSourceServerId)
        ? connectingSourceServerId
        : undefined;
    const currentSourceServerId =
      [...this.reconnectInputs].find(([, input]) => input.profile.profileId === profileId)?.[0] ??
      [...this.onlineBySourceServerId].find(([, online]) => online.profileId === profileId)?.[0] ??
      sourceOwnedOnlyByConnectingProfile;
    if (currentSourceServerId) {
      // Bug 原因：Directory 删除当前线路后，旧实现只删展示状态，恢复 owner、timer 和
      // 已解析的 secret 仍存活，断线后会继续使用已删除线路。删除当前线路等价于显式
      // 断开整个 Source；其他线路只能由用户后续手动选择，不能在这里静默接管。
      this.disconnectSource(currentSourceServerId, profileId);
      return;
    }

    const flight = this.connectFlights.get(profileId);
    if (flight) {
      this.connectFlights.delete(profileId);
      flight.controller.abort(new SourceServerProfileRemovedError(profileId));
    }
    for (const online of this.onlineBySourceServerId.values()) {
      online.profileIds.delete(profileId);
    }
    this.states.delete(profileId);
    this.compatibilityByProfileId.delete(profileId);
    for (const [sourceServerId, profileIds] of this.profileIdsBySourceServerId) {
      if (!profileIds.delete(profileId)) continue;
      if (profileIds.size === 0) this.profileIdsBySourceServerId.delete(sourceServerId);
    }
    // Bug 原因：非当前线路的更新可能已移除旧物理连接；取消后跳过更新收尾，原 owner
    // 会永久停在 updating。删除操作接回仍保留的恢复意图，不依赖已取消更新的迟到结果。
    for (const sourceServerId of canceledUpdateSources) {
      const input = this.reconnectInputs.get(sourceServerId);
      if (
        input &&
        !this.onlineBySourceServerId.has(sourceServerId) &&
        this.getStateByProfile(input.profile.profileId).state === "updating" &&
        ![...this.updateFlights].some((flight) => flight.sourceServerId === sourceServerId)
      )
        this.scheduleOnlineRetry(sourceServerId, 0);
    }
  }

  private disconnectSource(sourceServerId: string, removedProfileId?: string): void {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    const reconnectInput = this.reconnectInputs.get(sourceServerId);
    const profileIds = new Set(this.profileIdsBySourceServerId.get(sourceServerId) ?? []);
    for (const profileId of online?.profileIds ?? []) profileIds.add(profileId);
    if (reconnectInput) profileIds.add(reconnectInput.profile.profileId);
    for (const flight of this.updateFlights) {
      if (flight.sourceServerId !== sourceServerId) continue;
      this.updateFlights.delete(flight);
      flight.controller.abort(new SourceServerExplicitDisconnectError(sourceServerId));
      profileIds.add(flight.profileId);
    }

    // Bug 原因：意外断线会先摘除 online owner；显式断开若再用 online 是否存在判断生命周期，
    // 就只会清掉 timer 而永久遗留 retrying。必须在删除恢复索引前捕获 Source 的全部 Profile，
    // 中止仍在执行的 Source flight，并且无论当前是否还有物理连接都发布 offline 终态；否则
    // 已进入 bootstrapping 的迟到成功还会覆盖用户刚刚提交的 offline 意图。
    this.clearRecoveryTimers(sourceServerId);
    for (const [profileId, flight] of this.connectFlights) {
      if (flight.sourceServerId !== sourceServerId) continue;
      if (this.connectFlights.get(profileId) === flight) {
        this.connectFlights.delete(profileId);
      }
      flight.controller.abort(
        profileId === removedProfileId
          ? new SourceServerProfileRemovedError(profileId)
          : new SourceServerExplicitDisconnectError(sourceServerId),
      );
      profileIds.add(profileId);
    }
    if (removedProfileId) profileIds.delete(removedProfileId);
    this.reconnectInputs.delete(sourceServerId);
    this.profileIdsBySourceServerId.delete(sourceServerId);
    if (online) this.onlineBySourceServerId.delete(sourceServerId);
    if (removedProfileId) {
      this.connectionInvalidatedEmitter.fire({
        sourceServerId,
        reason: "profile-removed",
        recoverable: false,
      });
    }
    online?.projectSubscription?.dispose();
    online?.connection.dispose();
    for (const profileId of profileIds) {
      this.setState(profileId, { state: "offline", sourceServerId });
    }
    if (removedProfileId) {
      this.states.delete(removedProfileId);
      this.compatibilityByProfileId.delete(removedProfileId);
    }
  }

  public dispose(): void {
    const reason = Object.assign(new Error("Source Server manager disposed"), {
      code: "remote-connection-canceled",
    });
    for (const flight of this.updateFlights) flight.controller.abort(reason);
    this.updateFlights.clear();
    // 更新的重握手可能尚无 online owner，不能只遍历 online 表来回收在途连接。
    for (const flight of this.connectFlights.values()) flight.controller.abort(reason);
    this.connectFlights.clear();
    for (const sourceServerId of this.retryTimers.keys()) this.clearRecoveryTimers(sourceServerId);
    for (const sourceServerId of this.offlineProbeTimers.keys())
      this.clearRecoveryTimers(sourceServerId);
    // 离线恢复也持有连接意图；只清 online 会让被中止 flight 的迟到 catch 重新排重试。
    for (const sourceServerId of new Set([
      ...this.reconnectInputs.keys(),
      ...this.onlineBySourceServerId.keys(),
    ])) {
      this.disconnect(sourceServerId);
    }
    for (const adapter of this.adapters.values()) adapter.dispose?.();
    this.adapters.clear();
    this.stateEmitter.dispose();
    this.reconnectEmitter.dispose();
    this.connectionInvalidatedEmitter.dispose();
    this.operationLogs.dispose();
  }

  private async connectOnce(
    options: ConnectSourceServerOptions,
    explicitDisconnectSignal?: AbortSignal,
  ): Promise<ManagedSourceServerConnection> {
    const { profile, target } = options;
    if (target.kind === "server" || profile.transport !== target.kind) {
      throw new Error(
        `Connection Profile ${profile.profileId} transport does not match target ${target.kind}`,
      );
    }
    const signal = options.context?.signal;
    let unpublishedConnection: ServerRemoteConnection | undefined;
    const throwIfAborted = () => {
      explicitDisconnectSignal?.throwIfAborted();
      signal?.throwIfAborted();
    };
    throwIfAborted();
    let commitMembership: ((sourceServerId: string) => Promise<void>) | undefined;
    if (this.options.admitConnection) {
      try {
        commitMembership = await this.options.admitConnection({
          profile,
          intent: options.membershipIntent ?? "retain",
          confirmIdentityChange: options.confirmIdentityChange === true,
        });
      } catch (error) {
        // 线路已移除时，迟到 admission 错误不再有权重建 failed 展示行。
        throwIfAborted();
        this.setState(profile.profileId, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
        throw error;
      }
    }
    throwIfAborted();
    if (profile.sourceServerId) {
      const existing = this.onlineBySourceServerId.get(profile.sourceServerId);
      if (existing) {
        await commitMembership?.(profile.sourceServerId);
        // 复用也经过异步成员提交；这段等待可能已被用户断开，不能返回旧 socket。
        throwIfAborted();
        if (this.onlineBySourceServerId.get(profile.sourceServerId) !== existing)
          throw new Error("Source Server connection changed during admission");
        existing.profileIds.add(profile.profileId);
        this.rememberSourceProfiles(profile.sourceServerId, existing.profileIds);
        this.setState(profile.profileId, {
          state: "online",
          sourceServerId: profile.sourceServerId,
        });
        return this.reusedConnection(existing);
      }
    }
    this.setState(profile.profileId, { state: "bootstrapping" });
    const adapter = this.getAdapter(profile.transport);
    let targetTransportCancelled = false;
    const cancelTargetTransport = () => {
      if (targetTransportCancelled) return;
      targetTransportCancelled = true;
      adapter.cancel?.(target);
    };
    if (signal?.aborted || explicitDisconnectSignal?.aborted) {
      cancelTargetTransport();
      throwIfAborted();
    }
    signal?.addEventListener("abort", cancelTargetTransport, { once: true });
    explicitDisconnectSignal?.addEventListener("abort", cancelTargetTransport, { once: true });
    let ignoreConnectionClose = false;
    try {
      options.onDiagnosticPhase?.("probe");
      const shouldRefreshDevelopmentArtifact =
        this.options.sourceServerArtifactPolicy === "development-content-addressed" &&
        target.kind === "ssh";
      const probe = await adapter.probe(
        target,
        options.context ?? {},
        shouldRefreshDevelopmentArtifact ? { includeReleaseIdentity: true } : undefined,
      );
      throwIfAborted();
      if (probe.installed) {
        const installedVersion = probe.installedVersion?.trim() || "unknown";
        let compatibleInstalledVersion = false;
        try {
          compatibleInstalledVersion =
            compareCompatibilityVersions(
              installedVersion,
              this.compatibilityManifest.minCompatibleVersion,
            ) >= 0;
        } catch {
          // Bug 原因：pre-R3 或损坏安装可能返回空值/unknown。继续执行新版本 ensureDaemon
          // 只会在 ingress-token 合同处变成通用 failed，用户也失去升级入口。
          compatibleInstalledVersion = false;
        }
        if (!compatibleInstalledVersion) {
          this.setState(profile.profileId, {
            state: "needs-upgrade",
            updateAvailability: "required",
            currentVersion: installedVersion,
            availableVersion: this.compatibilityManifest.productVersion,
            minimumVersion: this.compatibilityManifest.minCompatibleVersion,
            upgradeTarget: "server",
            errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
            retryable: false,
          });
          throw new SourceServerUpgradeRequiredError(
            profile.profileId,
            "server",
            installedVersion,
            this.compatibilityManifest.minCompatibleVersion,
          );
        }
        if (
          shouldRefreshDevelopmentArtifact &&
          installedVersion === this.compatibilityManifest.productVersion
        ) {
          const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
          if (!releaseResolver) {
            throw new Error("Development Source Server release is unavailable");
          }
          const release = await releaseResolver(probe, target);
          throwIfAborted();
          if (
            release.version === installedVersion &&
            release.sha256.toLowerCase() !== probe.installedArchiveSha256?.toLowerCase()
          ) {
            // Bug 原因（R3A-B-06）：开发态同版本刷新过去在这里直接 installOrUpdate，绕开了
            // updateServer 的 updating 状态、操作日志和 force 守卫确认；远端有运行中任务时 guard
            // 只能表现为普通连接失败，UI 既没有“强制更新”入口也不会在任务结束后重试。
            // 开发态与生产态只在“是否需要更新”的判定上不同（SHA vs 版本兼容），判定之后必须
            // 走同一条 needs-upgrade → updateSource/updateServer 链路，连接流程本身不执行更新。
            this.setState(profile.profileId, {
              state: "needs-upgrade",
              updateAvailability: "required",
              currentVersion: installedVersion,
              availableVersion: release.version,
              minimumVersion: this.compatibilityManifest.minCompatibleVersion,
              upgradeTarget: "server",
              errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
              retryable: false,
            });
            throw new SourceServerUpgradeRequiredError(
              profile.profileId,
              "server",
              installedVersion,
              this.compatibilityManifest.minCompatibleVersion,
              "development-archive",
            );
          }
        }
      }
      if (!probe.installed) {
        if (profile.sourceServerId) {
          await this.options.directory.markSourceUninstalled?.(profile.profileId);
          throwIfAborted();
        }
        const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
        const release =
          options.release ??
          (options.allowInstall && releaseResolver
            ? await releaseResolver(probe, target)
            : undefined);
        throwIfAborted();
        if (!release) {
          // 预览是附加信息；CDN/缓存元数据不可用时仍保留安装等待点。实际安装解析继续严格失败。
          const previewRelease = releaseResolver
            ? await releaseResolver(probe, target, { metadataOnly: true }).catch(() => undefined)
            : undefined;
          throwIfAborted();
          this.setState(profile.profileId, {
            ...(previewRelease
              ? {
                  installPreview: {
                    version: previewRelease.version,
                    sizeBytes: previewRelease.sizeBytes,
                    ...(probe.installPath ? { installPath: probe.installPath } : {}),
                  },
                }
              : {}),
            state: "needs-install",
            ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
            errorCode: SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
            retryable: false,
          });
          throw new SourceServerInstallRequiredError(profile.profileId);
        }
        await adapter.installOrUpdate(target, release, options.context ?? {});
        throwIfAborted();
      }
      options.onDiagnosticPhase?.("daemon");
      const ingress = await adapter.ensureDaemon(target, options.context ?? {}, {
        observedStatus: probe.daemonStatus,
      });
      throwIfAborted();
      let published: { sourceServerId: string; connection: ServerRemoteConnection } | undefined;
      let closedBeforePublish: string | undefined;
      options.onDiagnosticPhase?.("protocol-handshake");
      const connection = await this.connectServer({
        ingressToken: ingress.ingressToken,
        createConnection: async () =>
          await adapter.openChannel(target, ingress, options.context ?? {}),
        onClose: ({ reason }) => {
          if (ignoreConnectionClose) return;
          // Bug 原因（RV-P1-1）：close 事件过去只按 sourceServerId 路由，并用在线表是否存在做守卫。
          // 握手落盘（recordHandshake）期间连接关闭时，在线表要么为空（事件被丢弃，随后把已关闭的
          // 连接发布为 online），要么指向同一 Source 上另一条健康连接（sibling 的关闭会拆掉在线
          // owner 并清掉它的重试）。发布前只记录关闭事实，由发布点按连接失败收口；发布后才处理，
          // 且必须带上本连接身份，close 只作用于它所属的那条连接。
          if (!published) {
            closedBeforePublish = reason || "connection closed";
            return;
          }
          this.handleUnexpectedClose(published.sourceServerId, reason, published.connection);
        },
      });
      unpublishedConnection = connection;
      throwIfAborted();
      const compatibility = connection.serverInfo.compatibility;
      if (!compatibility) {
        this.setState(profile.profileId, {
          state: "needs-upgrade",
          updateAvailability: "required",
          currentVersion: connection.serverInfo.version,
          availableVersion: this.compatibilityManifest.productVersion,
          minimumVersion: this.compatibilityManifest.minCompatibleVersion,
          upgradeTarget: "server",
          errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerUpgradeRequiredError(
          profile.profileId,
          "server",
          connection.serverInfo.version,
          this.compatibilityManifest.minCompatibleVersion,
        );
      }
      const compatibilityResult = evaluateSourceServerCompatibility(
        this.compatibilityManifest,
        compatibility,
      );
      const compatibilityState = buildCompatibilityState(this.compatibilityManifest, compatibility);
      if (!compatibilityResult.compatible && compatibilityResult.upgradeTarget) {
        this.setState(profile.profileId, {
          state: "needs-upgrade",
          ...compatibilityState,
          errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerUpgradeRequiredError(
          profile.profileId,
          compatibilityResult.upgradeTarget,
          compatibilityResult.olderVersion,
          compatibilityResult.requiredMinimumVersion,
        );
      }
      const sourceServerId = connection.serverInfo.serverId;
      const connectedAt = this.now();
      options.onDiagnosticPhase?.("directory-record");
      const handshakeResult = await this.options.directory.recordHandshake(
        profile.profileId,
        {
          sourceServerId,
          osUser: connection.serverInfo.identity?.osUser,
          hostname: connection.serverInfo.identity?.hostname,
          version:
            connection.serverInfo.compatibility?.productVersion ?? connection.serverInfo.version,
          connectedAt,
          workspaces: connection.serverInfo.workspaces,
        },
        ...(options.confirmIdentityChange ? [{ confirmIdentityChange: true }] : []),
      );
      throwIfAborted();
      if (handshakeResult.identityChanged && options.confirmIdentityChange !== true) {
        this.setState(profile.profileId, {
          state: "identity-change-pending",
          sourceServerId: profile.sourceServerId,
          pendingSourceServerId: sourceServerId,
          errorCode: SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerIdentityChangePendingError(profile.profileId, sourceServerId);
      }
      const effectiveProfile = handshakeResult.effectiveProfile ?? profile;
      // 关闭发生于目录落盘时不能再提交成员；健康 sibling owner 可继续承接本次 admission。
      if (closedBeforePublish !== undefined && !this.onlineBySourceServerId.has(sourceServerId))
        throw new SourceServerHandshakeClosedError(closedBeforePublish);
      await commitMembership?.(sourceServerId);
      throwIfAborted();
      options.onDiagnosticPhase?.("publish-online");
      if (effectiveProfile.profileId !== profile.profileId) {
        this.setState(profile.profileId, {
          state: "offline",
          ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
        });
      }

      const existing = this.onlineBySourceServerId.get(sourceServerId);
      if (existing) {
        existing.profileIds.add(effectiveProfile.profileId);
        this.rememberSourceProfiles(sourceServerId, existing.profileIds);
        this.setState(effectiveProfile.profileId, {
          state: "online",
          sourceServerId,
          ...compatibilityState,
        });
        return this.reusedConnection(existing);
      }
      if (closedBeforePublish !== undefined) {
        // 握手期间连接已死：不能发布，按普通连接失败抛出，让手动连接显示可重试失败、
        // 自动恢复路径继续下一档重试。放在 sibling join 之后：owner 健康时 join 才是正确结果。
        throw new SourceServerHandshakeClosedError(closedBeforePublish);
      }
      const managed: OnlineConnection = {
        sourceServerId,
        profileId: effectiveProfile.profileId,
        serverInfo: connection.serverInfo,
        services: connection.services,
        connection,
        profileIds: new Set([effectiveProfile.profileId]),
      };
      if (this.options.onProjectChange) {
        managed.projectSubscription = connection.services.broadcastService.onMessage((event) => {
          // 换代/断开后迟到广播不能代表当前 Source；通知仅触发读取，不带项目数据。
          if (
            event.channel === "state:projects" &&
            this.onlineBySourceServerId.get(sourceServerId) === managed
          )
            this.options.onProjectChange?.(sourceServerId);
        });
      }
      // Bug 原因：onDidReconnect 过去只挂在 retry/probe timer 回调和 updateServer 上；
      // retrying/offline 期间由 connect()（connectProfile / confirmIdentityChange）手动连接成功，
      // Manager 会清掉待触发的 retry timer 并发布 online，却不发 reconnect。Host wrapper 只在
      // reconnect 时换 services，Registry entry 的 recoveryReady 因此无人 resolve，同 route 新
      // connect 永久等待。reconnectInputs 只在首次发布时写入、显式断开时删除，「再次发布同一
      // Source」就是唯一的重连事实源：无论谁触发的连接，非在线 -> 在线都在这里统一 fire。
      const isRepublish = this.reconnectInputs.has(sourceServerId);
      this.onlineBySourceServerId.set(sourceServerId, managed);
      published = { sourceServerId, connection };
      unpublishedConnection = undefined;
      this.rememberSourceProfiles(sourceServerId, managed.profileIds);
      this.clearRecoveryTimers(sourceServerId);
      this.reconnectInputs.set(sourceServerId, {
        profile: effectiveProfile,
        target,
        // 操作级 onLog 捕获本次日志及凭据；恢复不得持有旧闭包，下一次操作会重新建日志上下文。
        context: {},
      });
      this.setState(effectiveProfile.profileId, {
        state: "online",
        sourceServerId,
        ...compatibilityState,
      });
      if (isRepublish) this.reconnectEmitter.fire(managed);
      return managed;
    } catch (error) {
      if (
        error instanceof SourceServerUpgradeRequiredError &&
        !signal?.aborted &&
        !explicitDisconnectSignal?.aborted
      ) {
        await options.onAuthenticatedUpgradeRequired?.();
      }
      if (explicitDisconnectSignal?.aborted) {
        throw explicitDisconnectSignal.reason;
      }
      if (
        error instanceof SourceServerInstallRequiredError ||
        error instanceof SourceServerUpgradeRequiredError ||
        error instanceof SourceServerIdentityChangePendingError
      )
        throw error;
      const normalized = normalizeRemoteConnectionError(error);
      const errorCode = isPublicZCodeErrorCode(normalized.code) ? normalized.code : undefined;
      const retryable =
        error && typeof error === "object" && "retryable" in error
          ? (error as { retryable?: unknown }).retryable
          : undefined;
      this.setState(profile.profileId, {
        state: "failed",
        error: normalized.message,
        ...(errorCode ? { errorCode } : {}),
        ...(typeof retryable === "boolean" ? { retryable } : {}),
      });
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelTargetTransport);
      explicitDisconnectSignal?.removeEventListener("abort", cancelTargetTransport);
      // Bug 原因：分支内释放遗漏了握手落盘拒绝和兼容版本解析异常，恢复重试会累积连接。
      // 握手、目录写入、身份确认、成员提交共用这一个未发布资源出口；在线表接管前始终由本次
      // 尝试持有连接，统一释放并忽略其关闭事件，避免影响后继 owner。
      if (unpublishedConnection) {
        ignoreConnectionClose = true;
        unpublishedConnection.dispose();
      }
    }
  }

  private getAdapter(kind: "ssh" | "wsl" | "docker"): SourceServerTransportAdapter {
    let adapter = this.adapters.get(kind);
    if (!adapter) {
      adapter = this.createAdapter(kind);
      this.adapters.set(kind, adapter);
    }
    return adapter;
  }

  private handleUnexpectedClose(
    sourceServerId: string,
    reason: string,
    connection: ServerRemoteConnection,
  ): void {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    // 只处理属于当前 online owner 的关闭；已被替换或从未发布的连接迟到的 close 不得拆掉后继者。
    if (!online || online.connection !== connection) return;
    if ([...this.updateFlights].some((flight) => flight.sourceServerId === sourceServerId)) {
      this.invalidateOnlineConnectionForUpdate(sourceServerId, online);
      return;
    }
    this.onlineBySourceServerId.delete(sourceServerId);
    // Bug 原因：意外断线后旧 RPC generation 只从在线表移除，却没有显式释放 protocol/socket；
    // 多次重连会让旧 generation 的 pending 状态依赖 GC。先摘 owner 再 dispose，重复 close 回调会
    // 因 online 表已无该 Source 而幂等返回。
    online.projectSubscription?.dispose();
    online.connection.dispose();
    for (const profileId of online.profileIds) {
      this.setState(profileId, {
        state: "retrying",
        sourceServerId,
        ...(reason ? { error: reason } : {}),
        recoveryAttempt: 1,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
      });
    }
    this.scheduleOnlineRetry(sourceServerId, 0);
  }

  private invalidateOnlineConnectionForUpdate(
    sourceServerId: string,
    online: OnlineConnection,
  ): void {
    if (this.onlineBySourceServerId.get(sourceServerId) !== online) return;
    // Bug 原因：显式更新过去只替换 Manager 内的物理连接，没有先失效仍指向旧 services 的
    // logical workspace；更新成功后 UI 会看到 online，但 scoped RPC 仍命中已关闭 generation。
    // 先摘物理 owner 并发布一次 Source 级失效，再释放连接，Registry 才能 fail-closed 后换代。
    this.onlineBySourceServerId.delete(sourceServerId);
    for (const profileId of online.profileIds) {
      this.setState(profileId, { state: "updating", sourceServerId });
    }
    this.connectionInvalidatedEmitter.fire({
      sourceServerId,
      reason: "update",
    });
    online.projectSubscription?.dispose();
    online.connection.dispose();
  }

  private scheduleOnlineRetry(sourceServerId: string, attempt: number): void {
    const input = this.reconnectInputs.get(sourceServerId);
    const delay = ONLINE_RETRY_DELAYS_MS[attempt];
    if (!input || delay === undefined) {
      this.enterOfflineProbe(sourceServerId);
      return;
    }
    const existing = this.retryTimers.get(sourceServerId);
    if (existing) clearTimeout(existing);
    for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
      this.setState(profileId, {
        state: "retrying",
        sourceServerId,
        recoveryAttempt: attempt + 1,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
      });
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(sourceServerId);
      void this.connectForSource(
        {
          profile: input.profile,
          target: input.target,
          context: input.context,
        },
        sourceServerId,
      ).catch((error) => {
        if (
          error instanceof SourceServerExplicitDisconnectError ||
          error instanceof SourceServerProfileRemovedError ||
          this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)
        ) {
          return;
        }
        if (attempt + 1 < ONLINE_RETRY_DELAYS_MS.length) {
          this.scheduleOnlineRetry(sourceServerId, attempt + 1);
        } else {
          this.enterOfflineProbe(sourceServerId, error);
        }
      });
    }, delay);
    this.retryTimers.set(sourceServerId, timer);
  }

  private enterOfflineProbe(sourceServerId: string, error?: unknown): void {
    const input = this.reconnectInputs.get(sourceServerId);
    if (!input) return;
    const normalized = error === undefined ? undefined : normalizeRemoteConnectionError(error);
    if (normalized) {
      // Bug 原因：预算耗尽后的最终 cause 只留在 state.error，而 UI 按合同不展示裸 Host
      // 原文，导致诊断信息无稳定出口。终态每轮只记一条 warn，不按探测心跳刷盘。
      this.options.logWarn?.(
        `[source-server] recovery budget exhausted source=${sourceServerId}`,
        error instanceof Error ? error : new Error(normalized.message),
      );
    }
    const errorCode =
      normalized?.code &&
      normalized.code !== "remote-connection-unknown" &&
      isPublicZCodeErrorCode(normalized.code)
        ? normalized.code
        : REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE;
    for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
      this.setState(profileId, {
        state: "offline",
        sourceServerId,
        recoveryAttempt: ONLINE_RETRY_DELAYS_MS.length,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
        recoveryBudgetExhausted: true,
        retryable: true,
        ...(normalized ? { error: normalized.message } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    }
    const existing = this.offlineProbeTimers.get(sourceServerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.offlineProbeTimers.delete(sourceServerId);
      void this.connectForSource(
        {
          profile: input.profile,
          target: input.target,
          context: input.context,
        },
        sourceServerId,
      ).catch((error) => {
        if (
          error instanceof SourceServerExplicitDisconnectError ||
          error instanceof SourceServerProfileRemovedError ||
          this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)
        ) {
          return;
        }
        this.enterOfflineProbe(sourceServerId, error);
      });
    }, OFFLINE_PROBE_INTERVAL_MS);
    this.offlineProbeTimers.set(sourceServerId, timer);
  }

  private stopAutomaticRecoveryForTerminalFailure(sourceServerId: string, error: unknown): boolean {
    const input = this.reconnectInputs.get(sourceServerId);
    const ownerState = input ? this.states.get(input.profile.profileId) : undefined;
    const normalized = normalizeRemoteConnectionError(error);
    if (
      readErrorRetryable(error) !== false &&
      !isAutomaticRecoveryUserActionCode(normalized.code) &&
      !isSourceServerAutomaticRecoveryTerminalState(ownerState)
    ) {
      return false;
    }
    // Bug 原因：旧恢复调度只识别 UpgradeRequired，其他用户动作和 retryable:false
    // 会被下一次 retry/offline probe 覆盖。终态必须在创建后续 timer 前截断自动路径。
    this.clearRecoveryTimers(sourceServerId);
    if (input && !isSourceServerAutomaticRecoveryTerminalState(ownerState)) {
      this.setState(input.profile.profileId, {
        state: "failed",
        sourceServerId,
        ...this.compatibilityByProfileId.get(input.profile.profileId),
        error: normalized.message,
        ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
        retryable: false,
      });
    }
    if (input) {
      for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
        if (profileId === input.profile.profileId) continue;
        // Bug 原因：Source 级恢复停止后，sibling Profile 若遗留 retrying，聚合状态仍会显示
        // 连接中且其 logical wrapper 不会收到终态。只有真实 owner 保留可操作 pending 状态。
        this.setState(profileId, {
          state: "offline",
          sourceServerId,
          error: normalized.message,
          ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
          retryable: false,
        });
      }
    }
    return true;
  }

  private profileIdsForSource(sourceServerId: string, fallbackProfileId: string): string[] {
    const remembered = this.profileIdsBySourceServerId.get(sourceServerId);
    return remembered && remembered.size > 0 ? [...remembered] : [fallbackProfileId];
  }

  private rememberSourceProfiles(sourceServerId: string, profileIds: Iterable<string>): void {
    const remembered = this.profileIdsBySourceServerId.get(sourceServerId) ?? new Set<string>();
    for (const profileId of profileIds) remembered.add(profileId);
    this.profileIdsBySourceServerId.set(sourceServerId, remembered);
  }

  private clearRecoveryTimers(sourceServerId: string): void {
    const retryTimer = this.retryTimers.get(sourceServerId);
    if (retryTimer) clearTimeout(retryTimer);
    this.retryTimers.delete(sourceServerId);
    const probeTimer = this.offlineProbeTimers.get(sourceServerId);
    if (probeTimer) clearTimeout(probeTimer);
    this.offlineProbeTimers.delete(sourceServerId);
  }

  private setState(
    profileId: string,
    patch: Omit<SourceServerConnectionStateSnapshot, "profileId" | "updatedAt">,
  ): void {
    const previous = this.states.get(profileId);
    const inheritedCompatibility =
      patch.state === "retrying" || patch.state === "offline" || patch.state === "updating"
        ? (this.compatibilityByProfileId.get(profileId) ??
          (previous ? preserveCompatibilityState(previous) : {}))
        : {};
    const snapshot: SourceServerConnectionStateSnapshot = {
      profileId,
      // 恢复/离线/更新是连接生命周期状态，不会产生新的版本兼容事实；保留最后一次
      // Host 握手判定，避免 UI 在状态跃迁时丢失当前/可用/最低版本字段。
      ...inheritedCompatibility,
      ...patch,
      updatedAt: this.now(),
    };
    if (snapshot.currentVersion || snapshot.updateAvailability) {
      this.compatibilityByProfileId.set(profileId, preserveCompatibilityState(snapshot));
    }
    this.states.set(profileId, snapshot);
    if (previous?.state === "online" && snapshot.state !== "online" && previous.sourceServerId) {
      // 最近在线是最后在线时刻，不是握手开始时间；失败重试不能把离线设备伪装成刚在线。
      void this.options.directory
        .recordLastOnline?.(previous.sourceServerId, snapshot.updatedAt)
        .catch((error: unknown) =>
          this.options.logWarn?.(
            "Failed to persist Source Server last online time",
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
    }
    this.stateEmitter.fire(snapshot);
  }
}
