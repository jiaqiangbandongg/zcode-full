/* eslint-disable max-lines -- Source/Profile/Workspace 三实体迁移与凭据重定向需要保持同一事务编排。 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import {
  buildServerRemoteWorkspaceIdentity,
  isValidWslUser,
  parseRemoteWorkspaceIdentity,
  type AppSettings,
  type ConnectionProfile,
  type DockerProfileTarget,
  type SourceServerRecord,
  type SourceServerWorkspaceHistoryEntry,
  type SSHProfileTarget,
  type WSLProfileTarget,
  type RemoteWorkspaceSessionEntry,
  type RemoteTarget,
  type SourceServerDeclaredWorkspaceWire,
} from "@zcode/shared";
import type {
  ICredentialService,
  ISettingService,
  UpdateConnectionProfileInput,
} from "@zcode/services";
import {
  getDataBaseDir,
  migrateControllerRemoteWorkspaceIdentity,
  type ControllerRemoteIdentityMigrationReport,
} from "@zcode/services/node";

export interface SourceServerDirectoryOptions {
  settingService: ISettingService;
  credentialService: ICredentialService;
  createProfileId?: () => string;
  now?: () => number;
  migrateControllerIdentity?: (input: {
    oldWorkspaceKey: string;
    newWorkspaceKey: string;
  }) => Promise<ControllerRemoteIdentityMigrationReport>;
  /** 远端 identity 被 canonical 覆盖等非错误诊断信息；生产环境应注入 no-op。 */
  logDebug?: (message: string) => void;
}

export interface SourceServerHandshakeRecord {
  sourceServerId: string;
  osUser?: string;
  hostname?: string;
  version: string;
  connectedAt?: number;
  workspaces?: readonly SourceServerDeclaredWorkspaceWire[];
}

export interface SourceServerHandshakeResult {
  identityChanged: boolean;
  migrationFailures: string[];
  effectiveProfileId: string;
  effectiveProfile: ConnectionProfile;
}

function isActiveProfile(profile: ConnectionProfile): boolean {
  return profile.lifecycleState !== "retired";
}

function resolveDefaultSourceDisplayName(
  profile: ConnectionProfile,
  handshake: SourceServerHandshakeRecord,
): string {
  // Bug 原因：SSH alias 已持久化在线路 Profile 中，但设备首次握手只用 hostname/osUser 生成名称，
  // 导致用户精心维护的可读 alias 被随机容器 hostname 覆盖。alias 只作为首次展示默认值，
  // 已存在设备仍由调用方优先保留 displayName，且这里不参与任何 identity 计算。
  const sshAlias =
    profile.target.kind === "ssh" ? profile.target.sshConfigAlias?.trim() : undefined;
  return (
    sshAlias ||
    [handshake.hostname, handshake.osUser]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" · ") ||
    handshake.sourceServerId
  );
}

export interface SourceServerDirectorySnapshot {
  profiles: ConnectionProfile[];
  servers: SourceServerRecord[];
  workspaceHistory: SourceServerWorkspaceHistoryEntry[];
}

export interface SourceServerReconnectCandidate {
  profile: ConnectionProfile;
  target: Exclude<RemoteTarget, { kind: "server" }>;
}

type LegacySourceWorkspaceEntry = RemoteWorkspaceSessionEntry & {
  target: Exclude<RemoteWorkspaceSessionEntry["target"], { kind: "server" }>;
};

function routeKey(
  entry: Extract<NonNullable<AppSettings["lastWorkspaceSession"]>[number], { kind: "remote" }>,
): string | null {
  const target = entry.target;
  switch (target.kind) {
    case "ssh":
      return [
        "ssh",
        target.host.trim().toLowerCase(),
        String(target.port ?? 22),
        target.username.trim(),
        target.privateKeyPath?.trim() ?? "",
      ].join("\u0000");
    case "wsl":
      return [
        "wsl",
        target.distro?.trim().toLowerCase() ?? "default",
        target.user?.trim().toLowerCase() ?? "",
      ].join("\u0000");
    case "docker":
      return ["docker", target.container.trim()].join("\u0000");
    case "server":
      return null;
  }
}

function profileTargetIdentityKey(
  target: SSHProfileTarget | WSLProfileTarget | DockerProfileTarget,
): string {
  switch (target.kind) {
    case "ssh":
      // assetInstallMode、alias 和 resourcePackages 只影响部署/展示，不是连接身份。
      return JSON.stringify({
        kind: "ssh",
        host: target.host.trim().toLowerCase(),
        port: target.port ?? 22,
        username: target.username.trim(),
        privateKeyPath: target.privateKeyPath?.trim() ?? "",
      });
    case "wsl":
      return JSON.stringify({
        kind: "wsl",
        distro: target.distro?.trim() ?? "",
        user: target.user?.trim() ?? "",
      });
    case "docker":
      return JSON.stringify({ kind: "docker", container: target.container.trim() });
  }
}

function newCredentialKey(profileId: string, kind: "password" | "private-key-passphrase"): string {
  return `connection-profile:${profileId}:${kind}`;
}

export class SourceServerDirectory {
  private readonly createProfileId: () => string;
  private readonly now: () => number;
  private initializePromise: Promise<void> | null = null;
  private writeChain = Promise.resolve();
  private readonly changeEmitter = new Emitter<void>();
  /** 当前 enqueue 操作内是否发生过成功的持久化写入；enqueue 串行执行，实例字段无并发窗口。 */
  private didPersistInCurrentOperation = false;
  private readonly migrateControllerIdentity: NonNullable<
    SourceServerDirectoryOptions["migrateControllerIdentity"]
  >;

  public constructor(private readonly options: SourceServerDirectoryOptions) {
    this.createProfileId = options.createProfileId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.migrateControllerIdentity =
      options.migrateControllerIdentity ??
      (async (input) =>
        await migrateControllerRemoteWorkspaceIdentity({
          dbPath: join(getDataBaseDir(), ".zcode", "v2", "tasks-index.sqlite"),
          ...input,
        }));
  }

  /** 目录持久化成功后的统一变更通知，管理服务负责将其映射为 generation。 */
  public readonly onDidChange: Event<void> = this.changeEmitter.event;

  public async initialize(): Promise<void> {
    if (!this.initializePromise) {
      const flight = this.enqueue(async () => {
        let settings = await this.options.settingService.get();
        if (settings.sourceServerDirectoryMigrationVersion !== 1) {
          await this.migrateLegacyRemoteEntries(settings);
          settings = await this.options.settingService.get();
        }
        await this.repairDanglingProfileCredentials(settings);
      });
      this.initializePromise = flight;
    }
    const flight = this.initializePromise;
    try {
      await flight;
    } catch (error) {
      // Bug 原因：失败 flight 若永久缓存，临时 settings/credential IO 故障会让本 Host
      // 生命周期内所有 Source Server 操作持续复用同一个 rejected promise。
      if (this.initializePromise === flight) this.initializePromise = null;
      throw error;
    }
  }

  public async snapshot(): Promise<SourceServerDirectorySnapshot> {
    await this.initialize();
    const settings = await this.options.settingService.get();
    return {
      profiles: [...(settings.connectionProfiles ?? [])],
      servers: [...(settings.sourceServers ?? [])],
      workspaceHistory: [...(settings.sourceServerWorkspaceHistory ?? [])],
    };
  }

  public async resolveLegacyWorkspaceIdentity(input: {
    profileId: string;
    workspacePath: string;
    fallback: string;
  }): Promise<string> {
    await this.initialize();
    const settings = await this.options.settingService.get();
    const historical = (settings.sourceServerWorkspaceHistory ?? []).find(
      (entry) => entry.profileId === input.profileId && entry.workspacePath === input.workspacePath,
    )?.legacyWorkspaceIdentity;
    // Bug 原因：Renderer stable identity 曾覆盖当前 route hint，导致旧 alias 行丢失时无法命中
    // 更精确的历史 key。legacy hint 的优先级属于 Host Directory 权威，不允许 UI 决定。
    return historical?.trim() || input.fallback;
  }

  public async ensureProfile(
    target: Exclude<RemoteTarget, { kind: "server" }>,
    options: { deferCredentials?: boolean } = {},
  ): Promise<ConnectionProfile> {
    await this.initialize();
    return await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const normalizedTarget = this.profileTargetFromRemote(target);
      const targetKey = profileTargetIdentityKey(normalizedTarget);
      const existing = (settings.connectionProfiles ?? []).find(
        (profile) =>
          isActiveProfile(profile) &&
          profile.transport === target.kind &&
          profileTargetIdentityKey(profile.target) === targetKey,
      );
      // 连接结果尚未确定时不能覆盖凭据；在线 Source 可能完全跳过本次认证。
      if (existing && options.deferCredentials) return existing;
      if (existing) {
        const credentialMutation = await this.persistProfileCredentials(
          existing.profileId,
          target,
          existing.target,
        );
        const nextTarget =
          normalizedTarget.kind === "ssh" && credentialMutation.target.kind === "ssh"
            ? {
                ...normalizedTarget,
                ...(credentialMutation.target.passwordCredentialKey
                  ? {
                      passwordCredentialKey: credentialMutation.target.passwordCredentialKey,
                    }
                  : {}),
                ...(normalizedTarget.privateKeyPath &&
                credentialMutation.target.privateKeyPassphraseCredentialKey
                  ? {
                      privateKeyPassphraseCredentialKey:
                        credentialMutation.target.privateKeyPassphraseCredentialKey,
                    }
                  : {}),
              }
            : credentialMutation.target;
        if (JSON.stringify(nextTarget) === JSON.stringify(existing.target)) {
          return existing;
        }
        const updated = {
          ...existing,
          target: nextTarget,
        } as ConnectionProfile;
        try {
          await this.persistSettings({
            connectionProfiles: (settings.connectionProfiles ?? []).map((profile) =>
              profile.profileId === existing.profileId ? updated : profile,
            ),
          });
          return updated;
        } catch (error) {
          await credentialMutation.rollback();
          throw error;
        }
      }
      const profileId = this.createProfileId();
      const credentialMutation = options.deferCredentials
        ? { target: normalizedTarget, rollback: async () => undefined }
        : await this.persistProfileCredentials(profileId, target, normalizedTarget);
      const profile = {
        profileId,
        transport: target.kind,
        target: credentialMutation.target,
        displayName:
          normalizedTarget.kind === "ssh"
            ? (normalizedTarget.sshConfigAlias ?? normalizedTarget.host)
            : normalizedTarget.kind === "wsl"
              ? (normalizedTarget.distro ?? "WSL")
              : normalizedTarget.container,
        createdAt: this.now(),
      } as ConnectionProfile;
      try {
        await this.persistSettings({
          connectionProfiles: [...(settings.connectionProfiles ?? []), profile],
        });
        return profile;
      } catch (error) {
        await credentialMutation.rollback();
        throw error;
      }
    });
  }

  public async listStartupReconnectCandidates(): Promise<SourceServerReconnectCandidate[]> {
    const snapshot = await this.snapshot();
    const candidates: SourceServerReconnectCandidate[] = [];
    // Bug 原因：Directory 数组按 Source 首次发现顺序持久化。冷启动 worker 有并发上限时，
    // 旧 Source 会先占满槽位，最近活动 workspace 的 Source 反而可能排到后面并超时。
    // 候选队列以最近在线事实排序；单个 Source 内仍由 preferred Profile 决定连接路由。
    // 保存的连接不因七天未使用失去启动重连资格；凭据和全局关闭开关继续由原入口守卫。
    const serversByRecentActivity = [...snapshot.servers].sort(
      (left, right) => (right.lastOnlineAt ?? 0) - (left.lastOnlineAt ?? 0),
    );
    for (const server of serversByRecentActivity) {
      const profiles = snapshot.profiles
        .filter(
          (profile) => isActiveProfile(profile) && profile.sourceServerId === server.sourceServerId,
        )
        .sort((left, right) => {
          if (left.profileId === server.preferredProfileId) return -1;
          if (right.profileId === server.preferredProfileId) return 1;
          return (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0);
        });
      for (const profile of profiles) {
        const target = await this.resolveSilentTarget(profile);
        if (!target) continue;
        candidates.push({ profile, target });
        break;
      }
    }
    // 首次握手失败的已保存 Profile 仍是有效连接；是否保留由 Host 的 SQLite 成员表筛选。
    for (const profile of snapshot.profiles) {
      if (!isActiveProfile(profile) || profile.sourceServerId) continue;
      const target = await this.resolveSilentTarget(profile);
      if (target) candidates.push({ profile, target });
    }
    return candidates;
  }

  public async recordLastOnline(sourceServerId: string, timestamp: number): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const server = settings.sourceServers?.find(
        (entry) => entry.sourceServerId === sourceServerId,
      );
      // 断线事件可能晚于重连握手或删除；只推进已存在设备的时间，不能倒退或复活记录。
      if (!server || timestamp <= (server.lastOnlineAt ?? 0)) return;
      await this.persistSettings({
        sourceServers: settings.sourceServers!.map((entry) =>
          entry === server ? { ...entry, lastOnlineAt: timestamp } : entry,
        ),
      });
    });
  }

  public async recordHandshake(
    profileId: string,
    handshake: SourceServerHandshakeRecord,
    options: { confirmIdentityChange?: boolean } = {},
  ): Promise<SourceServerHandshakeResult> {
    await this.initialize();
    return await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = [...(settings.connectionProfiles ?? [])];
      const profileIndex = profiles.findIndex((profile) => profile.profileId === profileId);
      if (profileIndex < 0) throw new Error(`Unknown Connection Profile: ${profileId}`);
      const connectedAt = handshake.connectedAt ?? this.now();
      const currentProfile = profiles[profileIndex]!;
      if (!isActiveProfile(currentProfile)) {
        throw new Error(`Connection Profile is retired: ${profileId}`);
      }
      const previousSourceServerId = currentProfile.sourceServerId;
      const identityChanged =
        Boolean(previousSourceServerId) && previousSourceServerId !== handshake.sourceServerId;
      if (identityChanged && options.confirmIdentityChange !== true) {
        // Bug 根因：旧实现先改绑 Profile/history，再把 identityChanged 返回给上层，用户确认
        // 已经来不及。pending 阶段必须严格零写入。
        return {
          identityChanged: true,
          migrationFailures: [],
          effectiveProfileId: profileId,
          effectiveProfile: currentProfile,
        };
      }
      if (identityChanged) {
        return await this.commitIdentityReplacement({
          settings,
          currentProfile,
          handshake,
          connectedAt,
        });
      }
      profiles[profileIndex] = {
        ...currentProfile,
        sourceServerId: handshake.sourceServerId,
        lastConnectedAt: connectedAt,
        lastConnectError: undefined,
        lifecycleState: "active",
      } as ConnectionProfile;

      const servers = [...(settings.sourceServers ?? [])];
      const serverIndex = servers.findIndex(
        (server) => server.sourceServerId === handshake.sourceServerId,
      );
      const defaultDisplayName = resolveDefaultSourceDisplayName(currentProfile, handshake);
      const previousServer = serverIndex >= 0 ? servers[serverIndex] : undefined;
      const nextServer: SourceServerRecord = {
        sourceServerId: handshake.sourceServerId,
        displayName: previousServer?.displayName ?? defaultDisplayName,
        ...(handshake.osUser ? { osUser: handshake.osUser } : {}),
        ...(handshake.hostname ? { hostname: handshake.hostname } : {}),
        lastSeenVersion: handshake.version,
        lastOnlineAt: connectedAt,
        preferredProfileId: previousServer?.preferredProfileId ?? profileId,
        installState: "installed",
        declaredWorkspaces: projectDeclaredWorkspaces(
          handshake.sourceServerId,
          handshake.workspaces ?? [],
          this.options.logDebug,
        ),
      };
      if (serverIndex >= 0) servers[serverIndex] = nextServer;
      else servers.push(nextServer);

      const workspaceHistory = (settings.sourceServerWorkspaceHistory ?? []).map((entry) =>
        entry.profileId === profileId
          ? {
              ...entry,
              sourceServerId: handshake.sourceServerId,
              workspaceIdentity: buildServerRemoteWorkspaceIdentity({
                serverId: handshake.sourceServerId,
                workspacePath: entry.workspacePath,
              }),
            }
          : entry,
      );
      const migrationFailures: string[] = [];
      for (const entry of workspaceHistory) {
        if (
          entry.profileId !== profileId ||
          !entry.legacyWorkspaceIdentity ||
          !entry.workspaceIdentity ||
          entry.legacyWorkspaceIdentity === entry.workspaceIdentity
        ) {
          continue;
        }
        const report = await this.migrateControllerIdentity({
          oldWorkspaceKey: entry.legacyWorkspaceIdentity,
          newWorkspaceKey: entry.workspaceIdentity,
        });
        if (report.status === "failed") {
          migrationFailures.push(report.error ?? entry.workspacePath);
        }
      }
      await this.persistSettings({
        connectionProfiles: profiles,
        sourceServers: servers,
        sourceServerWorkspaceHistory: workspaceHistory,
      });
      return {
        identityChanged: false,
        migrationFailures,
        effectiveProfileId: profileId,
        effectiveProfile: profiles[profileIndex]!,
      };
    });
  }

  public async recordWorkspaceOpen(input: {
    profileId: string;
    sourceServerId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: "project" | "conversation";
    legacyWorkspaceIdentity?: string;
    openedAt?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    input.signal?.throwIfAborted();
    if (input.workspacePurpose === "conversation") {
      // conversation backing workspace 只属于设备级 canonical path，不得污染 strict project history。
      return;
    }
    await this.initialize();
    input.signal?.throwIfAborted();
    await this.enqueue(async () => {
      input.signal?.throwIfAborted();
      const settings = await this.options.settingService.get();
      input.signal?.throwIfAborted();
      const history = [...(settings.sourceServerWorkspaceHistory ?? [])];
      const index = history.findIndex(
        (entry) =>
          entry.sourceServerId === input.sourceServerId &&
          entry.workspacePath === input.workspacePath,
      );
      const existing = index >= 0 ? history[index] : undefined;
      const legacyWorkspaceIdentity =
        input.legacyWorkspaceIdentity?.trim() || existing?.legacyWorkspaceIdentity?.trim();
      const next: SourceServerWorkspaceHistoryEntry = {
        workspacePath: input.workspacePath,
        workspaceIdentity: input.workspaceIdentity,
        // Bug 原因：stable identity 重连不会再次携带 route hint；整行覆盖会抹掉冻结的
        // legacy identity，下一次启动无法投影 stable key，也读不到 Profile 密码。
        ...(legacyWorkspaceIdentity ? { legacyWorkspaceIdentity } : {}),
        profileId: input.profileId,
        sourceServerId: input.sourceServerId,
        lastOpenedAt: input.openedAt ?? this.now(),
      };
      if (index >= 0) history[index] = next;
      else history.push(next);
      // 同一 JS turn 内从最后一次 abort 检查直接发起持久化，不再引入 await 窗口；取消
      // 若发生在前一段异步读取期间，会在这里阻止任何 workspace history 写入。
      input.signal?.throwIfAborted();
      await this.persistSettings({
        sourceServerWorkspaceHistory: history,
      });
    });
  }

  public async recordConversationWorkspace(
    sourceServerId: string,
    workspacePath: string,
  ): Promise<void> {
    const normalizedPath = workspacePath.trim();
    if (!sourceServerId.trim() || !normalizedPath) {
      throw new Error("Source conversation workspace requires sourceServerId and workspacePath");
    }
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const current = settings.remoteConversationWorkspaceBySourceServerId ?? {};
      // Bug 原因：旧流程可能先把 backing path 当普通 project 写入 strict history。
      // canonical conversation 一旦确认，必须在同一 Directory 写事务中清掉同 Source/path
      // 的污染项；其它设备的同路径与同设备真实项目都保留。
      const projectHistory = (settings.sourceServerWorkspaceHistory ?? []).filter(
        (entry) =>
          entry.sourceServerId !== sourceServerId || entry.workspacePath !== normalizedPath,
      );
      await this.persistSettings({
        remoteConversationWorkspaceBySourceServerId: {
          ...current,
          [sourceServerId]: {
            workspacePath: normalizedPath,
            lastResolvedAt: this.now(),
          },
        },
        sourceServerWorkspaceHistory: projectHistory,
      });
    });
  }

  public async renameSource(sourceServerId: string, displayName: string): Promise<void> {
    await this.initialize();
    const normalized = displayName.trim();
    if (!normalized) throw new Error("Source Server display name is required");
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const servers = [...(settings.sourceServers ?? [])];
      const index = servers.findIndex((server) => server.sourceServerId === sourceServerId);
      if (index < 0) throw new Error(`Unknown Source Server: ${sourceServerId}`);
      servers[index] = { ...servers[index]!, displayName: normalized };
      await this.persistSettings({ sourceServers: servers });
    });
  }

  public async renameProfile(profileId: string, displayName: string): Promise<void> {
    await this.initialize();
    const normalized = displayName.trim();
    if (!normalized) throw new Error("Connection Profile display name is required");
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = [...(settings.connectionProfiles ?? [])];
      const index = profiles.findIndex((profile) => profile.profileId === profileId);
      if (index < 0) throw new Error(`Unknown Connection Profile: ${profileId}`);
      profiles[index] = {
        ...profiles[index]!,
        displayName: normalized,
      } as ConnectionProfile;
      await this.persistSettings({
        connectionProfiles: profiles,
      });
    });
  }

  public async updateProfile(input: UpdateConnectionProfileInput): Promise<void> {
    await this.initialize();
    const profileDisplayName = input.profileDisplayName.trim();
    const sourceDisplayName = input.sourceDisplayName?.trim();
    if (!profileDisplayName) {
      throw new Error("Connection Profile display name is required");
    }
    if (input.sourceDisplayName !== undefined && !sourceDisplayName) {
      throw new Error("Source Server display name is required");
    }

    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = [...(settings.connectionProfiles ?? [])];
      const profileIndex = profiles.findIndex((profile) => profile.profileId === input.profileId);
      if (profileIndex < 0) {
        throw new Error(`Unknown Connection Profile: ${input.profileId}`);
      }
      const currentProfile = profiles[profileIndex]!;
      if (!isActiveProfile(currentProfile)) {
        throw new Error(`Connection Profile is retired: ${input.profileId}`);
      }
      if (currentProfile.transport !== input.target.kind) {
        throw new Error("Connection Profile transport cannot be changed");
      }

      const normalizedTarget = this.profileTargetFromRemote(input.target);
      if (
        normalizedTarget.kind === "ssh" &&
        (!normalizedTarget.host ||
          !normalizedTarget.username ||
          normalizedTarget.port === undefined ||
          !Number.isInteger(normalizedTarget.port) ||
          normalizedTarget.port <= 0 ||
          normalizedTarget.port > 65_535)
      ) {
        throw new Error("SSH connection details are invalid");
      }
      if (
        normalizedTarget.kind === "wsl" &&
        normalizedTarget.user &&
        !isValidWslUser(normalizedTarget.user)
      ) {
        throw new Error("WSL user is invalid");
      }
      if (normalizedTarget.kind === "docker" && !normalizedTarget.container) {
        throw new Error("Docker container is required");
      }
      const previousCredentials = new Map<string, string | null>();
      const rememberCredential = async (key: string) => {
        if (previousCredentials.has(key)) return;
        previousCredentials.set(key, await this.options.credentialService.load(key));
      };
      const saveCredential = async (key: string, value: string) => {
        await rememberCredential(key);
        await this.options.credentialService.save(key, value);
      };
      const deleteCredential = async (key?: string) => {
        if (!key) return;
        await rememberCredential(key);
        await this.options.credentialService.delete(key);
      };

      let nextTarget = normalizedTarget;
      try {
        if (
          currentProfile.target.kind === "ssh" &&
          normalizedTarget.kind === "ssh" &&
          input.target.kind === "ssh"
        ) {
          if (!input.sshAuthMethod) {
            throw new Error("SSH authentication method is required");
          }
          if (input.sshAuthMethod === "password") {
            const { privateKeyPath: _privateKeyPath, ...passwordTarget } = normalizedTarget;
            const passwordCredentialKey =
              currentProfile.target.passwordCredentialKey ??
              newCredentialKey(input.profileId, "password");
            const password = input.target.password?.trim();
            const savedPassword = currentProfile.target.passwordCredentialKey
              ? await this.options.credentialService.load(
                  currentProfile.target.passwordCredentialKey,
                )
              : null;
            if (!password && !savedPassword) {
              throw new Error("SSH password is required");
            }
            if (password) {
              await saveCredential(passwordCredentialKey, password);
            }
            await deleteCredential(currentProfile.target.privateKeyPassphraseCredentialKey);
            nextTarget = {
              ...passwordTarget,
              passwordCredentialKey,
            } as SSHProfileTarget;
          } else {
            if (!normalizedTarget.privateKeyPath?.trim()) {
              throw new Error("SSH private key path is required");
            }
            await deleteCredential(currentProfile.target.passwordCredentialKey);
            let privateKeyPassphraseCredentialKey: string | undefined;
            const privateKeyPassphrase = input.target.privateKeyPassphrase?.trim();
            if (privateKeyPassphrase) {
              privateKeyPassphraseCredentialKey =
                currentProfile.target.privateKeyPassphraseCredentialKey ??
                newCredentialKey(input.profileId, "private-key-passphrase");
              await saveCredential(privateKeyPassphraseCredentialKey, privateKeyPassphrase);
            } else if (
              currentProfile.target.privateKeyPath === normalizedTarget.privateKeyPath &&
              currentProfile.target.privateKeyPassphraseCredentialKey
            ) {
              privateKeyPassphraseCredentialKey =
                currentProfile.target.privateKeyPassphraseCredentialKey;
            } else {
              await deleteCredential(currentProfile.target.privateKeyPassphraseCredentialKey);
            }
            nextTarget = {
              ...normalizedTarget,
              ...(privateKeyPassphraseCredentialKey ? { privateKeyPassphraseCredentialKey } : {}),
            } as SSHProfileTarget;
          }
        }

        profiles[profileIndex] = {
          ...currentProfile,
          displayName: profileDisplayName,
          target: nextTarget,
          lastConnectError: undefined,
        } as ConnectionProfile;

        let servers = settings.sourceServers;
        if (sourceDisplayName !== undefined) {
          if (!currentProfile.sourceServerId) {
            throw new Error("Unidentified Connection Profile cannot rename a Source Server");
          }
          servers = [...(settings.sourceServers ?? [])];
          const serverIndex = servers.findIndex(
            (server) => server.sourceServerId === currentProfile.sourceServerId,
          );
          if (serverIndex < 0) {
            throw new Error(`Unknown Source Server: ${currentProfile.sourceServerId}`);
          }
          servers[serverIndex] = {
            ...servers[serverIndex]!,
            displayName: sourceDisplayName,
          };
        }

        // 根因：旧管理面只能改线路别名，用户修改地址时只能新建 Profile，进而把同一
        // Source 的 workspace/task 历史割裂。这里原位更新 Profile，并把凭据与 settings
        // 放在同一回滚边界内，确保 profileId/sourceServerId/history 全部保持稳定。
        await this.persistSettings({
          connectionProfiles: profiles,
          ...(servers ? { sourceServers: servers } : {}),
        });
      } catch (error) {
        await this.restoreCredentials(previousCredentials);
        throw error;
      }
    });
  }

  public async setPreferredProfile(sourceServerId: string, profileId: string): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profile = (settings.connectionProfiles ?? []).find(
        (candidate) => candidate.profileId === profileId && isActiveProfile(candidate),
      );
      if (!profile || profile.sourceServerId !== sourceServerId) {
        throw new Error(`Connection Profile ${profileId} does not belong to ${sourceServerId}`);
      }
      const servers = [...(settings.sourceServers ?? [])];
      const index = servers.findIndex((server) => server.sourceServerId === sourceServerId);
      if (index < 0) throw new Error(`Unknown Source Server: ${sourceServerId}`);
      servers[index] = { ...servers[index]!, preferredProfileId: profileId };
      await this.persistSettings({ sourceServers: servers });
    });
  }

  public async resolveProfileTarget(
    profileOrId: string | ConnectionProfile,
  ): Promise<Exclude<RemoteTarget, { kind: "server" }>> {
    // 更新入口传入已核验的同一 Profile，避免凭据异步读取前再次按 ID 改选执行目标。
    const profile =
      typeof profileOrId === "string"
        ? (await this.snapshot()).profiles.find((candidate) => candidate.profileId === profileOrId)
        : profileOrId;
    if (!profile) throw new Error(`Unknown Connection Profile: ${profileOrId}`);
    const profileId = profile.profileId;
    if (!isActiveProfile(profile)) throw new Error(`Connection Profile is retired: ${profileId}`);
    const target = await this.resolveSilentTarget(profile);
    if (!target)
      // 普通 Error 丢失“需要人工凭据”的语义，项目入口无法交接向导；沿用公开认证码。
      throw Object.assign(
        new Error(`Connection Profile requires interactive credentials: ${profileId}`),
        { code: "credentials-required" },
      );
    return target;
  }

  public async removeProfile(profileId: string): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = [...(settings.connectionProfiles ?? [])];
      const profile = profiles.find((candidate) => candidate.profileId === profileId);
      if (!profile) return;
      const credentialKeys =
        profile.target.kind === "ssh"
          ? [
              profile.target.passwordCredentialKey,
              profile.target.privateKeyPassphraseCredentialKey,
            ].filter((key): key is string => Boolean(key))
          : [];
      const previousCredentials = new Map<string, string | null>();
      try {
        for (const key of credentialKeys) {
          previousCredentials.set(key, await this.options.credentialService.load(key));
          await this.options.credentialService.delete(key);
        }
        const remainingProfiles = profiles.filter((candidate) => candidate.profileId !== profileId);
        await this.persistSettings({
          connectionProfiles: remainingProfiles,
          sourceServerWorkspaceHistory: (settings.sourceServerWorkspaceHistory ?? []).filter(
            (entry) => entry.profileId !== profileId,
          ),
          sourceServers: (settings.sourceServers ?? []).map((server) =>
            server.preferredProfileId === profileId
              ? {
                  ...server,
                  preferredProfileId: remainingProfiles.find(
                    (candidate) =>
                      isActiveProfile(candidate) &&
                      candidate.sourceServerId === server.sourceServerId,
                  )?.profileId,
                }
              : server,
          ),
        });
      } catch (error) {
        await this.restoreCredentials(previousCredentials);
        throw error;
      }
    });
  }

  public async removeSourceServer(sourceServerId: string): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = [...(settings.connectionProfiles ?? [])];
      const removedProfiles = profiles.filter(
        (profile) => profile.sourceServerId === sourceServerId,
      );
      // 幂等空操作：设备无任何本地记录时直接成功返回，不产生写入也不发布变更事件。
      const hasAnyRecord =
        removedProfiles.length > 0 ||
        (settings.sourceServers ?? []).some((server) => server.sourceServerId === sourceServerId) ||
        (settings.sourceServerWorkspaceHistory ?? []).some(
          (entry) => entry.sourceServerId === sourceServerId,
        ) ||
        Boolean(settings.remoteConversationWorkspaceBySourceServerId?.[sourceServerId]);
      if (!hasAnyRecord) return;
      // Bug 原因：识别前写入的 workspace history 尚未回填 sourceServerId，只按设备 id 过滤
      // 会留下指向已删 Profile 的孤儿条目；删除面必须同时覆盖被删设备全部 Profile 的条目。
      const removedProfileIds = new Set(removedProfiles.map((profile) => profile.profileId));
      const credentialKeys = removedProfiles.flatMap((profile) =>
        profile.target.kind === "ssh"
          ? [
              profile.target.passwordCredentialKey,
              profile.target.privateKeyPassphraseCredentialKey,
            ].filter((key): key is string => Boolean(key))
          : [],
      );
      const previousCredentials = new Map<string, string | null>();
      try {
        for (const key of credentialKeys) {
          previousCredentials.set(key, await this.options.credentialService.load(key));
          await this.options.credentialService.delete(key);
        }
        await this.persistSettings({
          connectionProfiles: profiles.filter(
            (profile) => profile.sourceServerId !== sourceServerId,
          ),
          sourceServers: (settings.sourceServers ?? []).filter(
            (server) => server.sourceServerId !== sourceServerId,
          ),
          sourceServerWorkspaceHistory: (settings.sourceServerWorkspaceHistory ?? []).filter(
            (entry) =>
              entry.sourceServerId !== sourceServerId && !removedProfileIds.has(entry.profileId),
          ),
          remoteConversationWorkspaceBySourceServerId: Object.fromEntries(
            Object.entries(settings.remoteConversationWorkspaceBySourceServerId ?? {}).filter(
              ([key]) => key !== sourceServerId,
            ),
          ),
        });
      } catch (error) {
        await this.restoreCredentials(previousCredentials);
        throw error;
      }
    });
  }

  public async markSourceUninstalled(profileId: string): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profile = (settings.connectionProfiles ?? []).find(
        (candidate) => candidate.profileId === profileId && isActiveProfile(candidate),
      );
      if (!profile?.sourceServerId) return;
      await this.persistSettings({
        sourceServers: (settings.sourceServers ?? []).map((server) =>
          server.sourceServerId === profile.sourceServerId
            ? { ...server, installState: "uninstalled" as const }
            : server,
        ),
      });
    });
  }

  private async commitIdentityReplacement(input: {
    settings: AppSettings;
    currentProfile: ConnectionProfile;
    handshake: SourceServerHandshakeRecord;
    connectedAt: number;
  }): Promise<SourceServerHandshakeResult> {
    const previousSourceServerId = input.currentProfile.sourceServerId!;
    const newProfileId = this.createProfileId();
    if (newProfileId === input.currentProfile.profileId) {
      throw new Error("Identity replacement requires a new Connection Profile id");
    }
    const createdCredentialKeys: string[] = [];
    let target = input.currentProfile.target;
    try {
      if (input.currentProfile.target.kind === "ssh") {
        const password = input.currentProfile.target.passwordCredentialKey
          ? await this.options.credentialService.load(
              input.currentProfile.target.passwordCredentialKey,
            )
          : null;
        const passphrase = input.currentProfile.target.privateKeyPassphraseCredentialKey
          ? await this.options.credentialService.load(
              input.currentProfile.target.privateKeyPassphraseCredentialKey,
            )
          : null;
        const passwordCredentialKey =
          password === null ? undefined : newCredentialKey(newProfileId, "password");
        const privateKeyPassphraseCredentialKey =
          passphrase === null
            ? undefined
            : newCredentialKey(newProfileId, "private-key-passphrase");
        if (passwordCredentialKey) {
          createdCredentialKeys.push(passwordCredentialKey);
          await this.options.credentialService.save(passwordCredentialKey, password!);
        }
        if (privateKeyPassphraseCredentialKey) {
          createdCredentialKeys.push(privateKeyPassphraseCredentialKey);
          await this.options.credentialService.save(privateKeyPassphraseCredentialKey, passphrase!);
        }
        target = {
          ...input.currentProfile.target,
          passwordCredentialKey,
          privateKeyPassphraseCredentialKey,
        };
      }

      const retiredProfile: ConnectionProfile = {
        ...input.currentProfile,
        lifecycleState: "retired",
        retiredReason: "source-reinstalled",
        retiredAt: input.connectedAt,
      };
      const newProfile: ConnectionProfile = {
        ...input.currentProfile,
        profileId: newProfileId,
        sourceServerId: input.handshake.sourceServerId,
        target,
        lifecycleState: "active",
        retiredReason: undefined,
        retiredAt: undefined,
        lastConnectedAt: input.connectedAt,
        lastConnectError: undefined,
        createdAt: input.connectedAt,
      } as ConnectionProfile;
      const profiles = (input.settings.connectionProfiles ?? []).map((profile) =>
        profile.profileId === input.currentProfile.profileId ? retiredProfile : profile,
      );
      profiles.push(newProfile);
      const defaultDisplayName = resolveDefaultSourceDisplayName(newProfile, input.handshake);
      const servers = [...(input.settings.sourceServers ?? [])];
      const oldServerIndex = servers.findIndex(
        (server) => server.sourceServerId === previousSourceServerId,
      );
      if (oldServerIndex >= 0) {
        const oldServer = servers[oldServerIndex]!;
        servers[oldServerIndex] = {
          ...oldServer,
          installState: "uninstalled",
          preferredProfileId: profiles.find(
            (profile) =>
              isActiveProfile(profile) && profile.sourceServerId === previousSourceServerId,
          )?.profileId,
        };
      }
      const newServerIndex = servers.findIndex(
        (server) => server.sourceServerId === input.handshake.sourceServerId,
      );
      const existingNewServer = newServerIndex >= 0 ? servers[newServerIndex] : undefined;
      const newServer: SourceServerRecord = {
        sourceServerId: input.handshake.sourceServerId,
        displayName: existingNewServer?.displayName ?? defaultDisplayName,
        ...(input.handshake.osUser ? { osUser: input.handshake.osUser } : {}),
        ...(input.handshake.hostname ? { hostname: input.handshake.hostname } : {}),
        lastSeenVersion: input.handshake.version,
        lastOnlineAt: input.connectedAt,
        preferredProfileId: newProfileId,
        installState: "installed",
        declaredWorkspaces: projectDeclaredWorkspaces(
          input.handshake.sourceServerId,
          input.handshake.workspaces ?? [],
          this.options.logDebug,
        ),
      };
      if (newServerIndex >= 0) servers[newServerIndex] = newServer;
      else servers.push(newServer);
      await this.persistSettings({
        connectionProfiles: profiles,
        sourceServers: servers,
        // 旧 history 保持旧 Source/Profile 身份，不允许随新安装静默改写。
        sourceServerWorkspaceHistory: input.settings.sourceServerWorkspaceHistory ?? [],
      });
      return {
        identityChanged: true,
        migrationFailures: [],
        effectiveProfileId: newProfileId,
        effectiveProfile: newProfile,
      };
    } catch (error) {
      await Promise.all(
        createdCredentialKeys.map(
          async (key) => await this.options.credentialService.delete(key).catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  private async migrateLegacyRemoteEntries(settings: AppSettings): Promise<void> {
    const previousCredentials = new Map<string, string | null>();
    try {
      await this.persistLegacyRemoteEntries(settings, previousCredentials);
    } catch (error) {
      // Bug 原因：legacy 迁移先落新 Profile 凭据、最后提交 Directory settings；settings
      // 写入失败后重试会生成新 profileId，旧 key 因无人引用而永久残留。迁移失败必须在
      // 返回前恢复本轮所有凭据写入，保留 legacy key 供下一次初始化重新迁移。
      await this.restoreCredentials(previousCredentials);
      throw error;
    }
  }

  private async persistLegacyRemoteEntries(
    settings: AppSettings,
    previousCredentials: Map<string, string | null>,
  ): Promise<void> {
    const remoteEntries = (settings.lastWorkspaceSession ?? [])
      .filter((entry) => entry.kind === "remote" && entry.target.kind !== "server")
      .map((entry) => entry as LegacySourceWorkspaceEntry);
    const groups = new Map<string, typeof remoteEntries>();
    for (const entry of remoteEntries) {
      const key = routeKey(entry);
      if (!key) continue;
      const values = groups.get(key) ?? [];
      values.push(entry);
      groups.set(key, values);
    }

    const profiles: ConnectionProfile[] = [];
    const workspaceHistory: SourceServerWorkspaceHistoryEntry[] = [];
    const shouldMigrateProfiles = !settings.connectionProfiles?.length;
    for (const entries of groups.values()) {
      const ordered = [...entries].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
      const latest = ordered[0]!;
      const profileId = this.createProfileId();
      // 既有 Profile 会作为本次 settings patch 的权威值保留；为随后被丢弃的临时 Profile
      // 复制凭据会在成功迁移时也制造 orphan key，因此只有真正进入提交集的 Profile 才落 secret。
      const target = shouldMigrateProfiles
        ? await this.migrateProfileTarget(
            profileId,
            latest.target,
            previousCredentials,
            ordered.map((entry) => entry.target),
          )
        : this.profileTargetFromRemote(latest.target);
      const transport = target.kind;
      profiles.push({
        profileId,
        transport,
        target,
        displayName:
          target.kind === "ssh"
            ? (target.sshConfigAlias ?? target.host)
            : target.kind === "wsl"
              ? (target.distro ?? "WSL")
              : target.container,
        createdAt: Math.min(...entries.map((entry) => entry.lastOpenedAt)),
        lastConnectedAt:
          latest.lastConnectionStatus === "connected" ? latest.lastOpenedAt : undefined,
        lastConnectError: latest.lastConnectionError,
      } as ConnectionProfile);
      for (const entry of entries) {
        workspaceHistory.push({
          workspacePath: entry.workspacePath,
          ...(entry.workspaceIdentity ? { legacyWorkspaceIdentity: entry.workspaceIdentity } : {}),
          profileId,
          lastOpenedAt: entry.lastOpenedAt,
        });
      }
    }

    await this.persistSettings({
      sourceServers: settings.sourceServers ?? [],
      connectionProfiles: settings.connectionProfiles?.length
        ? settings.connectionProfiles
        : profiles,
      sourceServerWorkspaceHistory: settings.sourceServerWorkspaceHistory?.length
        ? settings.sourceServerWorkspaceHistory
        : workspaceHistory.sort((left, right) => left.lastOpenedAt - right.lastOpenedAt),
      sourceServerDirectoryMigrationVersion: 1,
    });
  }

  private async repairDanglingProfileCredentials(settings: AppSettings): Promise<void> {
    // Bug 原因：旧 Desktop 写回 settings 会剥离 Source Directory，新版再次迁移时可能已把
    // 空 legacy key 变成 canonical Profile ref。migrationVersion=1 也必须按精确 route 幂等
    // 审计并恢复真实 value；禁止根据 alias/hostname 猜测其它连接的 secret。
    const legacyEntriesByRoute = new Map<string, LegacySourceWorkspaceEntry[]>();
    for (const entry of settings.lastWorkspaceSession ?? []) {
      if (entry.kind !== "remote" || entry.target.kind === "server") continue;
      const key = routeKey(entry);
      if (!key) continue;
      const entries = legacyEntriesByRoute.get(key) ?? [];
      entries.push(entry as LegacySourceWorkspaceEntry);
      legacyEntriesByRoute.set(key, entries);
    }
    for (const entries of legacyEntriesByRoute.values()) {
      entries.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
    }

    for (const profile of settings.connectionProfiles ?? []) {
      if (!isActiveProfile(profile) || profile.target.kind !== "ssh") continue;
      const entries = legacyEntriesByRoute.get(
        [
          "ssh",
          profile.target.host.trim().toLowerCase(),
          String(profile.target.port ?? 22),
          profile.target.username.trim(),
          profile.target.privateKeyPath?.trim() ?? "",
        ].join("\u0000"),
      );
      if (!entries?.length) continue;

      const passwordCredentialKey = profile.target.passwordCredentialKey;
      if (
        passwordCredentialKey &&
        (await this.options.credentialService.load(passwordCredentialKey)) === null
      ) {
        await this.copyFirstAvailableCredential(
          entries.flatMap((entry) =>
            entry.target.kind === "ssh" && entry.target.passwordCredentialKey
              ? [entry.target.passwordCredentialKey]
              : [],
          ),
          passwordCredentialKey,
        );
      }

      const privateKeyPassphraseCredentialKey =
        profile.target.privateKeyPath && profile.target.privateKeyPassphraseCredentialKey;
      if (
        privateKeyPassphraseCredentialKey &&
        (await this.options.credentialService.load(privateKeyPassphraseCredentialKey)) === null
      ) {
        await this.copyFirstAvailableCredential(
          entries.flatMap((entry) =>
            entry.target.kind === "ssh" &&
            entry.target.privateKeyPath &&
            entry.target.privateKeyPassphraseCredentialKey
              ? [entry.target.privateKeyPassphraseCredentialKey]
              : [],
          ),
          privateKeyPassphraseCredentialKey,
        );
      }
    }
  }

  private async migrateProfileTarget(
    profileId: string,
    target: LegacySourceWorkspaceEntry["target"],
    previousCredentials: Map<string, string | null>,
    credentialSources: readonly LegacySourceWorkspaceEntry["target"][] = [target],
  ): Promise<SSHProfileTarget | WSLProfileTarget | DockerProfileTarget> {
    if (target.kind === "ssh") {
      const nextPasswordCredentialKey = newCredentialKey(profileId, "password");
      const nextPrivateKeyPassphraseCredentialKey = newCredentialKey(
        profileId,
        "private-key-passphrase",
      );
      const passwordCopied = await this.copyFirstAvailableCredential(
        credentialSources.flatMap((candidate) =>
          candidate.kind === "ssh" && candidate.passwordCredentialKey
            ? [candidate.passwordCredentialKey]
            : [],
        ),
        nextPasswordCredentialKey,
        previousCredentials,
      );
      // 两类凭据必须顺序等待：并行 Promise 提前 reject 时，另一条迟到 save 可能越过
      // migration rollback 再落盘，重新制造无人引用的 key。
      const privateKeyPassphraseCopied = target.privateKeyPath
        ? await this.copyFirstAvailableCredential(
            credentialSources.flatMap((candidate) =>
              candidate.kind === "ssh" &&
              candidate.privateKeyPath &&
              candidate.privateKeyPassphraseCredentialKey
                ? [candidate.privateKeyPassphraseCredentialKey]
                : [],
            ),
            nextPrivateKeyPassphraseCredentialKey,
            previousCredentials,
          )
        : false;
      // Bug 原因：旧 snapshot 可能在密码认证时仍携带私钥口令 ref。
      // 口令只有在 privateKeyPath 存在时才属于当前认证方式，否则迁移后会平白阻断完整密码。
      // 实际私钥认证的 ref 仍保留：若对应值缺失，它必须继续触发交互凭据，不能静默降级。
      return {
        kind: "ssh",
        host: target.host.trim().toLowerCase(),
        port: target.port ?? 22,
        username: target.username.trim(),
        ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
        ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
        ...(target.assetInstallMode ? { assetInstallMode: target.assetInstallMode } : {}),
        ...(passwordCopied ? { passwordCredentialKey: nextPasswordCredentialKey } : {}),
        ...(privateKeyPassphraseCopied
          ? {
              privateKeyPassphraseCredentialKey: nextPrivateKeyPassphraseCredentialKey,
            }
          : {}),
      };
    }
    if (target.kind === "wsl") {
      return {
        kind: "wsl",
        ...(target.distro ? { distro: target.distro.trim() } : {}),
        ...(target.user ? { user: target.user.trim() } : {}),
      };
    }
    return { kind: "docker", container: target.container.trim() };
  }

  private profileTargetFromRemote(
    target: Exclude<RemoteTarget, { kind: "server" }>,
  ): SSHProfileTarget | WSLProfileTarget | DockerProfileTarget {
    if (target.kind === "ssh") {
      return {
        kind: "ssh",
        host: target.host.trim().toLowerCase(),
        port: target.port ?? 22,
        username: target.username.trim(),
        ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
        ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
        ...(target.assetInstallMode ? { assetInstallMode: target.assetInstallMode } : {}),
      };
    }
    if (target.kind === "wsl") {
      return {
        kind: "wsl",
        ...(target.distro ? { distro: target.distro.trim() } : {}),
        ...(target.user ? { user: target.user.trim() } : {}),
      };
    }
    return { kind: "docker", container: target.container.trim() };
  }

  private async copyFirstAvailableCredential(
    sourceKeys: readonly string[],
    destinationKey: string,
    previousCredentials?: Map<string, string | null>,
  ): Promise<boolean> {
    for (const sourceKey of sourceKeys) {
      const value = await this.options.credentialService.load(sourceKey);
      if (value === null) continue;
      // Bug 原因：旧迁移只看最新 workspace 的 key，源值为空时仍生成新的 Profile ref。
      // 同 route 按 lastOpenedAt 顺序寻找首个真实值，且只有复制成功才允许调用方写引用。
      if (previousCredentials && !previousCredentials.has(destinationKey)) {
        previousCredentials.set(
          destinationKey,
          await this.options.credentialService.load(destinationKey),
        );
      }
      await this.options.credentialService.save(destinationKey, value);
      return true;
    }
    return false;
  }

  private async persistProfileCredentials(
    profileId: string,
    target: Exclude<RemoteTarget, { kind: "server" }>,
    profileTarget: SSHProfileTarget | WSLProfileTarget | DockerProfileTarget,
  ): Promise<{
    target: SSHProfileTarget | WSLProfileTarget | DockerProfileTarget;
    rollback: () => Promise<void>;
  }> {
    if (target.kind !== "ssh" || profileTarget.kind !== "ssh") {
      return { target: profileTarget, rollback: async () => undefined };
    }
    const passwordCredentialKey = target.password?.length
      ? (profileTarget.passwordCredentialKey ?? newCredentialKey(profileId, "password"))
      : profileTarget.passwordCredentialKey;
    const privateKeyPassphraseCredentialKey = target.privateKeyPassphrase?.length
      ? (profileTarget.privateKeyPassphraseCredentialKey ??
        newCredentialKey(profileId, "private-key-passphrase"))
      : profileTarget.privateKeyPassphraseCredentialKey;
    const writes = [
      ...(target.password?.length && passwordCredentialKey
        ? [{ key: passwordCredentialKey, value: target.password }]
        : []),
      ...(target.privateKeyPassphrase?.length && privateKeyPassphraseCredentialKey
        ? [
            {
              key: privateKeyPassphraseCredentialKey,
              value: target.privateKeyPassphrase,
            },
          ]
        : []),
    ];
    const previous = new Map<string, string | null>();
    try {
      for (const write of writes) {
        previous.set(write.key, await this.options.credentialService.load(write.key));
        await this.options.credentialService.save(write.key, write.value);
      }
    } catch (error) {
      await this.restoreCredentials(previous);
      throw error;
    }
    const nextTarget: SSHProfileTarget = {
      ...profileTarget,
      ...(passwordCredentialKey ? { passwordCredentialKey } : {}),
      ...(privateKeyPassphraseCredentialKey ? { privateKeyPassphraseCredentialKey } : {}),
    };
    const changed =
      nextTarget.passwordCredentialKey !== profileTarget.passwordCredentialKey ||
      nextTarget.privateKeyPassphraseCredentialKey !==
        profileTarget.privateKeyPassphraseCredentialKey;
    return {
      target: changed ? nextTarget : profileTarget,
      rollback: async () => await this.restoreCredentials(previous),
    };
  }

  private async restoreCredentials(previous: ReadonlyMap<string, string | null>): Promise<void> {
    await Promise.all(
      [...previous].map(async ([key, value]) => {
        if (value === null) await this.options.credentialService.delete(key);
        else await this.options.credentialService.save(key, value);
      }),
    );
  }

  private async resolveSilentTarget(
    profile: ConnectionProfile,
  ): Promise<Exclude<RemoteTarget, { kind: "server" }> | null> {
    if (profile.target.kind === "wsl" || profile.target.kind === "docker") {
      return profile.target;
    }
    const password = profile.target.passwordCredentialKey
      ? await this.options.credentialService.load(profile.target.passwordCredentialKey)
      : null;
    const privateKeyPassphrase =
      profile.target.privateKeyPath && profile.target.privateKeyPassphraseCredentialKey
        ? await this.options.credentialService.load(
            profile.target.privateKeyPassphraseCredentialKey,
          )
        : null;
    // Bug 原因：legacy workspace 迁移可能留下没有 privateKeyPath 的私钥口令引用。
    // 旧逻辑要求所有引用都有值，把已完整的密码认证也误判为需要交互凭据。
    // SSH 密码和私钥是可替代方案；只要其中一条认证链完整即可静默连接。
    const hasPasswordAuth = Boolean(password);
    const hasPrivateKeyAuth = Boolean(
      profile.target.privateKeyPath &&
      (!profile.target.privateKeyPassphraseCredentialKey || privateKeyPassphrase),
    );
    if (!hasPasswordAuth && !hasPrivateKeyAuth) return null;
    return {
      kind: "ssh",
      host: profile.target.host,
      port: profile.target.port,
      username: profile.target.username,
      ...(profile.target.sshConfigAlias ? { sshConfigAlias: profile.target.sshConfigAlias } : {}),
      ...(hasPrivateKeyAuth && profile.target.privateKeyPath
        ? { privateKeyPath: profile.target.privateKeyPath }
        : {}),
      ...(profile.target.assetInstallMode
        ? { assetInstallMode: profile.target.assetInstallMode }
        : {}),
      ...(password ? { password } : {}),
      ...(hasPrivateKeyAuth && privateKeyPassphrase ? { privateKeyPassphrase } : {}),
    };
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Bug 原因：过去 enqueue 完成后无条件 fire onDidChange，未写入的操作（已迁移短路、
    // identity-pending 零写入分支、目标不存在的 no-op）也会驱动全部消费方权威重读快照。
    // 事件语义收敛为「确有持久化写入成功才通知」；写入统一走 persistSettings 打标。
    const run = async (): Promise<{ value: T; didPersist: boolean }> => {
      this.didPersistInCurrentOperation = false;
      const value = await operation();
      return { value, didPersist: this.didPersistInCurrentOperation };
    };
    const result = this.writeChain.then(run, run);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    const { value, didPersist } = await result;
    if (didPersist) this.changeEmitter.fire();
    return value;
  }

  /** 目录持久化写入的唯一入口：写入成功即标记本次 enqueue 操作需要发布变更事件。 */
  private async persistSettings(patch: Partial<AppSettings>): Promise<void> {
    await this.options.settingService.update(patch);
    this.didPersistInCurrentOperation = true;
  }
}

function projectDeclaredWorkspaces(
  sourceServerId: string,
  workspaces: readonly SourceServerDeclaredWorkspaceWire[],
  logDebug?: (message: string) => void,
): SourceServerRecord["declaredWorkspaces"] {
  const canonicalServerIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: sourceServerId,
    workspacePath: "/",
  });
  const canonicalServerId = parseRemoteWorkspaceIdentity(canonicalServerIdentity)?.sourceServerId;
  const result: NonNullable<SourceServerRecord["declaredWorkspaces"]> = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    const workspacePath = workspace.path.trim();
    if (!workspacePath) continue;
    const canonicalIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: sourceServerId,
      workspacePath,
    });
    const parsedIdentity = workspace.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(workspace.workspaceIdentity)
      : null;
    const identityIsValid =
      parsedIdentity?.kind === "server" &&
      parsedIdentity.sourceServerId === canonicalServerId &&
      parsedIdentity.workspacePath ===
        parseRemoteWorkspaceIdentity(canonicalIdentity)?.workspacePath;
    // 设备记录必须使用设备级 canonical identity；不信任远端传回的线路级或跨设备 identity。
    const workspaceIdentity =
      identityIsValid && workspace.workspaceIdentity === canonicalIdentity
        ? workspace.workspaceIdentity
        : canonicalIdentity;
    // 合同 §8.1.1：远端 identity 校验不通过被 canonical 覆盖时仅记 debug 日志、不报错。
    if (workspace.workspaceIdentity && workspace.workspaceIdentity !== workspaceIdentity) {
      logDebug?.(
        `Source Server declared workspace identity overridden by canonical: server=${sourceServerId} path=${workspacePath} remote=${workspace.workspaceIdentity}`,
      );
    }
    if (seen.has(workspaceIdentity)) continue;
    seen.add(workspaceIdentity);
    result.push({
      workspacePath,
      workspaceIdentity,
      ...(workspace.label ? { label: workspace.label } : {}),
    });
    if (result.length >= 20) break;
  }
  return result;
}
