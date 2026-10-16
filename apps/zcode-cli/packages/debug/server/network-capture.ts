import { requestSecuritySensitiveHeaders } from "@zcode/shared";
import { existsSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Proxy } from "http-mitm-proxy";
import type { IContext } from "http-mitm-proxy";
import type {
  NetworkCaptureEvent,
  NetworkCaptureStatus,
  NetworkRequestAttribution,
  NetworkRequestRecord,
} from "../src/shared.js";

interface NetworkCaptureServiceOptions {
  enabled?: boolean;
  host?: string;
  port?: number;
  caDir?: string;
  maxEntries?: number;
}

interface NetworkRequestListOptions {
  traceId?: string;
  limit?: number;
}

type NetworkCaptureListener = (event: NetworkCaptureEvent) => void;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4184;
const DEFAULT_MAX_ENTRIES = 300;
const HEADER_REDACTION_VALUE = "[redacted]";
const traceHeaderNames = ["x-zcode-trace-id", "x-trace-id", "traceparent"];
const redactedHeaderNames = new Set([
  ...requestSecuritySensitiveHeaders,
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "openai-api-key",
]);

export class NetworkCaptureService {
  readonly enabled: boolean;

  private readonly host: string;
  private readonly requestedPort: number;
  private readonly caDir: string;
  private readonly maxEntries: number;
  private readonly records = new Map<string, NetworkRequestRecord>();
  private readonly order: string[] = [];
  private readonly listeners = new Set<NetworkCaptureListener>();
  private proxy: Proxy | undefined;
  private running = false;
  private actualPort: number | undefined;
  private lastError: string | undefined;

  constructor(options: NetworkCaptureServiceOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.host = options.host ?? DEFAULT_HOST;
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.caDir = resolve(options.caDir ?? defaultCertificateContainerDir());
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async start(): Promise<void> {
    if (!this.enabled || this.running || this.proxy) return;

    const proxy = new Proxy();
    this.proxy = proxy;
    proxy.onError((ctx, error, errorKind) => {
      const message = [errorKind, error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join(": ");
      this.lastError = message || "network proxy error";
      this.markContextError(ctx, this.lastError);
      this.emit({ type: "status", status: this.getStatus() });
    });

    proxy.onRequest((ctx, callback) => {
      this.captureRequest(ctx);
      callback();
    });

    await new Promise<void>((resolveStart, rejectStart) => {
      proxy.listen(
        {
          host: this.host,
          port: this.requestedPort,
          sslCaDir: this.caDir,
          keepAlive: true,
        },
        (error?: Error | null) => {
          if (error) {
            this.lastError = error.message;
            this.proxy = undefined;
            rejectStart(error);
            return;
          }
          this.running = true;
          this.actualPort = proxy.httpPort;
          this.emit({ type: "status", status: this.getStatus() });
          resolveStart();
        },
      );
    });
  }

  async stop(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = undefined;
    this.running = false;
    if (proxy) {
      await new Promise<void>((resolveStop) => {
        proxy.close();
        resolveStop();
      });
    }
    this.emit({ type: "status", status: this.getStatus() });
  }

  getStatus(): NetworkCaptureStatus {
    const port = this.actualPort ?? this.requestedPort;
    const url = this.enabled ? buildProxyUrl(this.host, port) : undefined;
    const caCertPath = join(this.caDir, "certs", "ca.pem");
    const env: Record<string, string> = url
      ? {
          ZCODE_HTTP_PROXY: url,
          ZCODE_AGENT_CA_CERT: caCertPath,
        }
      : {};

    return {
      enabled: this.enabled,
      running: this.running,
      host: this.enabled ? this.host : undefined,
      port: this.enabled ? port : undefined,
      proxyUrl: url,
      library: "http-mitm-proxy",
      maxEntries: this.maxEntries,
      certificate: {
        caDir: this.enabled ? this.caDir : undefined,
        caCertPath: this.enabled ? caCertPath : undefined,
        caPrivateKeyPath: this.enabled ? join(this.caDir, "keys", "ca.private.key") : undefined,
        caPublicKeyPath: this.enabled ? join(this.caDir, "keys", "ca.public.key") : undefined,
        caCertAvailable: existsSync(caCertPath),
      },
      env,
      lastError: this.lastError,
    };
  }

  listRequests(options: NetworkRequestListOptions = {}): NetworkRequestRecord[] {
    const limit = options.limit ?? this.maxEntries;
    const records: NetworkRequestRecord[] = [];
    for (const id of this.order.toReversed()) {
      const record = this.records.get(id);
      if (!record) continue;
      if (options.traceId && record.traceId !== options.traceId) continue;
      records.push(cloneRecord(record));
      if (records.length >= limit) break;
    }
    return records;
  }

  subscribe(listener: NetworkCaptureListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.records.clear();
    this.order.length = 0;
    this.emit({ type: "reset" });
  }

  private captureRequest(ctx: IContext): void {
    const id = ctx.uuid;
    const requestUrl = buildRequestUrl(ctx);
    const attribution = extractAttribution(ctx.clientToProxyRequest.headers, requestUrl);
    const record: NetworkRequestRecord = {
      id,
      startedAt: new Date().toISOString(),
      protocol: ctx.isSSL ? "https" : "http",
      method: ctx.clientToProxyRequest.method ?? "GET",
      host: requestUrl.host,
      path: requestUrl.pathname + requestUrl.search,
      url: requestUrl.toString(),
      status: "pending",
      requestHeaders: sanitizeHeaders(ctx.clientToProxyRequest.headers),
      responseHeaders: {},
      requestHeaderCount: Object.keys(ctx.clientToProxyRequest.headers).length,
      responseHeaderCount: 0,
      requestBodyBytes: 0,
      responseBodyBytes: 0,
      ...attribution,
    };
    this.upsertRecord(record);
    if (ctx.tags) {
      ctx.tags.zcodeCaptureId = id;
    }

    ctx.onRequestData((requestCtx, chunk, callback) => {
      this.addRequestBytes(requestCtx, chunk.length);
      callback(null, chunk);
    });

    ctx.onResponse((responseCtx, callback) => {
      this.applyResponseHeaders(responseCtx);
      callback();
    });

    ctx.onResponseData((responseCtx, chunk, callback) => {
      this.addResponseBytes(responseCtx, chunk.length);
      callback(null, chunk);
    });

    ctx.onResponseEnd((responseCtx, callback) => {
      this.completeRecord(responseCtx);
      callback();
    });
  }

  private addRequestBytes(ctx: IContext, size: number): void {
    const record = this.recordForContext(ctx);
    if (!record) return;
    record.requestBodyBytes += size;
  }

  private addResponseBytes(ctx: IContext, size: number): void {
    const record = this.recordForContext(ctx);
    if (!record) return;
    record.responseBodyBytes += size;
  }

  private applyResponseHeaders(ctx: IContext): void {
    const record = this.recordForContext(ctx);
    if (!record || !ctx.serverToProxyResponse) return;
    record.statusCode = ctx.serverToProxyResponse.statusCode;
    record.responseHeaders = sanitizeHeaders(ctx.serverToProxyResponse.headers);
    record.responseHeaderCount = Object.keys(ctx.serverToProxyResponse.headers).length;
  }

  private completeRecord(ctx: IContext): void {
    const record = this.recordForContext(ctx);
    if (!record) return;
    this.applyResponseHeaders(ctx);
    record.status = "complete";
    record.completedAt = new Date().toISOString();
    record.durationMs = durationMs(record.startedAt, record.completedAt);
    this.upsertRecord(record);
  }

  private markContextError(ctx: IContext | null, message: string): void {
    const record = ctx ? this.recordForContext(ctx) : undefined;
    if (!record) return;
    record.status = "error";
    record.error = message;
    record.completedAt = new Date().toISOString();
    record.durationMs = durationMs(record.startedAt, record.completedAt);
    this.upsertRecord(record);
  }

  private recordForContext(ctx: IContext): NetworkRequestRecord | undefined {
    const id = stringValue(ctx.tags?.zcodeCaptureId) ?? ctx.uuid;
    return this.records.get(id);
  }

  private upsertRecord(record: NetworkRequestRecord): void {
    if (!this.records.has(record.id)) {
      this.order.push(record.id);
    }
    this.records.set(record.id, record);
    while (this.order.length > this.maxEntries) {
      const oldestId = this.order.shift();
      if (oldestId) this.records.delete(oldestId);
    }
    this.emit({ type: "request", request: cloneRecord(record) });
  }

  private emit(event: NetworkCaptureEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export function disabledNetworkCaptureStatus(): NetworkCaptureStatus {
  return {
    enabled: false,
    running: false,
    library: "http-mitm-proxy",
    maxEntries: 0,
    certificate: {
      caCertAvailable: false,
    },
    env: {},
  };
}

export function createNetworkCaptureServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NetworkCaptureService | undefined {
  if (isDisabled(env.ZCODE_DEBUG_NETWORK_CAPTURE)) return undefined;
  return new NetworkCaptureService({
    host: env.ZCODE_DEBUG_NETWORK_HOST || undefined,
    port: parsePositiveInteger(env.ZCODE_DEBUG_NETWORK_PORT) ?? DEFAULT_PORT,
    caDir: env.ZCODE_DEBUG_NETWORK_CA_DIR || undefined,
    maxEntries: parsePositiveInteger(env.ZCODE_DEBUG_NETWORK_MAX_ENTRIES) ?? DEFAULT_MAX_ENTRIES,
  });
}

function defaultCertificateContainerDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const parentDir = dirname(moduleDir);
  const debugRoot = basename(parentDir) === "dist-server" ? dirname(parentDir) : parentDir;
  return join(debugRoot, "certs", "network-ca");
}

export function extractAttribution(
  headers: IncomingHttpHeaders,
  url: URL,
): NetworkRequestAttribution {
  const traceId =
    firstHeader(headers, traceHeaderNames) ?? queryValue(url, ["traceId", "trace_id"]);
  return {
    traceId: normalizeTraceparent(traceId),
  };
}

export function sanitizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    sanitized[normalizedName] = redactedHeaderNames.has(normalizedName)
      ? HEADER_REDACTION_VALUE
      : headerToString(value);
  }
  return sanitized;
}

function buildRequestUrl(ctx: IContext): URL {
  const request = ctx.clientToProxyRequest;
  const rawUrl = request.url ?? "/";
  if (/^https?:\/\//i.test(rawUrl)) {
    return new URL(rawUrl);
  }

  const protocol = ctx.isSSL ? "https" : "http";
  const host = stringValue(request.headers.host) ?? "unknown.local";
  const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return new URL(`${protocol}://${host}${path}`);
}

function firstHeader(headers: IncomingHttpHeaders, names: string[]): string | undefined {
  for (const name of names) {
    const value = stringValue(headers[name]);
    if (value) return value;
  }
  return undefined;
}

function queryValue(url: URL, names: string[]): string | undefined {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value) return value;
  }
  return undefined;
}

function normalizeTraceparent(value?: string): string | undefined {
  if (!value) return undefined;
  const parts = value.split("-");
  if (
    parts.length === 4 &&
    /^[\da-f]{2}$/i.test(parts[0] ?? "") &&
    /^[\da-f]{32}$/i.test(parts[1] ?? "") &&
    /^[\da-f]{16}$/i.test(parts[2] ?? "") &&
    /^[\da-f]{2}$/i.test(parts[3] ?? "")
  ) {
    return parts[1];
  }
  return value;
}

function headerToString(value: IncomingHttpHeaders[string]): string {
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined ? "" : String(value);
}

function stringValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return stringValue(value[0]);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function durationMs(start: string, end: string): number {
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

function parsePositiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isDisabled(value?: string): boolean {
  if (!value) return false;
  return ["0", "false", "off", "no"].includes(value.toLowerCase());
}

function buildProxyUrl(host: string, port: number): string {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

function cloneRecord(record: NetworkRequestRecord): NetworkRequestRecord {
  return {
    ...record,
    requestHeaders: { ...record.requestHeaders },
    responseHeaders: { ...record.responseHeaders },
  };
}
