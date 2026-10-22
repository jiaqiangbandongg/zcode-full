/* eslint-disable max-lines -- 远端 workspace 历史集中维护持久化、凭据和 MCP 路径映射元数据，拆分会扩大恢复链路回归面。 */
import type {
  AppSettings,
  PersistedWorkspaceSessionEntry,
  RemoteTarget,
  RemoteTargetSnapshot,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import { buildServerRemoteWorkspaceIdentity, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { WindowTabState } from "@/store/tabStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

const REMOTE_WORKSPACE_SESSION_LIMIT = 20;

interface RemoteWorkspaceSessionMutation {
  entry: RemoteWorkspaceSessionEntry;
  nextRemoteSessions: RemoteWorkspaceSessionEntry[];
  credentialsToSave: {
    key: string;
    value: string;
  }[];
  credentialKeysToDelete: string[];
}

interface RemoveRemoteWorkspaceSessionEntriesResult {
  nextRemoteSessions: RemoteWorkspaceSessionEntry[];
  credentialKeysToDelete: string[];
}

function buildRemoteWorkspacePasswordCredentialKey(workspaceKey: string): string {
  return `remote-workspace:${workspaceKey}:password`;
}

function buildRemoteWorkspacePrivateKeyPassphraseCredentialKey(workspaceKey: string): string {
  return `remote-workspace:${workspaceKey}:private-key-passphrase`;
}

function buildRemoteWorkspaceServerTokenCredentialKey(workspaceKey: string): string {
  return `remote-workspace:${workspaceKey}:server-token`;
}

function collectOwnedRemoteWorkspaceCredentialKeys(snapshot: RemoteTargetSnapshot): string[] {
  // 历史快照可引用 Profile 凭据，但引用不转移所有权。此前重投影移除引用时
  // 把 Profile 密码也加入删除列表，导致冷启动后失去认证；所有历史清理只收集自有 key。
  const isOwned = (key: string | undefined): key is string =>
    typeof key === "string" && key.startsWith("remote-workspace:");
  if (snapshot.kind === "ssh") {
    return [snapshot.passwordCredentialKey, snapshot.privateKeyPassphraseCredentialKey].filter(
      isOwned,
    );
  }

  if (snapshot.kind === "server") {
    return [snapshot.tokenCredentialKey].filter(isOwned);
  }

  return [];
}

export function getWorkspaceDisplayLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? workspacePath;
}

export function hasRemoteWorkspaceIdentity(entry: {
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
}): boolean {
  return Boolean(entry.remoteSessionId || entry.remoteTarget || entry.workspaceIdentity);
}

export function isSshRemoteWorkspaceIdentity(workspaceIdentity?: string | null): boolean {
  return workspaceIdentity?.trim().startsWith("remote:ssh:") === true;
}

type WslRemoteTargetLike = Extract<RemoteTarget | RemoteTargetSnapshot, { kind: "wsl" }>;

function getWslRemoteTargetUser(target: WslRemoteTargetLike): string | undefined {
  return target.user?.trim() || undefined;
}

function formatWslRemoteTargetAuthority(target: WslRemoteTargetLike): string {
  const user = getWslRemoteTargetUser(target);
  if (target.distro) {
    return user ? `wsl:${target.distro}:${user}` : `wsl:${target.distro}`;
  }

  return user ? `wsl:default:${user}` : "wsl";
}

function getServerRemoteTargetDisplayName(
  target: Extract<RemoteTarget | RemoteTargetSnapshot, { kind: "server" }>,
): string {
  return target.name?.trim() || target.serverId?.trim() || formatServerRemoteTargetHost(target);
}

function formatServerRemoteTargetHost(
  target: Extract<RemoteTarget | RemoteTargetSnapshot, { kind: "server" }>,
): string {
  try {
    return new URL(target.url.trim()).host;
  } catch {
    return target.url.trim();
  }
}

export function formatRemoteWorkspaceTargetSubtitle(
  target: RemoteTarget | RemoteTargetSnapshot,
): string {
  switch (target.kind) {
    case "ssh":
      return `SSH · ${target.username}@${target.host}${target.port ? `:${target.port}` : ""}`;
    case "wsl": {
      const user = getWslRemoteTargetUser(target);
      return ["WSL", target.distro, user].filter(Boolean).join(" · ");
    }
    case "docker":
      return `Docker · ${target.container}`;
    case "server":
      return `Server · ${getServerRemoteTargetDisplayName(target)}`;
  }
}

export function formatRemoteWorkspaceHeaderHostLabel(
  target: RemoteTarget | RemoteTargetSnapshot,
): string {
  switch (target.kind) {
    case "ssh":
      return target.port && target.port !== 22 ? `${target.host}:${target.port}` : target.host;
    case "wsl":
      return formatWslRemoteTargetAuthority(target);
    case "docker":
      return `docker:${target.container}`;
    case "server":
      return formatServerRemoteTargetHost(target);
  }
}

export function formatRemoteWorkspaceDisplayLabel(
  label: string,
  target?: RemoteTarget | RemoteTargetSnapshot,
): string {
  // 线路信息属于设备原子/悬浮详情，不能把硬编码 SSH alias 拼进项目名称；
  // 这样既避免窄侧栏截断，也让标题可本地化。target 参数保留兼容旧调用方。
  void target;
  return label;
}

function normalizeWorkspacePathForIdentity(path: string): string {
  // 远程目录可能出现符号链接别名（例如 /dev 与 /home/dev）。
  // 身份计算前统一做分隔符归一化与收尾斜杠清理，避免同一路径文本噪声导致身份漂移。
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : "/";
}

function getRemoteWorkspaceAuthorityKey(target: RemoteTarget | RemoteTargetSnapshot): string {
  switch (target.kind) {
    case "ssh": {
      const normalizedHost = target.host.trim().toLowerCase();
      const normalizedUsername = target.username.trim();
      const normalizedPort = target.port ?? 22;
      return ["ssh", normalizedHost, normalizedPort, normalizedUsername].join(":");
    }
    case "wsl": {
      // WSL 默认用户与 root/其他显式用户的文件权限边界不同，
      // workspace identity 必须区分显式 user，避免 session、缓存和队列串用。
      const user = getWslRemoteTargetUser(target);
      const base = ["wsl", target.distro ?? "default"];
      return user ? [...base, user].join(":") : base.join(":");
    }
    case "docker":
      return ["docker", target.container].join(":");
    case "server": {
      const identity = buildServerRemoteWorkspaceIdentity({
        serverId: getServerRemoteTargetIdentityId(target),
        workspacePath: "/",
      });
      return identity.slice("remote:".length, -":/".length);
    }
  }
}

export function buildRemoteWorkspaceIdentity(
  workspacePath: string,
  target: RemoteTarget | RemoteTargetSnapshot,
): string {
  if (target.kind === "server") {
    return buildServerRemoteWorkspaceIdentity({
      serverId: getServerRemoteTargetIdentityId(target),
      workspacePath,
    });
  }

  const authority = getRemoteWorkspaceAuthorityKey(target);
  const normalizedPath = normalizeWorkspacePathForIdentity(workspacePath);
  return `remote:${authority}:${normalizedPath}`;
}

function getServerRemoteTargetIdentityId(
  target: Extract<RemoteTarget | RemoteTargetSnapshot, { kind: "server" }>,
): string {
  return target.serverId?.trim() || target.name?.trim() || formatServerRemoteTargetHost(target);
}

export function resolveRemoteWorkspaceSessionIdentity(
  entry: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "target" | "workspaceIdentity">,
): string {
  return entry.workspaceIdentity || buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target);
}

export function buildWorkspaceSessionKey(entry: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return entry.workspaceIdentity?.trim() || entry.workspacePath;
}

function normalizeOptionalPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed ? trimmed : undefined;
}

export function findMatchingRemoteWorkspaceSessionEntry(
  sessions: RemoteWorkspaceSessionEntry[],
  workspacePath: string,
  target: RemoteTarget | RemoteTargetSnapshot,
  preferredWorkspaceIdentity?: string,
): RemoteWorkspaceSessionEntry | null {
  const preferredWorkspaceKey = preferredWorkspaceIdentity?.trim();
  if (preferredWorkspaceKey) {
    const preferred = sessions.find(
      (entry) =>
        entry.workspacePath === workspacePath &&
        buildWorkspaceSessionKey(entry) === preferredWorkspaceKey,
    );
    if (preferred) return preferred;
  }
  const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
  return (
    sessions.find((entry) => resolveRemoteWorkspaceSessionIdentity(entry) === workspaceIdentity) ??
    null
  );
}

export function createRemoteTargetSnapshot(
  workspaceKey: string,
  target: RemoteTarget,
  previousSnapshot?: RemoteTargetSnapshot,
): RemoteTargetSnapshot {
  const sourceServerOwnedCredentials =
    parseRemoteWorkspaceIdentity(workspaceKey)?.kind === "server";
  switch (target.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: target.host,
        port: target.port,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
        assetInstallMode: target.assetInstallMode,
        privateKeyPath: target.privateKeyPath,
        passwordCredentialKey:
          !sourceServerOwnedCredentials && target.password && target.password.length > 0
            ? previousSnapshot?.kind === "ssh" && previousSnapshot.passwordCredentialKey
              ? previousSnapshot.passwordCredentialKey
              : buildRemoteWorkspacePasswordCredentialKey(workspaceKey)
            : undefined,
        privateKeyPassphraseCredentialKey:
          !sourceServerOwnedCredentials &&
          target.privateKeyPassphrase &&
          target.privateKeyPassphrase.length > 0
            ? previousSnapshot?.kind === "ssh" && previousSnapshot.privateKeyPassphraseCredentialKey
              ? previousSnapshot.privateKeyPassphraseCredentialKey
              : buildRemoteWorkspacePrivateKeyPassphraseCredentialKey(workspaceKey)
            : undefined,
      };
    case "wsl": {
      const user = target.user?.trim();
      return {
        kind: "wsl",
        distro: target.distro,
        ...(user ? { user } : {}),
      };
    }
    case "docker":
      return {
        kind: "docker",
        container: target.container,
      };
    case "server":
      return {
        kind: "server",
        url: target.url,
        ...(target.name?.trim() ? { name: target.name.trim() } : {}),
        ...(target.workspacePath?.trim() ? { workspacePath: target.workspacePath.trim() } : {}),
        ...(target.serverId?.trim() ? { serverId: target.serverId.trim() } : {}),
        tokenCredentialKey:
          target.token && target.token.length > 0
            ? previousSnapshot?.kind === "server" && previousSnapshot.tokenCredentialKey
              ? previousSnapshot.tokenCredentialKey
              : buildRemoteWorkspaceServerTokenCredentialKey(workspaceKey)
            : undefined,
      };
  }
}

export function createRemoteTargetFromSnapshot(
  snapshot: RemoteTargetSnapshot,
  credentials: {
    password: string | null;
    privateKeyPassphrase: string | null;
    token?: string | null;
  },
): RemoteTarget {
  switch (snapshot.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: snapshot.host,
        port: snapshot.port,
        username: snapshot.username,
        ...(snapshot.sshConfigAlias ? { sshConfigAlias: snapshot.sshConfigAlias } : {}),
        ...(snapshot.assetInstallMode ? { assetInstallMode: snapshot.assetInstallMode } : {}),
        ...(snapshot.privateKeyPath ? { privateKeyPath: snapshot.privateKeyPath } : {}),
        ...(credentials.password ? { password: credentials.password } : {}),
        ...(credentials.privateKeyPassphrase
          ? { privateKeyPassphrase: credentials.privateKeyPassphrase }
          : {}),
      };
    case "wsl":
      return {
        kind: "wsl",
        distro: snapshot.distro,
        ...(snapshot.user ? { user: snapshot.user } : {}),
      };
    case "docker":
      return {
        kind: "docker",
        container: snapshot.container,
      };
    case "server":
      return {
        kind: "server",
        url: snapshot.url,
        ...(snapshot.name ? { name: snapshot.name } : {}),
        ...(snapshot.workspacePath ? { workspacePath: snapshot.workspacePath } : {}),
        ...(snapshot.serverId ? { serverId: snapshot.serverId } : {}),
        ...(credentials.token ? { token: credentials.token } : {}),
      };
  }
}

export function upsertRemoteWorkspaceSessionEntries(
  sessions: RemoteWorkspaceSessionEntry[],
  nextEntry: RemoteWorkspaceSessionEntry,
): RemoteWorkspaceSessionEntry[] {
  const nextWorkspaceKey = buildWorkspaceSessionKey(nextEntry);
  return [
    nextEntry,
    ...sessions.filter((entry) => buildWorkspaceSessionKey(entry) !== nextWorkspaceKey),
  ]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .slice(0, REMOTE_WORKSPACE_SESSION_LIMIT);
}

export function removeRemoteWorkspaceSessionEntries(
  sessions: readonly RemoteWorkspaceSessionEntry[],
  workspaceKeys: readonly string[],
): RemoveRemoteWorkspaceSessionEntriesResult {
  const workspaceKeySet = new Set(
    workspaceKeys.map((workspaceKey) => workspaceKey.trim()).filter(Boolean),
  );
  const credentialKeysToDelete = new Set<string>();
  const nextRemoteSessions: RemoteWorkspaceSessionEntry[] = [];

  for (const session of sessions) {
    const sessionWorkspaceKey = buildWorkspaceSessionKey(session);
    if (!workspaceKeySet.has(sessionWorkspaceKey)) {
      nextRemoteSessions.push(session);
      continue;
    }

    for (const credentialKey of collectOwnedRemoteWorkspaceCredentialKeys(session.target)) {
      credentialKeysToDelete.add(credentialKey);
    }
  }

  return {
    nextRemoteSessions,
    credentialKeysToDelete: [...credentialKeysToDelete],
  };
}

export function buildRemoteWorkspaceSessionMutation(params: {
  remoteSessions: RemoteWorkspaceSessionEntry[];
  workspacePath: string;
  localWorkspacePath?: string;
  workspaceIdentity?: string;
  target: RemoteTarget;
  workspacePurpose?: "project" | "conversation";
  lastConnectionStatus: RemoteWorkspaceSessionEntry["lastConnectionStatus"];
  lastConnectionError?: string;
  touchOpenedAt: boolean;
}): RemoteWorkspaceSessionMutation {
  const currentEntry =
    findMatchingRemoteWorkspaceSessionEntry(
      params.remoteSessions,
      params.workspacePath,
      params.target,
      params.workspaceIdentity,
    ) ?? null;
  const resolvedWorkspaceIdentity =
    params.workspaceIdentity ??
    currentEntry?.workspaceIdentity ??
    buildRemoteWorkspaceIdentity(params.workspacePath, params.target);
  const workspaceKey = resolvedWorkspaceIdentity?.trim() || params.workspacePath;
  const nextSnapshot =
    params.lastConnectionStatus === "failed" && currentEntry
      ? currentEntry.target
      : createRemoteTargetSnapshot(workspaceKey, params.target, currentEntry?.target);
  const localWorkspacePath = normalizeOptionalPath(
    params.localWorkspacePath ?? currentEntry?.localWorkspacePath,
  );
  const nextEntry: RemoteWorkspaceSessionEntry = {
    kind: "remote",
    workspacePath: params.workspacePath,
    ...(params.workspacePurpose || currentEntry?.workspacePurpose
      ? {
          workspacePurpose: params.workspacePurpose ?? currentEntry?.workspacePurpose,
        }
      : {}),
    // Bugfix: filesystem MCP 同步需要用“本机 workspace -> 远端 workspace”映射。
    // 远端历史之前只保存远端路径，已连接后的 Settings/Header 入口无法再恢复本机基准路径。
    ...(localWorkspacePath ? { localWorkspacePath } : {}),
    workspaceIdentity: resolvedWorkspaceIdentity,
    target: nextSnapshot,
    lastOpenedAt: params.touchOpenedAt ? Date.now() : (currentEntry?.lastOpenedAt ?? Date.now()),
    lastConnectionStatus: params.lastConnectionStatus,
    lastConnectionError:
      params.lastConnectionStatus === "failed"
        ? (params.lastConnectionError ?? currentEntry?.lastConnectionError)
        : undefined,
  };
  // Bug 原因：Host 绑定 stable identity 后，旧 route entry 与新 entry 的 key 不同，
  // 通用 upsert 会把两条都保留。已经通过 target/alias 证明的 currentEntry 就是被换代对象，
  // 必须先移除再按 stable key 插入。
  const nextRemoteSessions = upsertRemoteWorkspaceSessionEntries(
    currentEntry
      ? params.remoteSessions.filter((entry) => entry !== currentEntry)
      : params.remoteSessions,
    nextEntry,
  );
  const nextRemoteWorkspaceKeys = new Set(
    nextRemoteSessions.map((entry) => buildWorkspaceSessionKey(entry)),
  );
  const credentialKeysToDelete = new Set<string>();
  const previousCredentialKeys = new Set(
    currentEntry ? collectOwnedRemoteWorkspaceCredentialKeys(currentEntry.target) : [],
  );
  const nextCredentialKeys = new Set(collectOwnedRemoteWorkspaceCredentialKeys(nextSnapshot));
  const sourceServerOwnedCredentials =
    parseRemoteWorkspaceIdentity(workspaceKey)?.kind === "server";
  const preservesRollbackCredential = (credentialKey: string): boolean =>
    sourceServerOwnedCredentials &&
    credentialKey.startsWith("remote-workspace:remote:") &&
    !credentialKey.includes(":remote:server:");

  for (const previousCredentialKey of previousCredentialKeys) {
    if (
      !nextCredentialKeys.has(previousCredentialKey) &&
      !preservesRollbackCredential(previousCredentialKey)
    ) {
      credentialKeysToDelete.add(previousCredentialKey);
    }
  }

  for (const removedEntry of params.remoteSessions) {
    if (removedEntry === currentEntry) {
      // currentEntry 的凭据差异已在 previousCredentialKeys 分支处理；
      // 无显式 identity 的旧 entry 不能再被当成「被容量裁剪」重复删除凭据。
      continue;
    }
    if (nextRemoteWorkspaceKeys.has(buildWorkspaceSessionKey(removedEntry))) {
      continue;
    }

    for (const credentialKey of collectOwnedRemoteWorkspaceCredentialKeys(removedEntry.target)) {
      if (!preservesRollbackCredential(credentialKey)) {
        credentialKeysToDelete.add(credentialKey);
      }
    }
  }

  const credentialsToSave: { key: string; value: string }[] = [];

  if (
    params.target.kind === "ssh" &&
    nextSnapshot.kind === "ssh" &&
    params.target.password &&
    nextSnapshot.passwordCredentialKey
  ) {
    credentialsToSave.push({
      key: nextSnapshot.passwordCredentialKey,
      value: params.target.password,
    });
  }

  if (
    params.target.kind === "ssh" &&
    nextSnapshot.kind === "ssh" &&
    params.target.privateKeyPassphrase &&
    nextSnapshot.privateKeyPassphraseCredentialKey
  ) {
    credentialsToSave.push({
      key: nextSnapshot.privateKeyPassphraseCredentialKey,
      value: params.target.privateKeyPassphrase,
    });
  }

  if (
    params.target.kind === "server" &&
    nextSnapshot.kind === "server" &&
    params.target.token &&
    nextSnapshot.tokenCredentialKey
  ) {
    credentialsToSave.push({
      key: nextSnapshot.tokenCredentialKey,
      value: params.target.token,
    });
  }

  return {
    entry: nextEntry,
    nextRemoteSessions,
    credentialsToSave,
    credentialKeysToDelete: [...credentialKeysToDelete],
  };
}

export function buildPersistedWorkspaceSessionEntries(
  tabs: WindowTabState[],
  remoteSessionsByWorkspaceKey: ReadonlyMap<string, RemoteWorkspaceSessionEntry>,
): PersistedWorkspaceSessionEntry[] {
  return tabs.reduce<PersistedWorkspaceSessionEntry[]>((entries, tab) => {
    if (!isWorkspaceTab(tab)) {
      return entries;
    }

    if (hasRemoteWorkspaceIdentity(tab)) {
      const workspaceKey = buildWorkspaceSessionKey(tab);
      const remoteEntry = remoteSessionsByWorkspaceKey.get(workspaceKey);

      // lastWorkspaceSession 现在是远端 workspace 的唯一持久化来源。
      // 如果这里因为 tab 断连就把 remote 项漏掉，下次启动会直接丢失“手动重连”的入口。
      // 因此只要当前 tab 具有远端身份，就必须写回完整 remote 条目。
      if (!remoteEntry) {
        return entries;
      }

      entries.push(remoteEntry);
      return entries;
    }

    entries.push({
      kind: "local",
      workspacePath: tab.workspacePath,
      ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
    });
    return entries;
  }, []);
}

export function readPersistedWorkspaceSessionEntries(
  settings: Pick<
    AppSettings,
    | "lastWorkspaceSession"
    | "lastActiveWorkspace"
    | "sourceServerWorkspaceHistory"
    | "connectionProfiles"
    | "remoteConversationWorkspaceBySourceServerId"
  >,
): PersistedWorkspaceSessionEntry[] {
  // 新版只恢复活动执行目录；旧字段仅供首次导入或连接旧 Server 使用。
  if (settings.lastActiveWorkspace !== undefined) {
    return settings.lastActiveWorkspace ? [settings.lastActiveWorkspace] : [];
  }
  const projectAliases = mergeIdentityAliases([
    buildSourceServerWorkspaceIdentityAliases(settings.sourceServerWorkspaceHistory ?? []),
    buildSourceProfileWorkspaceIdentityAliases(
      settings.sourceServerWorkspaceHistory ?? [],
      settings.connectionProfiles ?? [],
    ),
  ]);
  const conversationAliases = buildSourceConversationWorkspaceIdentityAliases(settings);

  const result: PersistedWorkspaceSessionEntry[] = [];
  const remoteIndexByKey = new Map<string, number>();
  for (const entry of settings.lastWorkspaceSession ?? []) {
    if (entry.kind === "local") {
      result.push(entry);
      continue;
    }
    const currentIdentity = resolveRemoteWorkspaceSessionIdentity(entry);
    const aliasKey = `${entry.workspacePath}\0${currentIdentity}`;
    const projectAlias = projectAliases.get(aliasKey);
    const conversationAlias = conversationAliases.get(aliasKey);
    // project history 与 device conversation map 理论上不会声明同一路径；旧数据若冲突，
    // 保持 legacy identity fail-closed，不能把 workspace 猜到任一 Source。
    const stableAlias =
      projectAlias && conversationAlias && projectAlias !== conversationAlias
        ? undefined
        : (projectAlias ?? conversationAlias);
    const normalized = stableAlias
      ? {
          ...entry,
          workspaceIdentity: stableAlias,
          ...(conversationAlias === stableAlias
            ? { workspacePurpose: "conversation" as const }
            : {}),
        }
      : entry;
    const workspaceKey = buildWorkspaceSessionKey(normalized);
    const existingIndex = remoteIndexByKey.get(workspaceKey);
    if (existingIndex === undefined) {
      remoteIndexByKey.set(workspaceKey, result.length);
      result.push(normalized);
      continue;
    }
    const existing = result[existingIndex];
    if (existing?.kind === "remote" && normalized.lastOpenedAt > existing.lastOpenedAt) {
      result[existingIndex] = {
        ...existing,
        ...normalized,
        localWorkspacePath: normalized.localWorkspacePath ?? existing.localWorkspacePath,
      };
    }
  }
  return result;
}

function buildSourceServerWorkspaceIdentityAliases(
  historyEntries: NonNullable<AppSettings["sourceServerWorkspaceHistory"]>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const history of historyEntries) {
    const legacyIdentity = history.legacyWorkspaceIdentity?.trim();
    const stableIdentity = history.workspaceIdentity?.trim();
    if (legacyIdentity && stableIdentity && legacyIdentity !== stableIdentity) {
      aliases.set(`${history.workspacePath}\0${legacyIdentity}`, stableIdentity);
    }
  }
  return aliases;
}

function buildSourceConversationWorkspaceIdentityAliases(
  settings: Pick<AppSettings, "connectionProfiles" | "remoteConversationWorkspaceBySourceServerId">,
): Map<string, string> {
  const candidatesByAlias = new Map<string, Set<string>>();
  for (const profile of settings.connectionProfiles ?? []) {
    const sourceServerId = profile.sourceServerId?.trim();
    if (!sourceServerId || profile.lifecycleState === "retired") {
      continue;
    }
    const workspacePath =
      settings.remoteConversationWorkspaceBySourceServerId?.[sourceServerId]?.workspacePath;
    if (!workspacePath) continue;

    // Bug 原因：rollback writer 必须为旧 Desktop 写 route identity，但 conversation
    // 按合同不进入 project history，reader 过去没有逆映射来源，重启后只能恢复成 pending tab。
    // 这里同时要求已绑定 Profile 的精确 authority 与设备级 canonical path，且只接受唯一 Source。
    const legacyIdentity = buildRemoteWorkspaceIdentity(workspacePath, profile.target);
    const stableIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: sourceServerId,
      workspacePath,
    });
    const aliasKey = `${workspacePath}\0${legacyIdentity}`;
    const candidates = candidatesByAlias.get(aliasKey) ?? new Set<string>();
    candidates.add(stableIdentity);
    candidatesByAlias.set(aliasKey, candidates);
  }

  const aliases = new Map<string, string>();
  for (const [aliasKey, candidates] of candidatesByAlias) {
    if (candidates.size !== 1) continue;
    const stableIdentity = candidates.values().next().value;
    if (stableIdentity) aliases.set(aliasKey, stableIdentity);
  }
  return aliases;
}

function buildSourceProfileWorkspaceIdentityAliases(
  historyEntries: NonNullable<AppSettings["sourceServerWorkspaceHistory"]>,
  profiles: NonNullable<AppSettings["connectionProfiles"]>,
): Map<string, string> {
  const candidatesByAlias = new Map<string, Set<string>>();
  for (const history of historyEntries) {
    const sourceServerId = history.sourceServerId?.trim();
    if (!sourceServerId) continue;
    const stableIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: sourceServerId,
      workspacePath: history.workspacePath,
    });
    for (const profile of profiles) {
      if (
        profile.lifecycleState === "retired" ||
        profile.sourceServerId?.trim() !== sourceServerId
      ) {
        continue;
      }
      const legacyIdentity = buildRemoteWorkspaceIdentity(history.workspacePath, profile.target);
      if (legacyIdentity === stableIdentity) continue;
      const aliasKey = `${history.workspacePath}\0${legacyIdentity}`;
      const candidates = candidatesByAlias.get(aliasKey) ?? new Set<string>();
      candidates.add(stableIdentity);
      candidatesByAlias.set(aliasKey, candidates);
    }
  }

  const aliases = new Map<string, string>();
  for (const [aliasKey, candidates] of candidatesByAlias) {
    if (candidates.size !== 1) continue;
    const stableIdentity = candidates.values().next().value;
    if (stableIdentity) aliases.set(aliasKey, stableIdentity);
  }
  return aliases;
}

function mergeIdentityAliases(
  aliasMaps: readonly ReadonlyMap<string, string>[],
): Map<string, string> {
  const candidatesByAlias = new Map<string, Set<string>>();
  for (const aliasMap of aliasMaps) {
    for (const [aliasKey, stableIdentity] of aliasMap) {
      const candidates = candidatesByAlias.get(aliasKey) ?? new Set<string>();
      candidates.add(stableIdentity);
      candidatesByAlias.set(aliasKey, candidates);
    }
  }
  const aliases = new Map<string, string>();
  for (const [aliasKey, candidates] of candidatesByAlias) {
    if (candidates.size !== 1) continue;
    const stableIdentity = candidates.values().next().value;
    if (stableIdentity) aliases.set(aliasKey, stableIdentity);
  }
  return aliases;
}

export interface RemoteWorkspaceSessionIdentityRekey {
  workspacePath: string;
  previousWorkspaceIdentity: string;
  workspaceIdentity: string;
}

export function projectRemoteWorkspaceSessionIdentityAliases(
  remoteSessions: readonly RemoteWorkspaceSessionEntry[],
  sourceServerWorkspaceHistoryOrSettings:
    | NonNullable<AppSettings["sourceServerWorkspaceHistory"]>
    | Pick<
        AppSettings,
        | "sourceServerWorkspaceHistory"
        | "connectionProfiles"
        | "remoteConversationWorkspaceBySourceServerId"
      >,
): {
  remoteSessions: RemoteWorkspaceSessionEntry[];
  identityRekeys: RemoteWorkspaceSessionIdentityRekey[];
} {
  const sourceServerWorkspaceHistory = Array.isArray(sourceServerWorkspaceHistoryOrSettings)
    ? sourceServerWorkspaceHistoryOrSettings
    : (sourceServerWorkspaceHistoryOrSettings.sourceServerWorkspaceHistory ?? []);
  const settings: Pick<
    AppSettings,
    | "sourceServerWorkspaceHistory"
    | "connectionProfiles"
    | "remoteConversationWorkspaceBySourceServerId"
  > = Array.isArray(sourceServerWorkspaceHistoryOrSettings)
    ? {}
    : sourceServerWorkspaceHistoryOrSettings;
  const aliases = mergeIdentityAliases([
    buildSourceServerWorkspaceIdentityAliases(sourceServerWorkspaceHistory),
    buildSourceProfileWorkspaceIdentityAliases(
      sourceServerWorkspaceHistory,
      settings.connectionProfiles ?? [],
    ),
    buildSourceConversationWorkspaceIdentityAliases({
      connectionProfiles: settings.connectionProfiles ?? [],
      remoteConversationWorkspaceBySourceServerId:
        settings.remoteConversationWorkspaceBySourceServerId,
    }),
  ]);
  const identityRekeys = remoteSessions.flatMap((entry) => {
    const previousWorkspaceIdentity = resolveRemoteWorkspaceSessionIdentity(entry);
    const workspaceIdentity = aliases.get(`${entry.workspacePath}\0${previousWorkspaceIdentity}`);
    return workspaceIdentity
      ? [
          {
            workspacePath: entry.workspacePath,
            previousWorkspaceIdentity,
            workspaceIdentity,
          },
        ]
      : [];
  });
  const projectedEntries = readPersistedWorkspaceSessionEntries({
    lastWorkspaceSession: [...remoteSessions],
    sourceServerWorkspaceHistory,
    ...(settings.connectionProfiles ? { connectionProfiles: settings.connectionProfiles } : {}),
    ...(settings.remoteConversationWorkspaceBySourceServerId
      ? {
          remoteConversationWorkspaceBySourceServerId:
            settings.remoteConversationWorkspaceBySourceServerId,
        }
      : {}),
  });
  return {
    remoteSessions: projectedEntries.flatMap((entry) => (entry.kind === "remote" ? [entry] : [])),
    identityRekeys,
  };
}

export function getRemoteWorkspaceSessionEntries(
  settings: Pick<
    AppSettings,
    | "lastWorkspaceSession"
    | "sourceServerWorkspaceHistory"
    | "connectionProfiles"
    | "remoteConversationWorkspaceBySourceServerId"
  >,
): RemoteWorkspaceSessionEntry[] {
  return readPersistedWorkspaceSessionEntries(settings).flatMap((entry) =>
    entry.kind === "remote" ? [entry] : [],
  );
}

export function buildRemoteWorkspaceSessionEntryMap(
  entries: readonly RemoteWorkspaceSessionEntry[],
): Map<string, RemoteWorkspaceSessionEntry> {
  return new Map(entries.map((entry) => [buildWorkspaceSessionKey(entry), entry] as const));
}
