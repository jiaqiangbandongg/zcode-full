import type { IRemoteBackend, StdioStream } from "@zcode/server/remote/backend.js";
import { waitForClose } from "@zcode/server/remote/deployShared.js";

export type RemoteDownloadTool = "curl" | "wget";
export type RemoteSha256Tool = "sha256sum" | "shasum" | "openssl";

export interface RemoteAssetTools {
  download: RemoteDownloadTool;
  tar: "tar";
  sha256: RemoteSha256Tool;
  supportsProgress?: boolean;
}

interface RemoteAssetPreflightLoggers {
  log: (...args: unknown[]) => void;
}

const REMOTE_TAR_MISSING_ERROR =
  "远端服务器缺少 tar，无法解压 ZCode Source Server。请安装 tar 后重试。";

export async function detectRemoteTarTool(
  backend: IRemoteBackend,
  loggers: RemoteAssetPreflightLoggers,
): Promise<"tar"> {
  loggers.log("[remote-assets] preflight: checking remote archive tools");
  const stream = await backend.exec(
    "tar_tool=; if command -v tar >/dev/null 2>&1; then tar_tool=tar; fi; printf 'tar=%s\\n' \"$tar_tool\"",
  );
  const stdoutPromise = collectStdout(stream);
  await waitForClose(stream);
  const values = parseToolLines(await stdoutPromise);
  if (values.tar !== "tar") throw new Error(REMOTE_TAR_MISSING_ERROR);
  return "tar";
}

export async function detectRemoteAssetTools(
  backend: IRemoteBackend,
  loggers: RemoteAssetPreflightLoggers,
): Promise<RemoteAssetTools> {
  loggers.log("[remote-assets] preflight: checking remote download tools");

  const stream = await backend.exec(buildPreflightCommand());
  const stdoutPromise = collectStdout(stream);
  await waitForClose(stream);
  const stdout = await stdoutPromise;

  const values = parseToolLines(stdout);
  const download = parseDownloadTool(values.download);
  const tar = values.tar === "tar" ? "tar" : null;
  const sha256 = parseSha256Tool(values.sha256);
  const supportsProgress = values.progress === "full";

  if (!download) {
    throw new Error(
      "远端服务器缺少 curl 或 wget，无法直接下载 ZCode 远程资源。请安装 curl/wget，或切回“本地下载后上传”。",
    );
  }
  if (!tar) {
    throw new Error(REMOTE_TAR_MISSING_ERROR);
  }
  if (!sha256) {
    throw new Error(
      "远端服务器缺少 sha256sum、shasum 或 openssl，无法校验 ZCode 远程资源。请安装其中一个校验工具，或切回“本地下载后上传”。",
    );
  }

  loggers.log(
    `[remote-assets] preflight: selected tools download=${download} tar=${tar} sha256=${sha256} progress=${supportsProgress ? "full" : "basic"}`,
  );

  return { download, tar, sha256, supportsProgress };
}

function buildPreflightCommand(): string {
  return [
    "download=",
    "if command -v curl >/dev/null 2>&1; then download=curl; elif command -v wget >/dev/null 2>&1; then download=wget; fi",
    "tar_tool=",
    "if command -v tar >/dev/null 2>&1; then tar_tool=tar; fi",
    "sha_tool=",
    "if command -v sha256sum >/dev/null 2>&1; then sha_tool=sha256sum; elif command -v shasum >/dev/null 2>&1; then sha_tool=shasum; elif command -v openssl >/dev/null 2>&1; then sha_tool=openssl; fi",
    "progress=basic",
    "if command -v awk >/dev/null 2>&1 && command -v wc >/dev/null 2>&1 && command -v date >/dev/null 2>&1 && command -v sleep >/dev/null 2>&1; then progress=full; fi",
    'printf \'download=%s\ntar=%s\nsha256=%s\nprogress=%s\n\' "$download" "$tar_tool" "$sha_tool" "$progress"',
  ].join("; ");
}

function parseToolLines(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    values[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1).trim();
  }
  return values;
}

function parseDownloadTool(value?: string): RemoteDownloadTool | null {
  return value === "curl" || value === "wget" ? value : null;
}

function parseSha256Tool(value?: string): RemoteSha256Tool | null {
  return value === "sha256sum" || value === "shasum" || value === "openssl" ? value : null;
}

async function collectStdout(stream: StdioStream): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let closeFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const clearCloseFallback = () => {
      if (!closeFallbackTimer) {
        return;
      }
      clearTimeout(closeFallbackTimer);
      closeFallbackTimer = null;
    };
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearCloseFallback();
      resolve(stdout);
    };
    const scheduleCloseFallback = () => {
      if (settled) {
        return;
      }
      clearCloseFallback();
      closeFallbackTimer = setTimeout(settle, 50);
    };

    stream.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (closeFallbackTimer) {
        scheduleCloseFallback();
      }
    });
    stream.stdout.on("end", settle);
    stream.stdout.on("close", settle);
    stream.stdout.on("error", settle);
    // ssh2 的 exit/onClose 可能早于 stdout data；不能在 onClose 立刻结束收集。
    // 这里给 stdout 一个短暂排空窗口，同时仍兜底处理 stdout 不触发 end/close 的后端实现，避免 preflight 卡住。
    stream.onClose(scheduleCloseFallback);
  });
}
