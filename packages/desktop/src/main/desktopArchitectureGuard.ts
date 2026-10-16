import type { BrowserWindow, NativeImage } from "electron";
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  buildZCodeEndpointUrls,
  type Locale,
} from "@zcode/shared";

export interface ArchitectureMismatch {
  /** 当前运行的二进制架构，例如 x64。 */
  binaryArch: string;
  /** 推荐安装的原生架构，目前翻译运行只会回退到 arm64。 */
  nativeArch: string;
}

export interface DetectArchitectureMismatchOptions {
  platform?: NodeJS.Platform;
  binaryArch?: string;
  /**
   * Electron 的 app.runningUnderARM64Translation：
   * 当 x64/x86 安装包被翻译到 arm64 硬件上运行时为 true
   * （macOS 上的 Rosetta、Windows on ARM）。这正是“装错架构”的典型场景。
   */
  runningUnderARM64Translation?: boolean;
}

/**
 * 判断当前进程是否在“错误架构”下运行。
 *
 * 之所以以 runningUnderARM64Translation 为准而不是直接比对 process.arch 和 os.arch()：
 * Node 在 Apple Silicon 上跑 x64 包时，os.arch() 同样会返回 "x64"（被 Rosetta 透明翻译），
 * 单纯比对两者无法发现差异。translation 标志是唯一可靠的信号。
 */
export function detectArchitectureMismatch(
  options: DetectArchitectureMismatchOptions = {},
): ArchitectureMismatch | null {
  const platform = options.platform ?? process.platform;
  const binaryArch = options.binaryArch ?? process.arch;
  const translated = options.runningUnderARM64Translation ?? false;

  if (!translated) {
    return null;
  }
  // 仅 macOS / Windows 存在 ARM64 翻译运行；其余平台直接放行，避免误报。
  if (platform !== "darwin" && platform !== "win32") {
    return null;
  }

  return { binaryArch, nativeArch: "arm64" };
}

export function resolveArchitectureDownloadUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  // 与 changelog 等外链保持一致，按应用语言分流到官网下载页。
  const origin = buildZCodeEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn` : `${origin}/en`;
}

interface ArchitectureMismatchDialogText {
  title: string;
  message: string;
  detail: string;
  downloadButton: string;
  dismissButton: string;
}

export function formatArchitectureMismatchDialogText(
  mismatch: ArchitectureMismatch,
  locale: Locale,
): ArchitectureMismatchDialogText {
  const isZh = locale === "zh-CN";
  if (isZh) {
    return {
      title: "架构不匹配",
      message: "当前安装的不是适配本机的版本",
      detail:
        `你正在运行 ${mismatch.binaryArch} 版本，但本机是 ${mismatch.nativeArch}（Apple 芯片）架构，` +
        `当前通过系统转译运行，会更慢、更耗电。\n\n` +
        `建议前往官网下载并安装 ${mismatch.nativeArch} 原生版本以获得最佳性能。`,
      downloadButton: "前往下载",
      dismissButton: "暂不处理",
    };
  }

  return {
    title: "Architecture Mismatch",
    message: "The installed build does not match your machine",
    detail:
      `You are running the ${mismatch.binaryArch} build, but this machine is ${mismatch.nativeArch}. ` +
      `It is currently running through system translation, which is slower and less power-efficient.\n\n` +
      `Please download and install the native ${mismatch.nativeArch} build for the best performance.`,
    downloadButton: "Download",
    dismissButton: "Not now",
  };
}

export interface ArchitectureGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * 启动时检测架构是否匹配；若用户装了错误架构的版本，弹框提示其下载原生版本。
 * 非阻塞：检测命中后异步弹框，不影响主界面继续加载。
 */
export async function maybeWarnArchitectureMismatch(options: {
  locale: Locale;
  logger: ArchitectureGuardLogger;
  parentWindow?: BrowserWindow | null;
  icon?: NativeImage;
}): Promise<void> {
  const { app, dialog, shell } = await import("electron");

  const mismatch = detectArchitectureMismatch({
    runningUnderARM64Translation: app.runningUnderARM64Translation,
  });
  if (!mismatch) {
    return;
  }

  options.logger.warn(
    `[architecture] 检测到架构不匹配：运行 ${mismatch.binaryArch}，本机为 ${mismatch.nativeArch}（转译运行）`,
  );

  const text = formatArchitectureMismatchDialogText(mismatch, options.locale);
  const dialogOptions = {
    type: "warning" as const,
    buttons: [text.downloadButton, text.dismissButton],
    defaultId: 0,
    cancelId: 1,
    title: text.title,
    message: text.message,
    detail: text.detail,
    ...(options.icon && !options.icon.isEmpty() ? { icon: options.icon } : {}),
  };

  const { response } =
    options.parentWindow && !options.parentWindow.isDestroyed()
      ? await dialog.showMessageBox(options.parentWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);

  if (response === 0) {
    const url = resolveArchitectureDownloadUrl(options.locale);
    options.logger.info(`[architecture] 用户选择前往下载：${url}`);
    await shell.openExternal(url);
  }
}
