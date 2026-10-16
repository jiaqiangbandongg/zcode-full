import type { RemoteTarget } from "@zcode/shared";
import { WSLBackend } from "@zcode/server/remote/wsl-backend.js";

type WslTarget = Extract<RemoteTarget, { kind: "wsl" }>;

interface WslIdentityBackend {
  resolveIdentity(): Promise<{ distro: string; user: string }>;
  dispose(): void;
}

interface CanonicalWslTargetResolverOptions {
  createBackend?: (target: WslTarget) => WslIdentityBackend;
  ttlMs?: number;
  now?: () => number;
}

interface CachedResolution {
  expiresAt: number;
  promise: Promise<WslTarget>;
}

const DEFAULT_RESOLUTION_TTL_MS = 5_000;
const DEFAULT_IDENTITY_SEGMENT = "<default>";

function buildProvisionalResolutionKey(target: WslTarget): string {
  const distro = target.distro?.trim().toLowerCase() || DEFAULT_IDENTITY_SEGMENT;
  const user = target.user?.trim() || DEFAULT_IDENTITY_SEGMENT;
  return `${distro}\0${user}`;
}

export function createCanonicalWslTargetResolver(
  options: CanonicalWslTargetResolverOptions = {},
): (target: WslTarget) => Promise<WslTarget> {
  const createBackend =
    options.createBackend ?? ((target: WslTarget) => new WSLBackend(target));
  const ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_RESOLUTION_TTL_MS));
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedResolution>();

  return (target) => {
    const key = buildProvisionalResolutionKey(target);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      return cached.promise;
    }

    const entry: CachedResolution = {
      expiresAt: now() + ttlMs,
      promise: Promise.resolve().then(async () => {
        const backend = createBackend(target);
        try {
          const identity = await backend.resolveIdentity();
          return {
            kind: "wsl" as const,
            distro: identity.distro,
            user: identity.user,
          };
        } finally {
          backend.dispose();
        }
      }),
    };
    cache.set(key, entry);
    void entry.promise.catch(() => {
      // 临时 discovery 失败若留在 cache，会让用户在 TTL 内无法通过重试恢复连接。
      if (cache.get(key) === entry) {
        cache.delete(key);
      }
    });
    return entry.promise;
  };
}

export const resolveCanonicalWslTarget = createCanonicalWslTargetResolver();
