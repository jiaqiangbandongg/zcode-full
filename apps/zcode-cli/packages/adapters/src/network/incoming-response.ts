import type http from "node:http";
import { Readable } from "node:stream";

/**
 * adapter 自己发请求时（代理、自定义 CA、公网 DNS 校验），把 Node 的 `IncomingMessage` 交给上层的唯一入口
 * （docs/design/v2/model/http-proxy.md「行为」）。
 *
 * 修复原因（2026-09-29 实测）：两处 adapter 都在 `http.request` 的回调里直接
 * `new Response(stream, { status })`。WHATWG `Response` 只收 200–599，204 / 205 / 304 还不许挂正文；
 * LinkedIn 对爬虫回 999，构造函数在回调里抛 RangeError，没人接得住，agent 进程以 uncaughtException
 * 退出，同一工作区的会话和 run 一起断了。所以：状态码原样读出来，无正文状态不给流，能不能变成
 * `Response` 由 {@link toWebResponse} 单独判断、以普通 reject 失败。
 */

/** Fetch 规范的 null body status：这些响应没有正文，`Response` 也不许给它们挂正文。 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);
/** `Response` 能表示的状态码区间（含两端）。 */
const MIN_WEB_RESPONSE_STATUS = 200;
const MAX_WEB_RESPONSE_STATUS = 599;
/** Node 没给状态码时（理论上不会）按网关错误对待，与此前的兜底一致。 */
const MISSING_STATUS = 502;

export const UNSUPPORTED_HTTP_STATUS_CODE = "ZCODE_UNSUPPORTED_HTTP_STATUS";

/** 原样读出的响应：状态码不做任何裁剪，正文是流（无正文状态为 `null`）。 */
export interface IncomingResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * `Response` 表示不了的状态码。形状跟随原生 fetch 的网络失败（`TypeError`），调用方按错误码而不是文本区分。
 */
export class UnsupportedHttpStatusError extends TypeError {
  readonly code = UNSUPPORTED_HTTP_STATUS_CODE;

  constructor(readonly status: number) {
    super(
      `HTTP response status ${status} is outside ${MIN_WEB_RESPONSE_STATUS}-${MAX_WEB_RESPONSE_STATUS} and cannot be returned as a fetch Response`,
    );
  }
}

export function readIncomingResponse(message: http.IncomingMessage): IncomingResponse {
  const status = message.statusCode ?? MISSING_STATUS;
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, String(value));
    }
  }
  const nullBody = NULL_BODY_STATUSES.has(status);
  // 无正文状态照样把消息读完，socket 才能回到连接池。
  if (nullBody) message.resume();
  return {
    body: nullBody ? null : (Readable.toWeb(message) as ReadableStream<Uint8Array>),
    headers,
    status,
    statusText: message.statusMessage ?? "",
  };
}

/** 交给只认 `Response` 的调用方（proxy-aware fetch）；表示不了的状态码抛 {@link UnsupportedHttpStatusError}。 */
export function toWebResponse(incoming: IncomingResponse): Response {
  if (incoming.status < MIN_WEB_RESPONSE_STATUS || incoming.status > MAX_WEB_RESPONSE_STATUS) {
    throw new UnsupportedHttpStatusError(incoming.status);
  }
  return new Response(incoming.body, {
    headers: incoming.headers,
    status: incoming.status,
    statusText: incoming.statusText,
  });
}
