import { execFile } from "node:child_process";

/**
 * Linux 关闭驻留托盘能力检测（spec：docs/desktop/linux-close-to-tray.md）。
 *
 * 能力信号是 session DBus 上 org.kde.StatusNotifierWatcher 是否有 owner：
 * KDE/XFCE 原生提供；GNOME 默认移除了托盘，需用户安装 AppIndicator 类扩展。
 * Electron 的 new Tray() 在无 host 的 GNOME 上创建成功但不渲染、不报错（静默失败），
 * 因此驻留开关不能依赖托盘是否创建成功，必须显式探测该 DBus name。
 */

export interface DesktopCloseToTrayCapability {
  /** 关闭驻留托盘是否可用 */
  supported: boolean;
  /** 是否为 GNOME 系桌面且无托盘；仅用于设置页置灰文案追加扩展安装提示 */
  gnomeLikeWithoutTray: boolean;
}

export type TraySupportCommandExecutor = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string }>;

const STATUS_NOTIFIER_WATCHER_NAME = "org.kde.StatusNotifierWatcher";

const defaultExecutor: TraySupportCommandExecutor = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });

/** 依次尝试的探测工具：gdbus（GNOME 系标配）→ busctl（systemd 系标配）→ qdbus（QT 系） */
const probeCommands: ReadonlyArray<{ command: string; args: string[] }> = [
  {
    command: "gdbus",
    args: [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.NameHasOwner",
      STATUS_NOTIFIER_WATCHER_NAME,
    ],
  },
  {
    command: "busctl",
    args: [
      "--user",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "NameHasOwner",
      "s",
      STATUS_NOTIFIER_WATCHER_NAME,
    ],
  },
  {
    command: "qdbus",
    args: [
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.NameHasOwner",
      STATUS_NOTIFIER_WATCHER_NAME,
    ],
  },
];

/**
 * 解析三种工具的 NameHasOwner 输出：
 * gdbus `(true,)` / busctl `b "true"` / qdbus `true`。无法识别返回 null。
 */
export function parseStatusNotifierOwnerOutput(stdout: string): boolean | null {
  const text = stdout.trim();
  // busctl 的布尔输出是不带引号的 `b true` / `b false`（字符串类型才带引号）；
  // 带引号变体一并接受，回退链路必须对实际工具输出保持兼容（CR-01）。
  if (/^\(true,?\)$/.test(text) || /^b\s+"?true"?$/.test(text) || text === "true") {
    return true;
  }
  if (/^\(false,?\)$/.test(text) || /^b\s+"?false"?$/.test(text) || text === "false") {
    return false;
  }
  return null;
}

/** XDG_CURRENT_DESKTOP 含 gnome（不区分大小写）视为 GNOME 系桌面 */
export function isGnomeLikeDesktop(env: NodeJS.ProcessEnv): boolean {
  const desktop = env.XDG_CURRENT_DESKTOP ?? env.XDG_SESSION_DESKTOP ?? "";
  return desktop.toLowerCase().split(/[:;]/).includes("gnome");
}

export async function detectDesktopCloseToTrayCapability(options: {
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execute?: TraySupportCommandExecutor;
  commandTimeoutMs?: number;
}): Promise<DesktopCloseToTrayCapability> {
  const execute = options.execute ?? defaultExecutor;
  const timeoutMs = options.commandTimeoutMs ?? 1500;
  const env = options.env ?? process.env;

  if (options.platform !== "linux") {
    // Windows 托盘始终可用；macOS 不使用托盘（关窗语义由系统 Dock 模型承担）。
    return { supported: true, gnomeLikeWithoutTray: false };
  }

  // 任一工具给出明确结果即返回；全部失败按"不可用"处理（安全默认，绝不失联）。
  for (const probe of probeCommands) {
    try {
      const { stdout } = await execute(probe.command, probe.args, timeoutMs);
      const hasOwner = parseStatusNotifierOwnerOutput(stdout);
      if (hasOwner !== null) {
        return { supported: hasOwner, gnomeLikeWithoutTray: !hasOwner && isGnomeLikeDesktop(env) };
      }
    } catch {
      // 工具缺失/执行失败/超时：尝试下一个
    }
  }
  return { supported: false, gnomeLikeWithoutTray: isGnomeLikeDesktop(env) };
}

/**
 * 关窗分支是同步回调，不能 await 探测；main 进程用本 monitor 维护同步缓存。
 * 刷新时机：app ready 后首次探测、设置页 IPC 查询（stale 则重探）。
 */
export function createCloseToTrayCapabilityMonitor(options: {
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execute?: TraySupportCommandExecutor;
  commandTimeoutMs?: number;
  staleMs?: number;
  now?: () => number;
}) {
  const staleMs = options.staleMs ?? 10_000;
  const now = options.now ?? Date.now;
  let cached: DesktopCloseToTrayCapability | null = null;
  let cachedAt = 0;
  let pending: Promise<DesktopCloseToTrayCapability> | null = null;

  const detect = () =>
    detectDesktopCloseToTrayCapability({
      platform: options.platform,
      env: options.env,
      execute: options.execute,
      commandTimeoutMs: options.commandTimeoutMs,
    });

  return {
    /** 同步缓存；启动后首次探测完成前为 null（调用方按"不可用"安全默认处理） */
    getSync(): DesktopCloseToTrayCapability | null {
      return cached;
    },
    refresh(force = false): Promise<DesktopCloseToTrayCapability> {
      if (!force && cached && now() - cachedAt < staleMs) {
        return Promise.resolve(cached);
      }
      pending ??= detect()
        .then((result) => {
          cached = result;
          cachedAt = now();
          return result;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}

export type CloseToTrayCapabilityMonitor = ReturnType<typeof createCloseToTrayCapabilityMonitor>;

/**
 * 关窗可隐藏能力的最终裁决（CR-01）：DBus watcher 存在只证明"桌面可能有托盘 host"，
 * 不能证明 Electron Tray 实例创建成功（图标缺失、会话未就绪等会让 new Tray() 抛错）。
 * 隐藏窗口前必须验证最终用户入口真实存在，否则违反 spec"不会隐藏后失联"的承诺。
 * - Windows：托盘实例创建成功即可（无 DBus 概念）
 * - Linux：托盘实例创建成功 ∧ DBus 能力探测通过（创建的前提即探测通过，双条件兜底
 *   watcher 中途下线的极端场景）
 * - 其它平台：不可隐藏（darwin 走系统默认，不进此分支）
 */
export function resolveCloseToTraySupported(input: {
  platform: NodeJS.Platform;
  desktopTrayReady: boolean;
  capabilitySupported: boolean | undefined;
}): boolean {
  if (input.platform === "win32") {
    return input.desktopTrayReady;
  }
  if (input.platform === "linux") {
    return input.desktopTrayReady && input.capabilitySupported === true;
  }
  return false;
}

/**
 * Linux 默认值归位（spec：设置项一节）。
 * shared 的 migrateCloseToTrayOnWindowsDefault 无平台概念，存量 Linux 用户已被归位为 true；
 * 但 Linux 此前没有设置入口，存量 true 不可能是用户显式选择，首次启动强制归位为默认关。
 */
export function resolveCloseToTrayBootstrapValue(input: {
  platform: NodeJS.Platform;
  stored: boolean | undefined;
  linuxMigrationInitialized: boolean | undefined;
}): { value: boolean; needsLinuxMigration: boolean } {
  if (input.platform !== "linux") {
    return { value: input.stored ?? true, needsLinuxMigration: false };
  }
  if (input.linuxMigrationInitialized !== true) {
    return { value: false, needsLinuxMigration: true };
  }
  return { value: input.stored ?? false, needsLinuxMigration: false };
}

/**
 * 迁移持久化失败后的运行时值裁决（CR-02）：持久层不可写（磁盘满/只读等）时，
 * 内存值回退为持久化文件的当前值，维持"文件是唯一可信来源"——否则 main 按 false
 * 处理而设置页读到文件里的 true，重新形成双数据源。迁移在下次启动重试；
 * 失败期间 Linux 用户保持旧行为（迁移未完成态），可接受。
 */
export function resolveCloseToTrayRuntimeValue(input: {
  platform: NodeJS.Platform;
  stored: boolean | undefined;
  linuxMigrationInitialized: boolean | undefined;
  migrationPersisted: boolean;
}): boolean {
  const bootstrap = resolveCloseToTrayBootstrapValue(input);
  if (bootstrap.needsLinuxMigration && !input.migrationPersisted) {
    return input.stored ?? true;
  }
  return bootstrap.value;
}
