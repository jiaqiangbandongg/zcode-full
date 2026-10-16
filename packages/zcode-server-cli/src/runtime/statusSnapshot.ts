import { readFile, rename, writeFile } from "node:fs/promises";
import { serverStatusSchema, type ServerStatus } from "../contracts.js";
import { resolveServerLayout, type ServerLayout } from "./paths.js";

export type PersistedStatusRead =
  | { state: "valid"; status: ServerStatus }
  | { state: "missing"; status: null }
  | { state: "invalid" | "unreadable"; status: null; error: unknown };

export async function readPersistedStatusDetailed(layout: ServerLayout): Promise<PersistedStatusRead> {
  // Bug 原因：文件缺失表示离线，JSON/schema 损坏表示观测不可信；两者不能再折叠成同一个 null，
  // 否则 uninstall/stop 会把“无法确认已停止”误判成“已经停止”。
  let raw: string;
  try {
    raw = await readFile(layout.statusFile, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: "missing", status: null };
    }
    return { state: "unreadable", status: null, error };
  }
  try {
    return { state: "valid", status: serverStatusSchema.parse(JSON.parse(raw)) };
  } catch (error: unknown) {
    return { state: "invalid", status: null, error };
  }
}

export async function readPersistedStatus(layout = resolveServerLayout()): Promise<ServerStatus | null> {
  return (await readPersistedStatusDetailed(layout)).status;
}

export function createStatusPersister<T>(
  statusFile: string,
  getStatus: () => T,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let inFlight: Promise<void> = Promise.resolve();
  return async () => {
    // 一次 status 写盘失败不能让排队链永久 reject，否则后续生命周期快照
    // 会全部丢失；status.json 只是观测快照，失败时记录告警并继续服务生命周期。
    inFlight = inFlight
      .then(async () => {
        const temporary = `${statusFile}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(getStatus(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, statusFile);
      })
      .catch((error: unknown) => onError(error));
    await inFlight;
  };
}
