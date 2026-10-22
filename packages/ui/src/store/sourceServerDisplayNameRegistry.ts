import type { ISourceServerManagementService } from "@zcode/services";
import { logger } from "@/logger.js";

export interface SourceServerDisplayNameRegistry {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReadonlyMap<string, string>;
}

const registries = new WeakMap<
  ISourceServerManagementService,
  SourceServerDisplayNameRegistry
>();

export function getSourceServerDisplayNameRegistry(
  management: ISourceServerManagementService,
): SourceServerDisplayNameRegistry {
  const existing = registries.get(management);
  if (existing) return existing;
  const listeners = new Set<() => void>();
  let names: ReadonlyMap<string, string> = new Map();
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;
  const refresh = () => {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = management
      .getSnapshot()
      .then((snapshot) => {
        names = new Map(
          snapshot.servers.map((server) => [
            server.sourceServerId,
            server.displayName,
          ]),
        );
        for (const listener of listeners) listener();
      })
      .catch((error) => {
        logger.warn("[sourceServerDisplayNameRegistry] 读取 Source 目录失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        refreshInFlight = null;
        if (refreshQueued) {
          refreshQueued = false;
          refresh();
        }
      });
  };
  management.onDidChangeState(refresh);
  management.onDidChangeDirectory?.(refresh);
  refresh();
  const registry: SourceServerDisplayNameRegistry = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => names,
  };
  registries.set(management, registry);
  return registry;
}
