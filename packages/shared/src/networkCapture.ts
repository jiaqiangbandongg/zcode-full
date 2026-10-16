import { z } from "zod";

export const NETWORK_CAPTURE_LIMIT = 1_000;
export const networkCaptureControlSchema = z
  .object({
    captureId: z.string().min(1).max(100).nullable(),
  })
  .strict();
export const networkRequestRecordSchema = z
  .object({
    timestamp: z.number().int().nonnegative(),
    processType: z.enum(["main", "host", "renderer", "cli"]),
    pid: z.number().int().nonnegative(),
    method: z.string().min(1).max(32),
    url: z.string().max(2_048),
  })
  .strict();
export const networkCaptureBatchSchema = z
  .object({
    captureId: z.string().min(1).max(100),
    records: z.array(networkRequestRecordSchema).max(100),
    dropped: z.number().int().nonnegative(),
  })
  .strict();
export type NetworkRequestRecord = z.infer<typeof networkRequestRecordSchema>;
export type NetworkCaptureBatch = z.infer<typeof networkCaptureBatchSchema>;
export interface NetworkCaptureSnapshot {
  captureId: string;
  records: Array<NetworkRequestRecord & { id: number }>;
  dropped: number;
}
export interface NetworkCaptureBridge {
  getSnapshot(): Promise<NetworkCaptureSnapshot>;
  clear(): Promise<void>;
}

/** 不保留凭据、fragment 或查询值；仍保留路径和查询键用于辨认请求。 */
export function sanitizeNetworkCaptureUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return;
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, "[redacted]");
    return url.href.slice(0, 2_048);
  } catch {
    return;
  }
}
