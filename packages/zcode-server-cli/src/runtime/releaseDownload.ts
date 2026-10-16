import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { type ZodType } from "zod";
import { releaseCatalogSchema, type ReleaseCatalog } from "../contracts.js";

export async function fetchReleaseJson<T>(
  url: string,
  schema: ZodType<T>,
  timeoutMs = 10_000,
  resourceName = "Release JSON",
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`${resourceName} download failed: HTTP ${response.status}`);
    return schema.parse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchReleaseCatalog(url: string, timeoutMs = 10_000): Promise<ReleaseCatalog> {
  return await fetchReleaseJson(url, releaseCatalogSchema, timeoutMs, "Release catalog");
}

export interface DownloadOptions {
  url: string;
  destination: string;
  sha256: string;
  expectedSizeBytes?: number;
  /** 无数据活动时的超时；收到数据后会重新计时。 */
  timeoutMs?: number;
  /** 可选的总时长上限；未提供时按 expectedSizeBytes 动态计算。 */
  overallTimeoutMs?: number;
  /** 短暂网络错误的最大尝试次数，默认为 3。 */
  maxAttempts?: number;
  /** 重试基础退避时长，主要供测试或诊断缩短。 */
  retryDelayMs?: number;
}

const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_RATE_BYTES_PER_SECOND = 256 * 1024;
const DEFAULT_DOWNLOAD_OVERALL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_DOWNLOAD_RETRY_ATTEMPTS = 3;
const DEFAULT_DOWNLOAD_RETRY_DELAY_MS = 250;

class ReleaseDownloadHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`Release download failed: HTTP ${status}`);
    this.name = "ReleaseDownloadHttpError";
  }
}

function defaultOverallTimeoutMs(expectedSizeBytes: number | undefined): number {
  if (expectedSizeBytes === undefined) return DEFAULT_DOWNLOAD_OVERALL_TIMEOUT_MS;
  const transferBudgetMs = Math.ceil(expectedSizeBytes / DEFAULT_DOWNLOAD_RATE_BYTES_PER_SECOND) * 1_000;
  return Math.min(
    DEFAULT_DOWNLOAD_OVERALL_TIMEOUT_MS,
    Math.max(DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS, transferBudgetMs + 30_000),
  );
}

function isRetryableDownloadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TypeError") return true;
  if (error instanceof ReleaseDownloadHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN" || code === "UND_ERR_SOCKET";
}

async function waitBeforeRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export class ReleaseDownloader {
  public async download(options: DownloadOptions): Promise<void> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_DOWNLOAD_RETRY_ATTEMPTS);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_DOWNLOAD_RETRY_DELAY_MS);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await this.downloadOnce(options);
        return;
      } catch (error: unknown) {
        if (attempt + 1 >= maxAttempts || !isRetryableDownloadError(error)) throw error;
        await waitBeforeRetry(retryDelayMs * 2 ** attempt);
      }
    }
  }

  private async downloadOnce(options: DownloadOptions): Promise<void> {
    const temporary = `${options.destination}.part-${process.pid}-${randomUUID()}`;
    const controller = new AbortController();
    const idleTimeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS;
    const overallTimeoutMs = options.overallTimeoutMs ?? defaultOverallTimeoutMs(options.expectedSizeBytes);
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };
    const overallTimer = setTimeout(() => controller.abort(), overallTimeoutMs);
    resetIdleTimer();
    try {
      await mkdir(dirname(options.destination), { recursive: true });
      const response = await fetch(options.url, { redirect: "follow", signal: controller.signal });
      if (!response.ok) throw new ReleaseDownloadHttpError(response.status);
      if (!response.body) throw new Error("Release download failed: response body is empty");
      const body = Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
      const onData = (): void => resetIdleTimer();
      body.on("data", onData);
      try {
        await pipeline(
          body,
          createWriteStream(temporary, { flags: "w" }),
          { signal: controller.signal },
        );
      } finally {
        body.off("data", onData);
        if (idleTimer) clearTimeout(idleTimer);
      }
      if (options.expectedSizeBytes !== undefined) {
        const downloadedSize = (await stat(temporary)).size;
        if (downloadedSize !== options.expectedSizeBytes) {
          throw new Error(`Release archive size mismatch: expected ${options.expectedSizeBytes}, received ${downloadedSize}`);
        }
      }
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(temporary)) digest.update(chunk);
      const actual = digest.digest("hex");
      if (actual.toLowerCase() !== options.sha256.toLowerCase()) {
        throw new Error(`Release archive checksum mismatch: expected ${options.sha256}, received ${actual}`);
      }
      const file = await import("node:fs/promises");
      await file.rename(temporary, options.destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(overallTimer);
    }
  }
}
