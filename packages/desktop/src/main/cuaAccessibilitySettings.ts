/* eslint-disable max-lines -- 安装验签、main 级权限会话和拖拽 TOCTOU 共同维护同一 Helper identity */
// 授权引导不触发任何 macOS 原生权限弹窗。若每个 TCC stage 先经 LaunchServices
// 拉起 Helper 到一次性权限请求模式，由 Helper 进程内命中 AXIsProcessTrustedWithOptions{prompt:true}
// / CGRequestScreenCaptureAccess 来让自己“自动出现在权限列表里”，代价是一个打断用户的系统对话框。
// 只打开对应设置页，Helper 进入 TCC 列表由用户从浮窗把 .app 拖进列表完成
// （实测拖入后 auth_value 直接为 2，比弹窗少一步——弹窗只创建条目，仍需用户自己找到并勾选）。
// 每 stage 的验签指纹不再交给 open(2) 前的终检，而是登记到会话上，由 dragstart 前的同步比对消费。
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { shell } from "electron";
import type { CuaHelperInstallerOptions } from "@zcode/services/node";
import {
  resolveHelperPermissionSubjectIdentity,
  type HelperPermissionSubjectIdentity,
} from "@zcode/services/cua-permission-broker";
import type {
  CuaAccessibilitySettingsResult,
  CuaPermissionKind,
  PrepareCuaHelperPermissionDragResult,
} from "@zcode/shared";
import { createDesktopCuaHelperInstaller } from "./desktopCuaHelperInstaller.js";

export const MACOS_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
export const MACOS_SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export interface OpenCuaAccessibilitySettingsOptions {
  initialPermission?: CuaPermissionKind;
  requiredPermissions?: CuaPermissionKind[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** main IPC 注入的 renderer/webContents 身份；同一 host 的重复 join 只授予一次 recovery。 */
  participantKey?: string;
  sessionTimeoutMs?: number;
  settingsReturnTimeoutMs?: number;
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  ensureHelperInstalled?: () => Promise<string>;
  /** 测试或宿主显式注入；生产默认从 Electron Resources 解析随包 Helper。 */
  bundledHelperAppPath?: string;
  /** 每个 TCC stage 启动前重新执行完整安装验签；生产默认使用 installer.verifyInstalled。 */
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
  openSettingsUrl?: (url: string) => Promise<void>;
  /**
   * 必须先注册 return 信号，再调用 openSettings，避免 System Settings 切走/返回发生在监听器空窗。
   * IPC 生产适配器监听 Electron app/browser-window；纯单测可立即执行 openSettings 并返回。
   */
  openSettingsAndWaitForReturn?: (options: {
    permission: CuaPermissionKind;
    sessionId: string;
    timeoutMs: number;
    signal: AbortSignal;
    openSettings: () => Promise<void>;
  }) => Promise<void>;
}

// 这里只限制“系统设置是否成功出现”的机器阶段；一旦确认设置页在前台，用户勾选权限不再受墙钟
// 倒计时约束，只由 surface cancel、origin destroyed 或 app quit 结束。
const DEFAULT_SETTINGS_RETURN_TIMEOUT_MS = 2 * 60_000;
// 旧拖拽引导把屏幕录制排在前面，与用户看到的权限列表顺序相反；
// 两项同时缺失时统一先处理辅助功能，再处理屏幕录制。
const PERMISSION_STAGE_ORDER: readonly CuaPermissionKind[] = ["accessibility", "screen_recording"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 拖拽 TOCTOU 门：prepare 时验过的 .app，可能在用户拖入系统设置前被同 UID 攻击者覆写，
// 而 TCC 绑定的是被拖入的 bundle 身份。拖拽当下必须有"自校验以来字节未变"的*同步*证据——但对 120MB
// bundle 跑 codesign 太慢会错过 dragstart 手势。改用轻量字节指纹：关键文件的 ino/ctime/size（ctime 是
// inode change time，用户态无法回拨），任何对 Mach-O / 签名清单 / Info.plist 的替换都会改变指纹。prepare
// 时抓一次，dragstart 前同步比对，不符即拒拖 + 清缓存重新 prepare。残留仅剩比对与 startDrag 之间的
// 微秒级窗口（与 launch 路径 verifyInstalled→launch 同源、同量级）。
export type CuaHelperBundleFingerprint = string;

function statSignature(path: string): string {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.ino}:${st.ctimeNs}:${st.size}`;
  } catch {
    return "MISSING";
  }
}

function bundleTreeFingerprint(root: string, maxEntries = 512): string {
  const pending: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: root, relativePath: "." },
  ];
  const parts: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (parts.length >= maxEntries) return `${parts.join(",")},TOO_MANY`;
    parts.push(`${current.relativePath}:${statSignature(current.absolutePath)}`);
    let children: string[];
    try {
      children = readdirSync(current.absolutePath).sort();
    } catch {
      continue;
    }
    for (const child of children) {
      pending.push({
        absolutePath: join(current.absolutePath, child),
        relativePath: `${current.relativePath}/${child}`,
      });
    }
  }
  return parts.join(",");
}

export function captureCuaHelperBundleFingerprint(appPath: string): CuaHelperBundleFingerprint {
  const parts = [
    `app=${statSignature(appPath)}`,
    `sig=${statSignature(join(appPath, "Contents", "_CodeSignature", "CodeResources"))}`,
    `info=${statSignature(join(appPath, "Contents", "Info.plist"))}`,
    // ax_macos.node 与随 SEA 分发的 runtime dylib 都位于 Resources。只采 CodeResources 的 stat
    // 无法发现对资源文件的原地覆写；递归采 inode/ctime/size 才能在 dragstart 同步拒绝这种 TOCTOU。
    `resources=${bundleTreeFingerprint(join(appPath, "Contents", "Resources"))}`,
  ];
  try {
    const macosDir = join(appPath, "Contents", "MacOS");
    const entries = readdirSync(macosDir).sort();
    parts.push(
      `macos=${entries.map((entry) => `${entry}:${statSignature(join(macosDir, entry))}`).join(",")}`,
    );
  } catch {
    parts.push("macos=MISSING");
  }
  return parts.join("|");
}

export function cuaHelperBundleFingerprintUnchanged(
  appPath: string,
  fingerprint: CuaHelperBundleFingerprint,
): boolean {
  return captureCuaHelperBundleFingerprint(appPath) === fingerprint;
}

function normalizePermission(value: unknown): CuaPermissionKind {
  return value === "screen_recording" ? "screen_recording" : "accessibility";
}

function normalizeRequiredPermissions(
  options: OpenCuaAccessibilitySettingsOptions,
): CuaPermissionKind[] {
  const requested = Array.isArray(options.requiredPermissions)
    ? options.requiredPermissions
    : [normalizePermission(options.initialPermission)];
  const requestedSet = new Set(
    requested.filter(
      (permission): permission is CuaPermissionKind =>
        permission === "screen_recording" || permission === "accessibility",
    ),
  );
  return PERMISSION_STAGE_ORDER.filter((permission) => requestedSet.has(permission));
}

function settingsUrlForPermission(permission: CuaPermissionKind): string {
  return permission === "screen_recording"
    ? MACOS_SCREEN_RECORDING_SETTINGS_URL
    : MACOS_ACCESSIBILITY_SETTINGS_URL;
}

function sameHelperPermissionIdentity(
  expected: HelperPermissionSubjectIdentity,
  actual: HelperPermissionSubjectIdentity,
): boolean {
  return (
    expected.appPath === actual.appPath &&
    expected.executablePath === actual.executablePath &&
    expected.displayName === actual.displayName &&
    expected.bundleId === actual.bundleId
  );
}

async function verifyHelperPermissionIdentityUnchanged(
  identity: HelperPermissionSubjectIdentity,
  options: OpenCuaAccessibilitySettingsOptions,
  phase: "launch" | "post-settings",
): Promise<CuaHelperBundleFingerprint> {
  const fingerprint = captureCuaHelperBundleFingerprint(identity.appPath);
  await options.verifyHelperInstalled?.(identity.appPath);
  if (!cuaHelperBundleFingerprintUnchanged(identity.appPath, fingerprint)) {
    throw new Error(`ZCode Computer Use changed while its ${phase} signature was being verified`);
  }
  const currentIdentity = await (
    options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
  )(identity.appPath);
  if (!sameHelperPermissionIdentity(identity, currentIdentity)) {
    throw new Error(`ZCode Computer Use permission identity changed during ${phase} verification`);
  }
  if (!cuaHelperBundleFingerprintUnchanged(identity.appPath, fingerprint)) {
    throw new Error(
      `ZCode Computer Use changed while its ${phase} permission identity was being resolved`,
    );
  }
  return fingerprint;
}

type CuaHelperInstallerLogger = NonNullable<CuaHelperInstallerOptions["logger"]>;

function toInstallerLogger(
  logger: OpenCuaAccessibilitySettingsOptions["logger"],
): CuaHelperInstallerLogger | undefined {
  if (!logger) return undefined;
  return {
    debug: (_traceId, ...args) => logger.debug?.(...args),
    info: (_traceId, ...args) => (logger.info ?? logger.warn)(...args),
    warn: (_traceId, ...args) => logger.warn(...args),
    error: (_traceId, ...args) => (logger.error ?? logger.warn)(...args),
  };
}

interface ActiveOnboardingSession {
  identity: HelperPermissionSubjectIdentity;
  sessionId: string;
  controller: AbortController;
  activeParticipants: Set<number>;
  requiredPermissions: Set<CuaPermissionKind>;
  processedPermissions: Set<CuaPermissionKind>;
  openedPermissions: CuaPermissionKind[];
  acceptingRequirements: boolean;
  recoveryOwnerParticipantKeys: Set<string>;
  /**
   * 每个 stage 重新建立的验签指纹证据，由 dragstart 前的同步比对消费
   * （拖入的 bundle 才是 TCC 绑定对象）。
   */
  launchFingerprint?: CuaHelperBundleFingerprint;
  promise?: Promise<CuaAccessibilitySettingsResult>;
}

/**
 * main-process 级协调器。key 使用 Helper 的精确授权身份而不是 renderer/window/workspace：macOS TCC
 * 只认这个授权主体，同一主体并发弹两组 native prompt 会互相抢焦点并产生不可恢复的中间态。
 */
class CuaPermissionOnboardingCoordinator {
  private readonly sessions = new Map<string, ActiveOnboardingSession>();
  private nextParticipantId = 0;

  constructor(private readonly createSessionId: () => string = randomUUID) {}

  run(
    identity: HelperPermissionSubjectIdentity,
    requiredPermissions: CuaPermissionKind[],
    options: OpenCuaAccessibilitySettingsOptions,
  ): Promise<CuaAccessibilitySettingsResult> {
    // bundle id + displayName 不是“精确 Helper 身份”。开发/升级窗口内，两份不同路径或
    // executable 的 bundle 可以共享这两个字符串；若错误合并会话，后加入窗口会把权限结果和恢复权
    // 绑定到第一份 app。协调 key 覆盖验签后 identity 的全部不可变字段，任何路径/可执行体变化都隔离。
    const identityKey = [
      identity.bundleId,
      identity.displayName,
      identity.appPath,
      identity.executablePath,
    ].join("\0");
    const existing = this.sessions.get(identityKey);
    if (existing?.promise) {
      if (existing.acceptingRequirements) {
        for (const permission of requiredPermissions) {
          existing.requiredPermissions.add(permission);
        }
        options.logger?.info?.(
          "[cua-permission-onboarding] joined active Helper permission session",
          existing.sessionId,
          identity.bundleId,
        );
        return this.joinSession(existing, options.signal, options.participantKey);
      }
      // 上一会话已进入终态，但精确权限 Helper 的异步清理尚未完成。必须等 identity key 真正释放后
      // 再重试，不能让新会话与迟到的 LaunchServices 实例交叠。
      return existing.promise.then(() => {
        if (options.signal?.aborted) {
          return this.canceledParticipantResult(existing, options.signal.reason);
        }
        return this.run(identity, requiredPermissions, options);
      });
    }

    const session: ActiveOnboardingSession = {
      identity,
      sessionId: this.createSessionId(),
      controller: new AbortController(),
      activeParticipants: new Set(),
      requiredPermissions: new Set(requiredPermissions),
      processedPermissions: new Set(),
      openedPermissions: [],
      acceptingRequirements: true,
      recoveryOwnerParticipantKeys: new Set(),
    };
    const promise = this.runSession(session, options).finally(() => {
      if (this.sessions.get(identityKey) === session) {
        this.sessions.delete(identityKey);
      }
    });
    session.promise = promise;
    this.sessions.set(identityKey, session);
    return this.joinSession(session, options.signal, options.participantKey);
  }

  private joinSession(
    session: ActiveOnboardingSession,
    signal?: AbortSignal,
    participantKey?: string,
  ): Promise<CuaAccessibilitySettingsResult> {
    this.nextParticipantId += 1;
    const participantId = this.nextParticipantId;
    const recoveryParticipantKey = participantKey?.trim() || `participant:${participantId}`;
    session.activeParticipants.add(participantId);

    return new Promise<CuaAccessibilitySettingsResult>((resolve) => {
      let active = true;
      const detach = () => {
        signal?.removeEventListener("abort", onAbort);
        session.activeParticipants.delete(participantId);
      };
      const onAbort = () => {
        if (!active) return;
        active = false;
        detach();
        resolve(this.canceledParticipantResult(session, signal?.reason));
        if (session.activeParticipants.size === 0 && !session.controller.signal.aborted) {
          // 共享会话不能归首个 caller signal 独占。任一窗口关闭只移除自身；最后一个参与者
          // 离开才取消 native flow，并先关闭 requirement join 门，后来的显式重试会等待精确 cleanup。
          session.acceptingRequirements = false;
          session.controller.abort(
            signal?.reason ?? new Error("all CUA permission onboarding windows closed"),
          );
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      void session.promise!.then((result) => {
        if (!active) return;
        active = false;
        detach();
        const returned =
          result.success === true &&
          result.returnedFromSettings === true &&
          typeof result.sessionId === "string";
        // Promise continuation 在 main event loop 内串行执行。同一 renderer/webContents 的重复调用只
        // 有一个取得恢复权；不同窗口各有独立 host/Helper，必须各自得到一次恢复权，不能全局去重。
        const ownsRecovery =
          returned && !session.recoveryOwnerParticipantKeys.has(recoveryParticipantKey);
        if (ownsRecovery) session.recoveryOwnerParticipantKeys.add(recoveryParticipantKey);
        resolve({
          ...result,
          ...(returned ? { restartHelperAfterReturn: ownsRecovery } : {}),
        });
      });
    });
  }

  private canceledParticipantResult(
    session: ActiveOnboardingSession,
    reason: unknown,
  ): CuaAccessibilitySettingsResult {
    return {
      success: false,
      canceled: true,
      sessionId: session.sessionId,
      returnedFromSettings: false,
      error: `permission onboarding canceled: ${messageOf(
        reason ?? new Error("origin window closed"),
      )}`,
    };
  }

  private async runSession(
    session: ActiveOnboardingSession,
    options: OpenCuaAccessibilitySettingsOptions,
  ): Promise<CuaAccessibilitySettingsResult> {
    const configuredSessionTimeoutMs = options.sessionTimeoutMs;
    const sessionTimeoutMs =
      typeof configuredSessionTimeoutMs === "number" && Number.isFinite(configuredSessionTimeoutMs)
        ? Math.max(1, configuredSessionTimeoutMs)
        : null;
    const startedAt = Date.now();
    const controller = session.controller;
    const sessionTimer =
      sessionTimeoutMs === null
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new Error(`CUA permission onboarding session exceeded ${sessionTimeoutMs}ms`),
              ),
            sessionTimeoutMs,
          );
    let returnedCount = 0;

    try {
      while (true) {
        const permission = PERMISSION_STAGE_ORDER.find(
          (candidate) =>
            session.requiredPermissions.has(candidate) &&
            !session.processedPermissions.has(candidate),
        );
        if (!permission) {
          // 最后一页返回后的 identity 终检仍会 await；若 join 门保持开启，新权限会在
          // while 已结束后被静默并入并收到假 success。同步关闭 join 门，让后来请求等 cleanup 后新开会话。
          session.acceptingRequirements = false;
          break;
        }
        session.processedPermissions.add(permission);
        const remainingMs =
          sessionTimeoutMs === null
            ? Number.POSITIVE_INFINITY
            : sessionTimeoutMs - (Date.now() - startedAt);
        if (Number.isFinite(remainingMs) && remainingMs <= 0) {
          controller.abort(new Error("CUA permission onboarding session timed out"));
          throw controller.signal.reason;
        }
        // 首次 ensureInstalled 的验签证据不能跨越用户停留设置页的时间复用。同 UID 进程可在
        // 下一 stage 前替换安装目录，导致授权落到另一 bundle。每一 stage 都以“指纹前快照 → 完整
        // verify → 精确 identity 复核 → 指纹后快照”的顺序重新建立证据；任一处变化都 fail-closed。
        //
        // 终检在 dragstart 前同步比对：Helper 进入 TCC 列表靠用户拖拽，
        // 而 TCC 绑定的正是被拖入的那个 bundle，所以「拖之前字节没变」贴近
        // 真实风险。指纹登记到会话上供拖拽缓存消费（见 desktopCuaPermissionIpc）。
        session.launchFingerprint = await verifyHelperPermissionIdentityUnchanged(
          session.identity,
          options,
          "launch",
        );
        if (controller.signal.aborted) throw controller.signal.reason;

        const openSettingsUrl =
          options.openSettingsUrl ?? ((url: string) => shell.openExternal(url));
        const openSettings = async () => {
          await openSettingsUrl(settingsUrlForPermission(permission));
          if (!session.openedPermissions.includes(permission)) {
            session.openedPermissions.push(permission);
          }
        };
        const returnTimeoutMs = Math.min(
          options.settingsReturnTimeoutMs ?? DEFAULT_SETTINGS_RETURN_TIMEOUT_MS,
          sessionTimeoutMs === null
            ? Number.POSITIVE_INFINITY
            : Math.max(1, sessionTimeoutMs - (Date.now() - startedAt)),
        );
        if (options.openSettingsAndWaitForReturn) {
          await options.openSettingsAndWaitForReturn({
            permission,
            sessionId: session.sessionId,
            timeoutMs: returnTimeoutMs,
            signal: controller.signal,
            openSettings,
          });
          if (controller.signal.aborted) throw controller.signal.reason;
          returnedCount += 1;
        } else {
          // 旧接口没有 main return signal：保留“打开设置页”的兼容行为，但绝不能伪造 return=true。
          await openSettings();
          if (controller.signal.aborted) throw controller.signal.reason;
        }
      }

      // 最后一页返回与 restart 之间仍可能发生 Helper 升级/替换。IPC 后台刷新拖拽缓存不属于本次
      // 授权证据；必须在 success 前重新验签并绑定同一 identity，变化时 fail-closed、不发恢复权。
      if (session.openedPermissions.length > 0) {
        await verifyHelperPermissionIdentityUnchanged(session.identity, options, "post-settings");
        if (controller.signal.aborted) throw controller.signal.reason;
      }
      return {
        success: true,
        sessionId: session.sessionId,
        returnedFromSettings:
          session.openedPermissions.length > 0 &&
          returnedCount === session.openedPermissions.length,
        error: undefined,
      };
    } catch (error) {
      session.acceptingRequirements = false;
      return {
        success: false,
        canceled: controller.signal.aborted || undefined,
        sessionId: session.sessionId,
        returnedFromSettings: false,
        error: `permission onboarding failed: ${messageOf(error)}`,
      };
    } finally {
      if (sessionTimer) clearTimeout(sessionTimer);
    }
  }
}

const mainCuaPermissionOnboardingCoordinator = new CuaPermissionOnboardingCoordinator();

export async function openCuaPermissionOnboarding(
  options: OpenCuaAccessibilitySettingsOptions = {},
): Promise<CuaAccessibilitySettingsResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      success: false,
      error: "ZCode Computer Use permissions are only available on macOS.",
    };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  let helperAppPath: string;
  try {
    helperAppPath = await (options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled)();
  } catch (error) {
    // Security boundary：安装/校验失败时
    // 必须 fail-closed，绝不回退到“路径存在即用”的未验证 Helper —— 否则会引导用户把 Accessibility /
    // Screen Recording 授权给旧版本 / 坏签名 / 错误 Team / 被替换的 bundle，破坏“Helper 是独立且受
    // TeamIdentifier pinning 的授权主体”这一核心边界。dev 场景由 installer 内部的
    // ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL 承接：通过 dev 校验时 ensureInstalled 会正常返回本地 app，
    // 根本不会进到这个 catch；只有真正校验失败才会到这里。
    return {
      success: false,
      error: `ZCode Computer Use is unavailable (install/verification failed): ${messageOf(error)}`,
    };
  }

  let identity: HelperPermissionSubjectIdentity;
  try {
    identity = await (options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity)(
      helperAppPath,
    );
  } catch (error) {
    return {
      success: false,
      returnedFromSettings: false,
      error: `ZCode Computer Use permission identity verification failed: ${messageOf(error)}`,
    };
  }
  const verifiedOptions: OpenCuaAccessibilitySettingsOptions = {
    ...options,
    ...(options.verifyHelperInstalled
      ? { verifyHelperInstalled: options.verifyHelperInstalled }
      : defaultInstaller
        ? { verifyHelperInstalled: defaultInstaller.verifyInstalled }
        : {}),
  };
  return mainCuaPermissionOnboardingCoordinator.run(
    identity,
    normalizeRequiredPermissions(options),
    verifiedOptions,
  );
}

// 2026-08 审计曾把拖拽链路当作死代码删除（当时渲染层无调用方，权限引导靠 native 弹窗让 Helper
// 自动进入 TCC 列表）。弹窗被摘除后，拖拽重新成为 Helper 进入权限列表的**唯一**途径，
// 故恢复本函数。openCuaAccessibilitySettings（旧确认弹窗频道）不恢复，它已被 onboarding 取代。

export interface PrepareCuaHelperPermissionDragOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger?: OpenCuaAccessibilitySettingsOptions["logger"];
  /** 与 onboarding 共用桌面 installer factory 的 install+verify。测试可注入。 */
  ensureHelperInstalled?: () => Promise<string>;
  bundledHelperAppPath?: string;
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
}

export interface PrepareCuaHelperPermissionDragMainResult extends PrepareCuaHelperPermissionDragResult {
  /**
   * 与本次完整验签前后绑定的同步 bundle 指纹。只允许 main 内存缓存消费 —— IPC handler 必须在
   * 返回 renderer 前剥掉此字段（跨进程暴露既无用又扩大攻击面）。
   */
  helperBundleFingerprint?: CuaHelperBundleFingerprint;
}

// 拖拽授权与 onboarding 最终引向同一个 TCC 授权主体，安全校验必须一致：磁盘上被旧版 / 坏签名 /
// 错误 Team / 同用户可写内容替换的 .app 若被拖进 Accessibility/Screen Recording，TCC 授权会落到
// 错误主体，绕过整个 TeamIdentifier pinning 设计。所以拖拽前必须走同一条 install+verify
// （bundle id / 版本 / arch / codesign / TeamIdentifier / Gatekeeper）。
//
// 但 Electron 原生文件拖拽要求在 dragstart 事件链路里*同步*调用 event.sender.startDrag()，
// 等不了这些异步 I/O（否则错过 OS 拖拽手势窗口，用户拖不出任何文件）。因此把 install+verify
// 拆到本函数：浮窗挂载时预热并缓存已验证路径 + 指纹，dragstart 只读缓存并同步比对（见
// desktopCuaPermissionIpc）。
export async function prepareCuaHelperPermissionDrag(
  options: PrepareCuaHelperPermissionDragOptions = {},
): Promise<PrepareCuaHelperPermissionDragMainResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      success: false,
      error: "ZCode Computer Use permissions are only available on macOS.",
    };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  try {
    const helperAppPath = await (
      options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled
    )();
    // 顺序关键：先抓快照，再完整 verify，验签后与 identity 读取后各复核一次。若在 ensure/verify
    // 返回后才抓指纹，攻击者可在两者之间替换 .app，导致恶意字节反而成为“已验证指纹”。只有全程未变
    // 的同一批字节才允许交给同步 dragstart 缓存。
    const verifiedFingerprint = captureCuaHelperBundleFingerprint(helperAppPath);
    await (options.verifyHelperInstalled ?? defaultInstaller?.verifyInstalled)?.(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag signature was being verified");
    }
    const identity = await (
      options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
    )(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag identity was being resolved");
    }
    return {
      success: true,
      helperAppPath,
      helperDisplayName: identity.displayName,
      helperBundleId: identity.bundleId,
      helperBundleFingerprint: verifiedFingerprint,
    };
  } catch (error) {
    const message = messageOf(error);
    options.logger?.warn(
      "[cua-permission-onboarding] helper install/verify failed; refusing to prepare drag of an unverified Helper",
      message,
    );
    return { success: false, error: message };
  }
}
