import type {
  EmbeddedBrowserSitePermissionRecord,
  EmbeddedBrowserSitePermissionStore,
} from "./embeddedBrowserPermissionPolicy.js";

/**
 * 内置浏览器站点同意记录的模块级管理器：
 * - permission check/request handler 需要同步读取（Electron check handler 无异步版），
 *   因此记录常驻内存，持久化（store）在写路径异步落盘；
 * - 设置页「网站权限」与「清除浏览器数据」经同一模块读写，保证与决策口径一致。
 * 模块级单例与 getPluginSandboxHost 同款模式：main 进程单实例，无并发写竞争。
 */
let record: EmbeddedBrowserSitePermissionRecord = {};
let store: EmbeddedBrowserSitePermissionStore | null = null;
let logger: { warn: (...args: unknown[]) => void } | null = null;

export async function initEmbeddedBrowserSitePermissions(input: {
  store?: EmbeddedBrowserSitePermissionStore;
  logger: { warn: (...args: unknown[]) => void };
}): Promise<void> {
  store = input.store ?? null;
  logger = input.logger;
  record = {};
  if (store) {
    try {
      record = await store.load();
    } catch (error) {
      input.logger.warn("[embedded-browser-permission] site permission store load failed:", error);
    }
  }
}

export function getEmbeddedBrowserSitePermission(
  origin: string,
  permission: string,
): "allow" | "deny" | undefined {
  return record[origin]?.[permission];
}

export function getEmbeddedBrowserSitePermissionSnapshot(): EmbeddedBrowserSitePermissionRecord {
  return structuredClone(record);
}

export async function writeEmbeddedBrowserSitePermission(
  origin: string,
  permission: string,
  state: "allow" | "deny",
): Promise<void> {
  record[origin] = { ...record[origin], [permission]: state };
  await persist();
}

/** state 传 "ask" 表示删除该条记录（回到每次询问）。 */
export async function removeEmbeddedBrowserSitePermission(
  origin: string,
  permission: string,
): Promise<void> {
  const permissions = record[origin];
  if (!permissions) return;
  const next = { ...permissions };
  delete next[permission];
  if (Object.keys(next).length === 0) delete record[origin];
  else record[origin] = next;
  await persist();
}

export async function removeEmbeddedBrowserSitePermissionOrigin(origin: string): Promise<void> {
  delete record[origin];
  await persist();
}

export async function clearEmbeddedBrowserSitePermissions(): Promise<void> {
  record = {};
  await persist();
}

async function persist(): Promise<void> {
  if (!store) return;
  try {
    await store.persist(record);
  } catch (error) {
    // 内存记录已生效，落盘失败只降级为重启后回退到「每次询问」，不阻塞决策。
    logger?.warn("[embedded-browser-permission] site permission store persist failed:", error);
  }
}

/** 仅测试用：隔离模块级状态。 */
export function resetEmbeddedBrowserSitePermissionsForTest(): void {
  record = {};
  store = null;
  logger = null;
}
