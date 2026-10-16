import { realpath as fsRealpath } from "node:fs/promises";
import { realpathSync as fsRealpathSync, statSync as fsStatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { LOCAL_MEDIA_PREVIEW_SCHEME, buildLocalMediaPreviewUrl } from "@zcode/shared";

interface LocalMediaPreviewSchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: Array<{
      scheme: string;
      privileges: Record<string, boolean>;
    }>,
  ): void;
}

interface LocalMediaPreviewProtocolRequest {
  url: string;
}

type LocalMediaPreviewProtocolResponse = string | { error: number };

interface LocalMediaPreviewProtocol {
  registerFileProtocol(
    scheme: string,
    handler: (
      request: LocalMediaPreviewProtocolRequest,
      callback: (response: LocalMediaPreviewProtocolResponse) => void,
    ) => void,
  ): boolean;
}

const installedProtocols = new WeakSet<object>();
const NET_ERR_INVALID_URL = -300;

export interface LocalMediaPreviewPathRegistry {
  authorize(path: string): Promise<string>;
  isAuthorized(path: string): boolean;
  clear(): void;
}

const LOCAL_MEDIA_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;
const LOCAL_MEDIA_AUTHORIZATION_MAX_ENTRIES = 256;

/**
 * Main 只登记 Host 已经通过 workspace/session/message/attachment 校验的精确文件。
 * 旧协议直接信任 renderer URL 中的绝对 path，导致任何 renderer 脚本都能读取任意文件。
 */
export function createLocalMediaPreviewPathRegistry(
  dependencies: {
    isAbsolutePath?: (path: string) => boolean;
    realpath?: (path: string) => Promise<string>;
    realpathSync?: (path: string) => string;
    isRegularFileSync?: (path: string) => boolean;
    now?: () => number;
    ttlMs?: number;
    maxEntries?: number;
  } = {},
): LocalMediaPreviewPathRegistry {
  const authorizedPaths = new Map<
    string,
    { canonicalPath: string; expiresAt: number; lastUsedAt: number }
  >();
  // 永久 Set 会无界增长，且路径被替换为 symlink 后仍继续获得 file loader 权限。
  const isAbsolutePath = dependencies.isAbsolutePath ?? isAbsolute;
  const realpath = dependencies.realpath ?? fsRealpath;
  const realpathSync = dependencies.realpathSync ?? fsRealpathSync;
  const isRegularFileSync =
    dependencies.isRegularFileSync ?? ((path: string) => fsStatSync(path).isFile());
  const now = dependencies.now ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? LOCAL_MEDIA_AUTHORIZATION_TTL_MS;
  const maxEntries = dependencies.maxEntries ?? LOCAL_MEDIA_AUTHORIZATION_MAX_ENTRIES;

  const pruneExpired = (observedAt: number) => {
    for (const [path, entry] of authorizedPaths) {
      if (entry.expiresAt <= observedAt) authorizedPaths.delete(path);
    }
  };

  const evictLeastRecentlyUsed = () => {
    while (authorizedPaths.size > maxEntries) {
      let oldestPath: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [path, entry] of authorizedPaths) {
        if (entry.lastUsedAt < oldestAccess) {
          oldestAccess = entry.lastUsedAt;
          oldestPath = path;
        }
      }
      if (!oldestPath) return;
      authorizedPaths.delete(oldestPath);
    }
  };

  return {
    async authorize(path) {
      if (!isAbsolutePath(path)) {
        throw new Error("Local media preview path must be absolute");
      }
      const canonicalPath = await realpath(path);
      const observedAt = now();
      pruneExpired(observedAt);
      authorizedPaths.set(canonicalPath, {
        canonicalPath,
        expiresAt: observedAt + ttlMs,
        lastUsedAt: observedAt,
      });
      evictLeastRecentlyUsed();
      return canonicalPath;
    },
    isAuthorized(path) {
      const observedAt = now();
      pruneExpired(observedAt);
      const entry = authorizedPaths.get(path);
      if (!entry) return false;
      try {
        if (realpathSync(path) !== entry.canonicalPath || !isRegularFileSync(path)) {
          authorizedPaths.delete(path);
          return false;
        }
      } catch {
        authorizedPaths.delete(path);
        return false;
      }
      entry.lastUsedAt = observedAt;
      return true;
    },
    clear() {
      authorizedPaths.clear();
    },
  };
}

/**
 * Electron 要求 privileged scheme 在 app ready 前注册。
 * 缺少 standard 时 Chromium 不会按标准 URL 处理文件尾读取，导致 moov 位于 mdat
 * 之后的 MP4 被误判为不可解码；standard 与 stream 共同保留本地视频的元数据读取和 seek。
 */
export function registerLocalMediaPreviewScheme(
  protocol: LocalMediaPreviewSchemeRegistrar,
  // registerSchemesAsPrivileged 只能调用一次（后一次覆盖前一次），其他 privileged scheme
  // （如插件 UI 沙箱的 zcode-sandbox）必须在这同一次调用里一起注册。
  additionalSchemes: Array<{ scheme: string; privileges: Record<string, boolean> }> = [],
): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_MEDIA_PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, stream: true },
    },
    ...additionalSchemes,
  ]);
}

export function installLocalMediaPreviewProtocol(
  protocol: LocalMediaPreviewProtocol,
  options: { isPathAuthorized: (path: string) => boolean },
): void {
  if (installedProtocols.has(protocol)) return;
  // protocol.handle(Response) 在 Electron 41 中无法为本地音视频提供稳定的
  // seekable range，手工返回 Range 还会被媒体栈判为不可播放。复用原生 file loader，
  // 让 Chromium 处理 Range，同时仍只把校验后的音视频绝对路径交给 loader。
  const registered = protocol.registerFileProtocol(
    LOCAL_MEDIA_PREVIEW_SCHEME,
    (request, callback) => {
      try {
        const url = new URL(request.url);
        const path = url.searchParams.get("path") ?? "";
        if (
          url.hostname !== "local" ||
          url.pathname !== "/preview" ||
          !options.isPathAuthorized(path)
        ) {
          callback({ error: NET_ERR_INVALID_URL });
          return;
        }
        callback(path);
      } catch {
        callback({ error: NET_ERR_INVALID_URL });
      }
    },
  );
  if (!registered) throw new Error("Failed to register local media preview protocol");
  installedProtocols.add(protocol);
}

export { buildLocalMediaPreviewUrl };
