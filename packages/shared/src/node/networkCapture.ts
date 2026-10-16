import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { ClientRequest } from "node:http";
import {
  sanitizeNetworkCaptureUrl,
  type NetworkCaptureBatch,
  type NetworkRequestRecord,
} from "../networkCapture.js";

const excluded = new AsyncLocalStorage<boolean>();
/** MCP 的 HTTP/SSE/OAuth 共用此异步上下文，不影响原 fetch 的代理与证书策略。 */
export function withoutNetworkCapture<T>(operation: () => T): T {
  return excluded.run(true, operation);
}

/** 仅订阅请求创建事件；不开启时不持有监听器或定时器，不读取流。 */
export function createNodeNetworkCapture(
  processType: NetworkRequestRecord["processType"],
  onBatch: (batch: NetworkCaptureBatch) => void,
): { setCaptureId(captureId: string | null): void } {
  let captureId: string | null = null;
  let records: NetworkRequestRecord[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (!captureId) return;
    const batch = { captureId, records, dropped };
    records = [];
    dropped = 0;
    // 诊断消费者退出或抛错不能破坏业务请求。
    try {
      onBatch(batch);
    } catch {
      /* 仅丢弃观测 */
    }
  };
  const record = (method: string, rawUrl: string) => {
    if (!captureId || excluded.getStore() || method === "CONNECT") return;
    if (records.length >= 100) {
      dropped++;
      return;
    }
    const url = sanitizeNetworkCaptureUrl(rawUrl);
    if (!url) return;
    records.push({
      timestamp: Date.now(),
      processType,
      pid: process.pid,
      method: method.slice(0, 32),
      url,
    });
    timer ??= setTimeout(flush, 250);
    timer.unref();
  };
  const undici = (message: unknown) => {
    try {
      const { request } = message as {
        request: { method: string; origin: string; path: string; upgrade?: string };
      };
      const url = new URL(request.path, request.origin);
      if (request.upgrade?.toLowerCase() === "websocket")
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      record(request.method, url.href);
    } catch {
      /* 非标准客户端的诊断事件不影响请求 */
    }
  };
  const http = (message: unknown) => {
    try {
      const { request } = message as { request: ClientRequest };
      // forward proxy 的 path 已是绝对 URL；不可把代理地址当作目标地址。
      const url = new URL(
        request.path,
        `${request.protocol}//${String(request.getHeader("host") ?? request.host)}`,
      );
      if (String(request.getHeader("upgrade")).toLowerCase() === "websocket")
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      record(request.method, url.href);
    } catch {
      /* 仅忽略不可识别的元数据 */
    }
  };
  return {
    setCaptureId(next) {
      if (captureId === next) return;
      if (captureId) {
        channel("undici:request:create").unsubscribe(undici);
        channel("http.client.request.start").unsubscribe(http);
      }
      if (timer) clearTimeout(timer);
      timer = undefined;
      records = [];
      dropped = 0;
      captureId = next;
      if (captureId) {
        channel("undici:request:create").subscribe(undici);
        channel("http.client.request.start").subscribe(http);
      }
    },
  };
}
