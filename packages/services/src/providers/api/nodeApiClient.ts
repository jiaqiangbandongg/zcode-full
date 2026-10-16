import {
  ApiError,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  normalizeZCodeEndpointOrigin,
  rewriteZCodeEndpointUrl,
  type ApiClient,
  type ApiRequestInit,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildZCodeSourceHeaders } from "../sourceHeaders.js";
import { withRequestIdHeader } from "./requestIdHeaders.js";

const log = createServiceLogger("node-api-client");

interface NodeApiClientOptions {
  fetchImpl?: typeof fetch;
  onZcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  isZcodeJwtRequest?: (input: string | URL, headers: Headers) => boolean | Promise<boolean>;
  isBusinessUnauthorizedRequest?: (
    input: string | URL,
    headers: Headers,
  ) => boolean | Promise<boolean>;
  businessUnauthorizedObservationTimeoutMs?: number;
  resolveZCodeEndpointOrigin?: () => Promise<string> | string;
}

const DEFAULT_BUSINESS_UNAUTHORIZED_OBSERVATION_TIMEOUT_MS = 1000;
const MAX_BUSINESS_UNAUTHORIZED_OBSERVATION_BYTES = 64 * 1024;

function readChunkWithinTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeoutMs);
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function resolveMethod(init?: ApiRequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function resolveUrl(input: string | URL): string {
  return typeof input === "string" ? input : input.toString();
}

async function hasBusinessUnauthorizedCode(
  response: Response,
  timeoutMs: number,
): Promise<boolean> {
  // 业务接口把登录过期封装成 HTTP 200，不能只看 status；读副本避免抢走调用方正文。
  // continuous SSE 没有完整 JSON 正文，观察器不能等待流结束或引入恢复语义。
  if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream"))
    return false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const body = response.clone().body;
    if (!body) return false;
    reader = body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    let bytes = 0;
    let text = "";
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      const result = await readChunkWithinTimeout(reader, remainingMs);
      if (!result) return false;
      if (result.done) break;
      if (!result.value) return false;
      bytes += result.value.byteLength;
      if (bytes > MAX_BUSINESS_UNAUTHORIZED_OBSERVATION_BYTES) return false;
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    const payload: unknown = JSON.parse(text);
    return (
      typeof payload === "object" && payload !== null && "code" in payload && payload.code === 401
    );
  } catch {
    // 空正文/HTML/损坏 JSON 只能证明请求异常，不能据此清理登录态。
    return false;
  } finally {
    // 观察副本是 best-effort；超时、超限或解析失败时及时取消，不能占用连接。
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

function readHeaderKeys(headers: RequestInit["headers"] | undefined): string[] {
  if (!headers) {
    return [];
  }
  return [...new Headers(headers).keys()].sort();
}

function isRequestForEndpoint(input: string | URL, endpointOrigin: string): boolean {
  try {
    return new URL(resolveUrl(input)).origin === normalizeZCodeEndpointOrigin(endpointOrigin);
  } catch {
    return false;
  }
}

function withZCodeEndpointHeaders(
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
): RequestInit["headers"] {
  const next = new Headers(buildZCodeSourceHeaders());
  if (headers) {
    new Headers(headers).forEach((value, key) => {
      next.set(key, value);
    });
  }

  if (next.get("HTTP-Referer") === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
    next.set("HTTP-Referer", endpointOrigin);
  }
  return next;
}

function resolveRequestHeaders(
  requestInput: string | URL,
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
): RequestInit["headers"] | undefined {
  if (!isRequestForEndpoint(requestInput, endpointOrigin)) {
    return headers;
  }

  // ZCode 后端请求以前只有部分业务路径手动补来源头。
  // 统一在 ApiClient 出口按 endpoint origin 注入，避免 OAuth/config/billing/snapshot 等链路遗漏。
  return withZCodeEndpointHeaders(headers, endpointOrigin);
}

export class NodeApiClient implements ApiClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly resolveZCodeEndpointOrigin?: () => Promise<string> | string;
  private readonly onZcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  private readonly isZcodeJwtRequest?: NodeApiClientOptions["isZcodeJwtRequest"];
  private readonly isBusinessUnauthorizedRequest?: NodeApiClientOptions["isBusinessUnauthorizedRequest"];
  private readonly businessUnauthorizedObservationTimeoutMs: number;

  constructor(options: NodeApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.onZcodeJwtInvalid = options.onZcodeJwtInvalid;
    this.isZcodeJwtRequest = options.isZcodeJwtRequest;
    this.isBusinessUnauthorizedRequest = options.isBusinessUnauthorizedRequest;
    this.businessUnauthorizedObservationTimeoutMs =
      options.businessUnauthorizedObservationTimeoutMs ??
      DEFAULT_BUSINESS_UNAUTHORIZED_OBSERVATION_TIMEOUT_MS;
    this.resolveZCodeEndpointOrigin = options.resolveZCodeEndpointOrigin;
  }

  async request(input: string | URL, init?: ApiRequestInit): Promise<Response> {
    const endpointOrigin = this.resolveZCodeEndpointOrigin
      ? await this.resolveZCodeEndpointOrigin()
      : undefined;
    const activeEndpointOrigin = endpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
    const requestInput = rewriteZCodeEndpointUrl(input, activeEndpointOrigin);
    const url = resolveUrl(requestInput);
    const method = resolveMethod(init);
    const timeoutMs = init?.timeoutMs;
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    let didTimeout = false;
    const timer =
      controller && timeoutMs
        ? setTimeout(() => {
            didTimeout = true;
            controller.abort();
          }, timeoutMs)
        : null;

    try {
      const signal = controller
        ? init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal
        : init?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const fetchImpl = this.fetchImpl ?? globalThis.fetch;
      const requestHeaders = withRequestIdHeader(
        resolveRequestHeaders(requestInput, init?.headers, activeEndpointOrigin),
      );
      if (isRequestForEndpoint(requestInput, activeEndpointOrigin)) {
        // 调试说明：这里只记录 header key，避免 Authorization / token 等敏感值落盘。
        log.debug(undefined, "zcode endpoint request headers prepared", {
          headerKeys: readHeaderKeys(requestHeaders),
          method,
          url,
        });
      }
      const response = await fetchImpl(requestInput, {
        ...init,
        headers: requestHeaders,
        ...(signal ? { signal } : {}),
      });
      if ((response.status === 401 || response.status === 200) && this.onZcodeJwtInvalid) {
        try {
          const requestHeadersForObservation = new Headers(requestHeaders);
          const isCurrentZCodeJwtRequest = await this.isZcodeJwtRequest?.(
            requestInput,
            requestHeadersForObservation,
          );
          if (
            isCurrentZCodeJwtRequest &&
            (response.status === 401 ||
              ((await this.isBusinessUnauthorizedRequest?.(
                requestInput,
                requestHeadersForObservation,
              )) &&
                (await hasBusinessUnauthorizedCode(
                  response,
                  this.businessUnauthorizedObservationTimeoutMs,
                ))))
          ) {
            this.onZcodeJwtInvalid(requestInput, requestHeadersForObservation);
          }
        } catch (error) {
          log.warn("zcode jwt invalid response observation failed", { error });
        }
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError({
          message:
            didTimeout && timeoutMs ? `Request timed out after ${timeoutMs}ms` : error.message,
          url,
          method,
          cause: error,
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError({
        message,
        url,
        method,
        cause: error,
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export function createNodeApiClient(options: NodeApiClientOptions = {}): ApiClient {
  return new NodeApiClient(options);
}
