import type {
  ConnectionProfile,
  RemoteAssetInstallMode,
  RemoteTarget,
  SourceServerManagementSnapshot,
} from "@zcode/shared";
import { isValidWslUser, normalizeRemoteResourcePackageSelection } from "@zcode/shared";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

type WizardIntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

export interface RemoteConnectionFormSnapshot {
  kind: RemoteTarget["kind"];
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode?: RemoteAssetInstallMode;
  selectedSshConfigAlias?: string | null;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslDistro: string;
  wslUser?: string;
  dockerContainer: string;
  manualDockerContainer?: string;
  serverUrl?: string;
  serverName?: string;
  serverToken?: string;
  serverWorkspacePath?: string;
}

export function getRemoteWizardStepCopy(
  intl: WizardIntlLike,
  step: RemoteWizardStep,
  kind: RemoteTarget["kind"],
  context?: {
    /** 线路名（SSH alias / 线路 displayName），缺省回退 user@host:port 由调用方拼好传入。 */
    lineName?: string;
    /** 已识别设备名，用于第 4 步成功副题与第 5 步「在 {device} 上选择目录」。 */
    deviceName?: string;
    connectionReady?: boolean;
    hasError?: boolean;
    updating?: boolean;
    cancelled?: boolean;
  },
) {
  switch (step) {
    case "device":
      return {
        title: intl.formatMessage({ id: "remote.deviceStepTitle" }),
        description: intl.formatMessage({ id: "remote.deviceStepDescription" }),
      };
    case "settings":
      // 表单屏不再显示说明句，头部改为实时目标预览（RDUX-27）。
      return {
        title: intl.formatMessage({ id: "remote.settingsStepTitle" }),
        description: "",
      };
    case "connecting": {
      // 需升级错误保留供取消后恢复；更新期间优先展示当前操作，避免沿用旧失败副题。
      const description = context?.cancelled
        ? intl.formatMessage({ id: "remote.connectionCancelled" })
        : context?.updating
          ? intl.formatMessage({ id: "remote.connectingSubtitleUpdating" })
          : context?.hasError
            ? intl.formatMessage({ id: "remote.connectingSubtitleFailed" })
            : context?.connectionReady
              ? intl.formatMessage(
                  { id: "remote.connectingSubtitleConnected" },
                  {
                    device:
                      context.deviceName ??
                      context.lineName ??
                      intl.formatMessage({ id: `remote.kind.${kind}` }),
                  },
                )
              : intl.formatMessage(
                  { id: "remote.connectingStepDescription" },
                  {
                    method: context?.lineName ?? intl.formatMessage({ id: `remote.kind.${kind}` }),
                  },
                );
      return {
        title: intl.formatMessage({ id: "remote.connectingStepTitle" }),
        description,
      };
    }
    case "directory":
      return {
        title: intl.formatMessage({ id: "remote.selectDirectoryTitle" }),
        description: intl.formatMessage(
          { id: "remote.selectDirectoryDescription" },
          {
            // 原型副题是「在 dev 上选择一个目录作为工作区」——传设备名而非连接方式名。
            method:
              context?.deviceName ??
              context?.lineName ??
              intl.formatMessage({ id: `remote.kind.${kind}` }),
          },
        ),
      };
  }
}

export function findPreferredSourceConnectionProfile(
  snapshot: Pick<SourceServerManagementSnapshot, "servers" | "profiles">,
  sourceServerId: string,
): ConnectionProfile | undefined {
  const server = snapshot.servers.find((candidate) => candidate.sourceServerId === sourceServerId);
  if (!server) return undefined;

  const activeProfiles = snapshot.profiles.filter(
    (profile) => profile.sourceServerId === sourceServerId && profile.lifecycleState !== "retired",
  );
  return (
    activeProfiles.find((profile) => profile.profileId === server.preferredProfileId) ??
    activeProfiles[0]
  );
}

/** 表单内可显示内联错误的字段；顺序即页面从上到下的顺序。 */
export type RemoteFormField =
  | "host"
  | "port"
  | "username"
  | "password"
  | "privateKey"
  | "docker"
  | "wslUser"
  | "serverUrl";

export interface RemoteFormFieldError {
  field: RemoteFormField;
  message: string;
}

function isInvalidPort(port: string): boolean {
  return Boolean(port) && (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535);
}

/**
 * 表单校验的唯一规则来源：按页面顺序返回全部字段错误。
 * 新建向导与编辑连接弹窗都用它渲染内联错误，buildRemoteTarget 只取第一条阻止提交。
 */
export function collectRemoteFormFieldErrors(
  intl: WizardIntlLike,
  snapshot: RemoteConnectionFormSnapshot,
  options: {
    /** 编辑已保存密码的连接时，空密码表示沿用已保存凭据。 */
    passwordOptional?: boolean;
  } = {},
): RemoteFormFieldError[] {
  const errors: RemoteFormFieldError[] = [];
  const add = (field: RemoteFormField, id: string) =>
    errors.push({ field, message: intl.formatMessage({ id }) });
  switch (snapshot.kind) {
    case "ssh":
      if (!snapshot.host.trim()) add("host", "ssh.validation.hostRequired");
      if (isInvalidPort(snapshot.port.trim())) add("port", "ssh.validation.port");
      if (!snapshot.username.trim()) add("username", "ssh.validation.usernameRequired");
      if (
        snapshot.sshAuthMethod === "password" &&
        !snapshot.password &&
        !options.passwordOptional
      ) {
        add("password", "ssh.validation.passwordRequired");
      }
      if (snapshot.sshAuthMethod === "privateKey" && !snapshot.privateKeyPath.trim()) {
        add("privateKey", "ssh.validation.privateKeyRequired");
      }
      break;
    case "docker":
      if (!(snapshot.manualDockerContainer?.trim() || snapshot.dockerContainer.trim())) {
        add("docker", "docker.validation.required");
      }
      break;
    case "wsl": {
      const wslUser = snapshot.wslUser?.trim();
      if (wslUser && !isValidWslUser(wslUser)) add("wslUser", "wsl.validation.invalidUser");
      break;
    }
    case "server": {
      const url = snapshot.serverUrl?.trim() ?? "";
      if (!url) {
        add("serverUrl", "server.validation.urlRequired");
      } else {
        try {
          new URL(url);
        } catch {
          add("serverUrl", "server.validation.invalidUrl");
        }
      }
      break;
    }
  }
  return errors;
}

/** 表单头部的实时目标预览，与连接页头部的等宽目标同构；缺少关键字段时返回 null。 */
export function formatRemoteDraftPreview(snapshot: RemoteConnectionFormSnapshot): string | null {
  switch (snapshot.kind) {
    case "ssh": {
      const host = snapshot.host.trim();
      if (!host) return null;
      return `${snapshot.username.trim() || "user"}@${host}:${snapshot.port.trim() || 22}`;
    }
    case "docker":
      return snapshot.manualDockerContainer?.trim() || snapshot.dockerContainer.trim() || null;
    case "wsl":
      return snapshot.wslDistro.trim() || null;
    case "server":
      return snapshot.serverUrl?.trim() || null;
  }
}

export function buildRemoteTarget(
  intl: WizardIntlLike,
  snapshot: RemoteConnectionFormSnapshot,
): { target?: RemoteTarget; errorMessage?: string } {
  const [firstError] = collectRemoteFormFieldErrors(intl, snapshot);
  if (firstError) return { errorMessage: firstError.message };
  switch (snapshot.kind) {
    case "ssh": {
      const sshConfigAlias = snapshot.selectedSshConfigAlias?.trim();
      // Bugfix: 校验读 trim 后的端口，这里曾读原值，只填空格时校验放行而 Number("   ") 得到 0，
      // 请求被主进程 schema 拒绝。构造与校验读取同一个 trim 值，空白等同未填写（默认 22）。
      const port = snapshot.port.trim();

      return {
        target: {
          kind: "ssh",
          host: snapshot.host.trim(),
          port: port ? Number(port) : undefined,
          username: snapshot.username.trim(),
          ...(sshConfigAlias ? { sshConfigAlias } : {}),
          assetInstallMode: snapshot.assetInstallMode,
          ...(snapshot.sshAuthMethod === "password" && snapshot.password
            ? { password: snapshot.password }
            : {}),
          ...(snapshot.sshAuthMethod === "privateKey" && snapshot.privateKeyPath
            ? { privateKeyPath: snapshot.privateKeyPath }
            : {}),
          ...(snapshot.sshAuthMethod === "privateKey" && snapshot.privateKeyPassphrase
            ? { privateKeyPassphrase: snapshot.privateKeyPassphrase }
            : {}),
        },
      };
    }
    case "docker": {
      // Docker 运行中列表可能因为探测失败或刷新延迟不完整。
      // 手动输入必须独立于下拉选择，提交时优先使用手动输入，空值再回落到下拉选择。
      const dockerContainer =
        snapshot.manualDockerContainer?.trim() || snapshot.dockerContainer.trim();

      return {
        target: {
          kind: "docker",
          container: dockerContainer,
        },
      };
    }
    case "wsl": {
      const wslUser = snapshot.wslUser?.trim();
      return {
        target: {
          kind: "wsl",
          distro: snapshot.wslDistro || undefined,
          ...(wslUser ? { user: wslUser } : {}),
        },
      };
    }
    case "server": {
      const url = snapshot.serverUrl?.trim() ?? "";
      const name = snapshot.serverName?.trim();
      const token = snapshot.serverToken?.trim();
      const workspacePath = snapshot.serverWorkspacePath?.trim();

      return {
        target: {
          kind: "server",
          url,
          ...(name ? { name } : {}),
          ...(token ? { token } : {}),
          ...(workspacePath ? { workspacePath } : {}),
        },
      };
    }
  }
}

export function withDefaultRemoteResourcePackages(target: RemoteTarget): RemoteTarget {
  if (target.kind !== "ssh") {
    return target;
  }

  return {
    ...target,
    resourcePackages: {
      // 当前分支只保留一个 ZCode Agent，SSH 向导再让用户手动挑资源包会产生无意义分叉。
      // 这里统一走默认 active 资源集，历史重连传入的旧选择不再影响部署范围。
      selectedPackageIds: normalizeRemoteResourcePackageSelection(),
    },
  };
}

/** 将已保存线路转换成不含凭据的连接目标，凭据仍由 Host Directory 权威解析。 */
export function buildRemoteTargetFromProfile(
  profile: ConnectionProfile,
): Exclude<RemoteTarget, { kind: "server" }> {
  switch (profile.target.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: profile.target.host,
        ...(profile.target.port ? { port: profile.target.port } : {}),
        username: profile.target.username,
        ...(profile.target.sshConfigAlias ? { sshConfigAlias: profile.target.sshConfigAlias } : {}),
        ...(profile.target.privateKeyPath ? { privateKeyPath: profile.target.privateKeyPath } : {}),
        ...(profile.target.assetInstallMode
          ? { assetInstallMode: profile.target.assetInstallMode }
          : {}),
      };
    case "wsl":
      return {
        kind: "wsl",
        ...(profile.target.distro ? { distro: profile.target.distro } : {}),
        ...(profile.target.user ? { user: profile.target.user } : {}),
      };
    case "docker":
      return { kind: "docker", container: profile.target.container };
  }
}

export function profileMatchesRemoteTarget(
  profile: ConnectionProfile,
  target: Exclude<RemoteTarget, { kind: "server" }>,
): boolean {
  if (profile.target.kind !== target.kind) return false;
  switch (target.kind) {
    case "ssh":
      return (
        profile.target.kind === "ssh" &&
        profile.target.host === target.host &&
        (profile.target.port ?? 22) === (target.port ?? 22) &&
        profile.target.username === target.username &&
        (profile.target.sshConfigAlias?.trim() ?? "") === (target.sshConfigAlias?.trim() ?? "")
      );
    case "wsl":
      return (
        profile.target.kind === "wsl" &&
        (profile.target.distro?.trim() ?? "") === (target.distro?.trim() ?? "") &&
        (profile.target.user?.trim() ?? "") === (target.user?.trim() ?? "")
      );
    case "docker":
      return profile.target.kind === "docker" && profile.target.container === target.container;
  }
}

export function findSourceServerUpgradeProfileId(
  snapshot: SourceServerManagementSnapshot,
  target: Exclude<RemoteTarget, { kind: "server" }>,
  failedProfileId?: string,
): string | null {
  const requiredByProfileId = new Map(
    snapshot.states
      .filter(
        (state) =>
          state.state === "needs-upgrade" &&
          state.upgradeTarget === "server" &&
          state.updateAvailability === "required",
      )
      .map((state) => [state.profileId, state.updatedAt]),
  );
  return (
    snapshot.profiles
      .filter(
        (profile) =>
          (!failedProfileId || profile.profileId === failedProfileId) &&
          profile.lifecycleState !== "retired" &&
          requiredByProfileId.has(profile.profileId) &&
          profileMatchesRemoteTarget(profile, target),
      )
      .toSorted(
        (left, right) =>
          (requiredByProfileId.get(right.profileId) ?? 0) -
          (requiredByProfileId.get(left.profileId) ?? 0),
      )[0]?.profileId ?? null
  );
}

/** 从主机框粘贴的文本中拆出的 SSH 目标；缺省字段由用户继续填写。 */
export interface SshPasteTarget {
  host: string;
  username?: string;
  port?: string;
}

function parsePort(value: string | undefined): string | undefined | null {
  if (value == null) return undefined;
  if (!/^\d+$/u.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? String(port) : null;
}

function parseUserHostPort(value: string): SshPasteTarget | null {
  // Bugfix: 用户名曾允许 ":" 和 "/"，`ssh://user@host` 会拆出用户名 `ssh://user`，
  // `user:password@host` 会把密码填进用户名。这两类不在识别范围内，用户名排除这两个字符后原样粘贴。
  const match = /^(?:([^@\s:/]+)@)?(\[[^\]\s]+\]|[^:@\s[\]/]+)(?::([^:\s]+))?$/u.exec(value);
  if (!match) return null;
  const [, username, rawHost = "", rawPort] = match;
  const port = parsePort(rawPort);
  if (port === null) return null;
  const host = rawHost.startsWith("[") ? rawHost.slice(1, -1) : rawHost;
  return {
    host,
    ...(username ? { username } : {}),
    ...(port ? { port } : {}),
  };
}

/**
 * 只识别 `user@host`、`user@host:port`、`ssh [-p N] user@host [-p N]`（含 `[IPv6]:port`）。
 * 其他内容返回 null，由调用方交给浏览器原样粘贴；纯主机名没有可拆分的信息，同样返回 null。
 */
export function parseSshPasteTarget(text: string): SshPasteTarget | null {
  const trimmed = text.trim();
  const sshMatch = /^ssh\s+(.+)$/u.exec(trimmed);
  if (sshMatch) {
    const tokens = sshMatch[1]!.split(/\s+/u);
    let target: string | undefined;
    let portToken: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token === "-p") {
        portToken = tokens[index + 1];
        if (portToken == null) return null;
        index += 1;
      } else if (token.startsWith("-") || target) {
        // 其他 ssh 选项可能改变目标语义（例如 -i、-J），不猜测，原样粘贴。
        return null;
      } else {
        target = token;
      }
    }
    if (!target) return null;
    const parsed = parseUserHostPort(target);
    const port = parsePort(portToken);
    if (!parsed || port === null) return null;
    return port ? { ...parsed, port } : parsed;
  }
  const parsed = parseUserHostPort(trimmed);
  if (!parsed || (!parsed.username && !parsed.port)) return null;
  return parsed;
}
