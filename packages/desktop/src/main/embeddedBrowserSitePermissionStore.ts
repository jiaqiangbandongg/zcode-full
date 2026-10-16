import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmbeddedBrowserSitePermissionRecord, EmbeddedBrowserSitePermissionStore } from "./embeddedBrowserPermissionPolicy.js";

/**
 * 内置浏览器站点同意记录的文件持久化：userData 下独立 JSON，原子写（tmp + rename）。
 * 不进全局 settings，避免与主题等跨窗口广播耦合；结构损坏时按空记录重启（fail-open
 * 到「每次询问」，不会错误放行）。
 */
export function createEmbeddedBrowserSitePermissionStore(filePath: string): EmbeddedBrowserSitePermissionStore {
  const tempPath = join(dirname(filePath), `.${Math.random().toString(36).slice(2)}-site-permissions.tmp`);

  const parseRecord = (raw: string): EmbeddedBrowserSitePermissionRecord => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record: EmbeddedBrowserSitePermissionRecord = {};
    for (const [origin, permissions] of Object.entries(parsed as Record<string, unknown>)) {
      if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) continue;
      const normalized: Record<string, "allow" | "deny"> = {};
      for (const [permission, state] of Object.entries(permissions as Record<string, unknown>)) {
        if (state === "allow" || state === "deny") normalized[permission] = state;
      }
      if (Object.keys(normalized).length > 0) record[origin] = normalized;
    }
    return record;
  };

  return {
    async load() {
      try {
        return parseRecord(await readFile(filePath, "utf8"));
      } catch {
        return {};
      }
    },
    async persist(record) {
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        await rename(tempPath, filePath);
      } catch {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw new Error(`failed to persist embedded browser site permissions: ${filePath}`);
      }
    },
  };
}
