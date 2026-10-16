import { copyFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SaveFileRequest, SaveFileResult } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { Agent, fetch as undiciFetch } from "undici";

export const MAX_SAVE_FILE_BYTES = 50 * 1024 * 1024;
export const REMOTE_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REMOTE_REDIRECTS = 5;

const blockedRemoteAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedRemoteAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedRemoteAddresses.addSubnet(network, prefix, "ipv6");
}

class SaveFileError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function parseRemoteImageUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function resolvePublicRemoteUrl(
  url: URL,
): Promise<Awaited<ReturnType<typeof lookup>>> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new SaveFileError("remote_address_not_allowed");
  }
  let addresses: Awaited<ReturnType<typeof lookup>>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SaveFileError("download_failed");
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      blockedRemoteAddresses.check(address, family === 6 ? "ipv6" : "ipv4"),
    )
  ) {
    throw new SaveFileError("remote_address_not_allowed");
  }
  return addresses;
}

async function fetchPublicRemoteUrl(
  initialUrl: URL,
  signal: AbortSignal,
): Promise<{ dispatcher: Agent; response: Awaited<ReturnType<typeof undiciFetch>> }> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REMOTE_REDIRECTS; redirectCount += 1) {
    const addresses = await resolvePublicRemoteUrl(currentUrl);
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const address = addresses[0];
      if (!address) {
        callback(new Error("download_failed"), "");
        return;
      }
      callback(null, address.address, address.family);
    };
    // DNS 校验结果必须绑定到连接阶段；dispatcher 禁止底层再次解析域名，
    // 从而关闭“预检查公网、实际连接私网”的 DNS rebinding 窗口。
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(currentUrl, {
        dispatcher,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      await dispatcher.close();
      throw error;
    }
    if (response.status < 300 || response.status >= 400) {
      return { dispatcher, response };
    }

    await response.body?.cancel().catch(() => undefined);
    await dispatcher.close();
    const location = response.headers.get("location");
    if (!location || redirectCount === MAX_REMOTE_REDIRECTS) {
      throw new SaveFileError("download_failed");
    }
    const redirectedUrl = parseRemoteImageUrl(new URL(location, currentUrl).toString());
    if (!redirectedUrl) throw new SaveFileError("download_failed");
    currentUrl = redirectedUrl;
  }
  throw new SaveFileError("download_failed");
}

async function downloadRemoteFile(
  sourceUrl: URL,
  destinationPath: string,
): Promise<void> {
  const controller = new AbortController();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-save-file-"));
  const temporaryPath = join(temporaryDirectory, "download");
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let file: Awaited<ReturnType<typeof open>> | null = null;
  let dispatcher: Agent | null = null;
  const timeout = setTimeout(() => controller.abort(), REMOTE_DOWNLOAD_TIMEOUT_MS);
  try {
    // renderer 的 CORS 边界不能放大成 main 可访问内网；初始地址和每次重定向都先解析并拒绝非公网地址。
    const remoteResponse = await fetchPublicRemoteUrl(sourceUrl, controller.signal);
    dispatcher = remoteResponse.dispatcher;
    const { response } = remoteResponse;
    if (!response.ok || !response.body) {
      throw new SaveFileError("download_failed");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_SAVE_FILE_BYTES) {
      throw new SaveFileError("file_too_large");
    }

    reader = response.body.getReader();
    file = await open(temporaryPath, "wx");
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_SAVE_FILE_BYTES) {
        // 容量限制必须在读取过程中执行；完整缓冲后再校验无法保护 renderer/main 内存。
        controller.abort();
        throw new SaveFileError("file_too_large");
      }
      await file.write(value);
    }
    if (receivedBytes === 0) throw new SaveFileError("invalid_file_payload");
    await file.close();
    file = null;
    await copyFile(temporaryPath, destinationPath);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await dispatcher?.close().catch(() => undefined);
    await file?.close().catch(() => undefined);
    await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

export function registerDesktopSaveFileIpcHandler(logger: { warn: (...args: unknown[]) => void }) {
  ipcMain.handle(
    PlatformChannels.SaveFile,
    async (event, payload: SaveFileRequest): Promise<SaveFileResult> => {
      if (!payload || typeof payload.suggestedName !== "string") {
        return { success: false, error: "invalid_file_payload" };
      }
      const suggestedName = basename(payload.suggestedName.trim()).slice(0, 120);
      const sourceUrl = parseRemoteImageUrl(payload.sourceUrl);
      const hasData = payload.data instanceof ArrayBuffer;
      if (!suggestedName || (sourceUrl === null && !hasData)) {
        return { success: false, error: "invalid_file_payload" };
      }
      if (hasData && payload.data.byteLength === 0) {
        return { success: false, error: "invalid_file_payload" };
      }
      if (hasData && payload.data.byteLength > MAX_SAVE_FILE_BYTES) {
        return { success: false, error: "file_too_large" };
      }

      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions = { defaultPath: suggestedName };
      const result = senderWindow
        ? await dialog.showSaveDialog(senderWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      try {
        if (sourceUrl) {
          await downloadRemoteFile(sourceUrl, result.filePath);
        } else if (hasData) {
          await writeFile(result.filePath, new Uint8Array(payload.data));
        }
        return { success: true, path: result.filePath };
      } catch (error) {
        const errorCode = error instanceof SaveFileError ? error.code : "write_failed";
        logger.warn(
          `[save-file] 写入失败 path=${result.filePath} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { success: false, error: errorCode };
      }
    },
  );
}
