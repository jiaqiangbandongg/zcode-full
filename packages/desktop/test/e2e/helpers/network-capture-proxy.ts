/* eslint-disable max-lines -- E2E 抓包代理需要集中维护 MITM、脱敏、chunk timeline、SSE event 解析和 artifact 序列化，拆开会让录制协议更难追踪。 */
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { rootCertificates } from "node:tls";
import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
} from "@zcode/shared";
import { Proxy } from "http-mitm-proxy";
import type { IContext } from "http-mitm-proxy";
import { writeE2EJsonFileAtomically } from "./e2e-atomic-json-file.js";
import {
  redactE2ENetworkCaptureJson,
  redactE2ENetworkCaptureJsonText,
  sanitizeE2ENetworkCaptureHeaders,
  shouldRecordE2ENetworkResponseChunkTimeline,
} from "./e2e-network-capture-redaction.js";

const DEFAULT_RESPONSE_PREVIEW_BYTES = 64 * 1024;
const DEFAULT_RESPONSE_CHUNK_TIMELINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_BODY_BYTES = 512 * 1024;
export const DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY = [
  "localhost",
  "127.0.0.1",
  "::1",
  "js.stripe.com",
  "zcode.z.ai",
  // Plugin 商店原始图标 CDN 不需要进入模型请求抓包；直连也避免 Electron MITM 证书导致图片回退。
  "cdn-zcode.z.ai",
  "cdn.zcode-ai.com",
].join(",");
export interface E2ENetworkCaptureRecord {
  completedAt?: string;
  durationMs?: number;
  error?: string;
  host: string;
  id: string;
  method: string;
  path: string;
  protocol: "http" | "https";
  requestBodyBytes: number;
  requestBodyTruncated?: boolean;
  requestHeaders: Record<string, string>;
  requestJson?: unknown;
  requestTextPreview?: string;
  replay?: {
    closeMode?: "end" | "destroy";
    fixtureId?: string;
  };
  responseBodyBytes: number;
  responseBodyTruncated?: boolean;
  responseChunkTimeline?: E2ENetworkResponseChunk[];
  responseChunkTimelineTruncated?: boolean;
  responseEvents?: E2ENetworkCaptureResponseEvent[];
  responseHeaders: Record<string, string>;
  responseTextPreview?: string;
  startedAt: string;
  status: "pending" | "complete" | "error";
  statusCode?: number;
  statusMessage?: string;
  url: string;
}

export interface E2ENetworkResponseChunk {
  base64: string;
  byteLength: number;
  offsetMs: number;
}

export interface E2ENetworkCaptureResponseEvent {
  byteLength: number;
  offsetMs: number;
  partial?: boolean;
  sequence: number;
  text: string;
}

export interface E2ENetworkCaptureArtifact {
  generatedAt: string;
  proxy: {
    caCertPath: string;
    host: string;
    port: number;
    proxyUrl: string;
  };
  records: E2ENetworkCaptureRecord[];
  version: 1;
}

export interface E2ENetworkCaptureProxy {
  artifactPath: string;
  caCertPath: string;
  env: Record<string, string>;
  proxyUrl: string;
  stop(): Promise<void>;
}

interface StartNetworkCaptureProxyOptions {
  artifactPath: string;
  caDir: string;
  host?: string;
  port?: number;
  requestBodyLimitBytes?: number;
  responseChunkTimelineLimitBytes?: number;
  responsePreviewLimitBytes?: number;
  recordResponseChunkTimeline?: boolean;
  responseMocks?: readonly E2ENetworkCaptureResponseMock[];
}

export interface E2ENetworkCaptureResponseMock {
  /** case-local 回放可按请求体选择固定响应，仍经真实 HTTPS/鉴权/SDK 路径。 */
  body: string | ((requestBody: string) => string);
  headers?: Record<string, string>;
  host?: string;
  method?: string;
  path: string;
  statusCode?: number;
  statusMessage?: string;
}

interface MutableCaptureRecord extends E2ENetworkCaptureRecord {
  requestChunks: Buffer[];
  responseChunkTimelineBytes: number;
  responseChunks: Buffer[];
  responseSseBuffer: string;
  responseSseStartedAtMs?: number;
}

export async function startE2ENetworkCaptureProxy(
  options: StartNetworkCaptureProxyOptions,
): Promise<E2ENetworkCaptureProxy> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const caDir = resolve(options.caDir);
  const artifactPath = resolve(options.artifactPath);
  const requestBodyLimitBytes = options.requestBodyLimitBytes ?? DEFAULT_REQUEST_BODY_BYTES;
  const recordResponseChunkTimeline = options.recordResponseChunkTimeline ?? false;
  const responseChunkTimelineLimitBytes =
    options.responseChunkTimelineLimitBytes ?? DEFAULT_RESPONSE_CHUNK_TIMELINE_BYTES;
  const responsePreviewLimitBytes =
    options.responsePreviewLimitBytes ?? DEFAULT_RESPONSE_PREVIEW_BYTES;
  await removeUnusableE2ENetworkCaptureLeafCertificates(caDir);
  const records = new Map<string, MutableCaptureRecord>();
  const order: string[] = [];
  const proxy = new Proxy();
  let artifactWriteQueue = Promise.resolve();

  const writeArtifact = () => {
    const artifact = {
      generatedAt: new Date().toISOString(),
      proxy: {
        caCertPath: join(caDir, "certs", "ca.pem"),
        host,
        port: proxy.httpPort,
        proxyUrl: buildProxyUrl(host, proxy.httpPort),
      },
      records: order
        .map((id) => records.get(id))
        .filter((record): record is MutableCaptureRecord => Boolean(record))
        .map(serializeRecord),
      version: 1,
    } satisfies E2ENetworkCaptureArtifact;
    // Proxy hooks 不能 await 文件 IO；把快照串行排队，并在边界处显式 flush。
    // 单次证据写失败只记录 warn，不能反向阻塞真实 provider 网络回调。
    artifactWriteQueue = artifactWriteQueue
      .catch(() => undefined)
      .then(() => writeE2EJsonFileAtomically(artifactPath, artifact))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[e2e-network-capture] artifact write failed: ${message}`);
      });
  };

  proxy.onError((ctx, error, errorKind) => {
    const message = [errorKind, error instanceof Error ? error.message : String(error)]
      .filter(Boolean)
      .join(": ");
    markContextError(ctx, message || "network proxy error");
    writeArtifact();
  });

  proxy.onRequest((ctx, callback) => {
    const record = createRecord(ctx);
    records.set(record.id, record);
    order.push(record.id);
    tagContext(ctx, record.id);
    writeArtifact();

    ctx.onRequestData((requestCtx, chunk, dataCallback) => {
      const current = recordForContext(requestCtx);
      if (current) {
        current.requestBodyBytes += chunk.length;
        appendLimitedChunk(current.requestChunks, chunk, requestBodyLimitBytes);
      }
      dataCallback(null, chunk);
    });

    ctx.onRequestEnd((requestCtx, endCallback) => {
      const current = recordForContext(requestCtx);
      if (current) {
        applyRequestBody(current, requestBodyLimitBytes);
        writeArtifact();
      }
      endCallback();
    });

    ctx.onResponse((responseCtx, responseCallback) => {
      applyResponseHeaders(responseCtx);
      writeArtifact();
      responseCallback();
    });

    ctx.onResponseData((responseCtx, chunk, dataCallback) => {
      const current = recordForContext(responseCtx);
      if (current) {
        current.responseBodyBytes += chunk.length;
        appendLimitedChunk(current.responseChunks, chunk, responsePreviewLimitBytes);
        // 修复原因：部分接口的 JSON 响应含密钥密文；若录原始 base64 chunk，
        // 即使 text preview 已脱敏，密钥材料仍会旁路落盘。chunk timeline 只服务 SSE 回放。
        if (
          shouldRecordE2ENetworkResponseChunkTimeline(
            recordResponseChunkTimeline,
            current.responseHeaders,
          )
        ) {
          appendResponseTimelineChunk(current, chunk, responseChunkTimelineLimitBytes);
        }
        appendSseResponseEvents(current, chunk);
      }
      dataCallback(null, chunk);
    });

    ctx.onResponseEnd((responseCtx, endCallback) => {
      const current = recordForContext(responseCtx);
      if (current) {
        applyResponseHeaders(responseCtx);
        current.status = "complete";
        current.completedAt = new Date().toISOString();
        current.durationMs = durationMs(current.startedAt, current.completedAt);
        flushPartialSseResponseEvent(current);
        applyResponsePreview(current, responsePreviewLimitBytes);
        writeArtifact();
      }
      endCallback();
    });

    const mockResponse = findResponseMock(record, options.responseMocks);
    if (mockResponse) {
      serveResponseMock(ctx, record, mockResponse);
      return;
    }

    callback();
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    proxy.listen(
      {
        host,
        keepAlive: true,
        port: requestedPort,
        sslCaDir: caDir,
      },
      (error?: Error | null) => {
        if (error) {
          rejectStart(error);
          return;
        }
        resolveStart();
      },
    );
  });

  const caCertPath = join(caDir, "certs", "ca.pem");
  if (!existsSync(caCertPath)) {
    throw new Error(`E2E network capture CA was not generated: ${caCertPath}`);
  }
  const caBundlePath = writeCombinedCaBundle(caDir, caCertPath);

  writeArtifact();
  await artifactWriteQueue;

  const proxyUrl = buildProxyUrl(host, proxy.httpPort);
  const env = buildProxyEnv(proxyUrl, caCertPath, caBundlePath);

  return {
    artifactPath,
    caCertPath,
    env,
    proxyUrl,
    async stop() {
      proxy.close();
      writeArtifact();
      await artifactWriteQueue;
    },
  };

  function recordForContext(ctx: IContext): MutableCaptureRecord | undefined {
    const id = stringValue(ctx.tags?.zcodeCaptureId) ?? ctx.uuid;
    return records.get(id);
  }

  function markContextError(ctx: IContext | null, message: string) {
    if (!ctx) {
      return;
    }
    const current = recordForContext(ctx);
    if (!current) {
      return;
    }
    current.status = "error";
    current.error = message;
    current.completedAt = new Date().toISOString();
    current.durationMs = durationMs(current.startedAt, current.completedAt);
  }

  function applyResponseHeaders(ctx: IContext) {
    const current = recordForContext(ctx);
    if (!current || !ctx.serverToProxyResponse) {
      return;
    }
    current.statusCode = ctx.serverToProxyResponse.statusCode;
    current.statusMessage = ctx.serverToProxyResponse.statusMessage;
    current.responseHeaders = sanitizeE2ENetworkCaptureHeaders(ctx.serverToProxyResponse.headers);
  }

  function findResponseMock(
    record: E2ENetworkCaptureRecord,
    responseMocks: readonly E2ENetworkCaptureResponseMock[] | undefined,
  ) {
    const requestUrl = new URL(record.url);
    return responseMocks?.find(
      (mock) =>
        (mock.host === undefined || mock.host === requestUrl.host) &&
        (mock.method === undefined || mock.method === record.method) &&
        mock.path === requestUrl.pathname,
    );
  }

  function serveResponseMock(
    ctx: IContext,
    record: MutableCaptureRecord,
    mock: E2ENetworkCaptureResponseMock,
  ) {
    const requestChunks: Buffer[] = [];
    let requestBodyBytes = 0;
    const finish = () => {
      applyMockRequestBody(record, requestChunks, requestBodyBytes, requestBodyLimitBytes);

      const body = Buffer.from(
        typeof mock.body === "function"
          ? mock.body(Buffer.concat(requestChunks).toString("utf8"))
          : mock.body,
        "utf-8",
      );
      const responseHeaders = {
        "content-length": String(body.length),
        "content-type": "application/json; charset=utf-8",
        connection: "close",
        ...mock.headers,
      };
      ctx.proxyToClientResponse.writeHead(mock.statusCode ?? 200, responseHeaders);
      ctx.proxyToClientResponse.end(body);

      record.responseBodyBytes = body.length;
      record.responseHeaders = sanitizeE2ENetworkCaptureHeaders(responseHeaders);
      record.responseTextPreview = redactE2ENetworkCaptureJsonText(body.toString("utf-8"));
      record.status = "complete";
      record.statusCode = mock.statusCode ?? 200;
      record.statusMessage = mock.statusMessage ?? "OK";
      record.completedAt = new Date().toISOString();
      record.durationMs = durationMs(record.startedAt, record.completedAt);
      writeArtifact();
    };

    // 未调用 callback() 时 http-mitm-proxy 不会替我们消费请求流；主动 drain，
    // 避免客户端在发送控制面 POST body 时因 backpressure 卡住。
    ctx.clientToProxyRequest.on("data", (chunk: Buffer) => {
      requestBodyBytes += chunk.length;
      appendLimitedChunk(requestChunks, chunk, requestBodyLimitBytes);
    });
    ctx.clientToProxyRequest.once("end", finish);
    ctx.clientToProxyRequest.resume();
  }
}

function applyMockRequestBody(
  record: MutableCaptureRecord,
  chunks: Buffer[],
  bodyBytes: number,
  limitBytes: number,
) {
  record.requestBodyBytes = bodyBytes;
  record.requestBodyTruncated = bodyBytes > limitBytes;
  const body = Buffer.concat(chunks);
  if (body.length === 0) {
    return;
  }
  const text = body.toString("utf-8");
  try {
    record.requestJson = redactE2ENetworkCaptureJson(JSON.parse(text));
  } catch {
    record.requestTextPreview = text;
  }
}

export async function removeUnusableE2ENetworkCaptureLeafCertificates(
  caDir: string,
  now = new Date(),
): Promise<void> {
  const certsDir = join(caDir, "certs");
  let certificateNames: string[];
  try {
    certificateNames = await readdir(certsDir);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  await Promise.all(
    certificateNames
      .filter((name) => name.endsWith(".pem") && name !== "ca.pem" && name !== "ca-bundle.pem")
      .map(async (name) => {
        const certificatePath = join(certsDir, name);
        const host = name.slice(0, -".pem".length);
        const privateKeyPath = join(caDir, "keys", `${host}.key`);
        let usable = false;
        try {
          const certificate = new X509Certificate(await readFile(certificatePath, "utf8"));
          const certificatePublicKey = certificate.publicKey.export({
            format: "der",
            type: "spki",
          });
          const privateKeyPublicKey = createPublicKey(
            createPrivateKey(await readFile(privateKeyPath)),
          ).export({
            format: "der",
            type: "spki",
          });
          usable =
            Date.parse(certificate.validFrom) <= now.getTime() &&
            Date.parse(certificate.validTo) > now.getTime() &&
            certificatePublicKey.equals(privateKeyPublicKey);
        } catch {
          usable = false;
        }
        if (usable) {
          return;
        }

        // 修复原因：http-mitm-proxy 会长期复用域名叶子证书，过期或并发生成中断后还可能
        // 留下证书/私钥不匹配；删除不可用叶子，让下一次 CONNECT 按现有 CA 重新生成。
        await Promise.all([
          rm(certificatePath, { force: true }),
          rm(privateKeyPath, { force: true }),
          rm(join(caDir, "keys", `${host}.public.key`), { force: true }),
        ]);
      }),
  );
}

function isFileSystemError(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code,
  );
}

function createRecord(ctx: IContext): MutableCaptureRecord {
  const requestUrl = buildRequestUrl(ctx);
  return {
    host: requestUrl.host,
    id: ctx.uuid,
    method: ctx.clientToProxyRequest.method ?? "GET",
    path: requestUrl.pathname + requestUrl.search,
    protocol: ctx.isSSL ? "https" : "http",
    requestBodyBytes: 0,
    requestChunks: [],
    requestHeaders: sanitizeE2ENetworkCaptureHeaders(ctx.clientToProxyRequest.headers),
    responseBodyBytes: 0,
    responseChunkTimelineBytes: 0,
    responseChunks: [],
    responseSseBuffer: "",
    responseHeaders: {},
    startedAt: new Date().toISOString(),
    status: "pending",
    url: requestUrl.toString(),
  };
}

function appendSseResponseEvents(record: MutableCaptureRecord, chunk: Buffer) {
  if (!isSseResponse(record)) {
    return;
  }

  // 修复原因：SSE 自动化需要稳定的 event 语义和相对时间，TCP chunk 边界不可复现。
  // 这里累积文本后按 SSE 空行分隔符吐出完整 event。
  if (record.responseSseStartedAtMs === undefined) {
    record.responseSseStartedAtMs = Date.now();
  }
  record.responseSseBuffer += chunk.toString("utf-8");
  drainCompleteSseEvents(record, false);
}

function flushPartialSseResponseEvent(record: MutableCaptureRecord) {
  if (!isSseResponse(record) || record.responseSseBuffer.length === 0) {
    return;
  }
  drainCompleteSseEvents(record, true);
}

function drainCompleteSseEvents(record: MutableCaptureRecord, flushPartial: boolean) {
  while (record.responseSseBuffer.length > 0) {
    const boundary = findSseEventBoundary(record.responseSseBuffer);
    if (!boundary) {
      if (flushPartial) {
        pushSseEvent(record, record.responseSseBuffer, true);
        record.responseSseBuffer = "";
      }
      return;
    }

    const text = record.responseSseBuffer.slice(0, boundary.endIndex);
    record.responseSseBuffer = record.responseSseBuffer.slice(boundary.endIndex);
    pushSseEvent(record, text, false);
  }
}

function pushSseEvent(record: MutableCaptureRecord, text: string, partial: boolean) {
  const startedAtMs = record.responseSseStartedAtMs ?? Date.now();
  record.responseEvents ??= [];
  record.responseEvents.push({
    byteLength: Buffer.byteLength(text, "utf-8"),
    offsetMs: Math.max(0, Date.now() - startedAtMs),
    ...(partial ? { partial: true } : {}),
    sequence: record.responseEvents.length,
    text,
  });
}

function findSseEventBoundary(text: string): { endIndex: number } | null {
  const candidates = ["\r\n\r\n", "\n\n", "\r\r"]
    .map((separator) => {
      const index = text.indexOf(separator);
      return index < 0 ? null : { endIndex: index + separator.length };
    })
    .filter((candidate): candidate is { endIndex: number } => Boolean(candidate))
    .sort((left, right) => left.endIndex - right.endIndex);
  return candidates[0] ?? null;
}

function isSseResponse(record: Pick<E2ENetworkCaptureRecord, "responseHeaders">): boolean {
  return (
    record.responseHeaders["content-type"]?.toLowerCase().includes("text/event-stream") ?? false
  );
}

function tagContext(ctx: IContext, id: string) {
  // 修复原因：http-mitm-proxy 的同一个请求会跨多个回调阶段流转，e2e 需要用
  // 稳定 id 把 request/response 数据合并到同一条 artifact 记录。
  const tags = (ctx.tags ?? {}) as IContext["tags"] & { zcodeCaptureId?: string };
  tags.zcodeCaptureId = id;
  ctx.tags = tags;
}

function buildRequestUrl(ctx: IContext): URL {
  const rawUrl = ctx.clientToProxyRequest.url ?? "/";
  if (/^https?:\/\//i.test(rawUrl)) {
    return new URL(rawUrl);
  }

  const protocol = ctx.isSSL ? "https" : "http";
  const host = stringValue(ctx.clientToProxyRequest.headers.host) ?? "unknown.local";
  const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return new URL(`${protocol}://${host}${path}`);
}

function applyRequestBody(record: MutableCaptureRecord, limitBytes: number) {
  const body = Buffer.concat(record.requestChunks);
  record.requestBodyTruncated = record.requestBodyBytes > limitBytes;
  if (body.length === 0) {
    return;
  }

  const text = body.toString("utf-8");
  try {
    record.requestJson = redactE2ENetworkCaptureJson(JSON.parse(text));
  } catch {
    record.requestTextPreview = text;
  }
}

function applyResponsePreview(record: MutableCaptureRecord, limitBytes: number) {
  const body = Buffer.concat(record.responseChunks);
  record.responseBodyTruncated = record.responseBodyBytes > limitBytes;
  if (body.length > 0) {
    record.responseTextPreview = redactE2ENetworkCaptureJsonText(body.toString("utf-8"));
  }
}

function appendLimitedChunk(chunks: Buffer[], chunk: Buffer, limitBytes: number) {
  const currentBytes = chunks.reduce((total, item) => total + item.length, 0);
  if (currentBytes >= limitBytes) {
    return;
  }
  const remaining = limitBytes - currentBytes;
  chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : Buffer.from(chunk));
}

function appendResponseTimelineChunk(
  record: MutableCaptureRecord,
  chunk: Buffer,
  limitBytes: number,
) {
  if (!record.responseChunkTimeline) {
    record.responseChunkTimeline = [];
  }

  if (record.responseChunkTimelineBytes >= limitBytes) {
    record.responseChunkTimelineTruncated = true;
    return;
  }

  const remainingBytes = limitBytes - record.responseChunkTimelineBytes;
  const storedChunk = chunk.length > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
  record.responseChunkTimeline.push({
    base64: Buffer.from(storedChunk).toString("base64"),
    byteLength: chunk.length,
    offsetMs: Math.max(0, Date.now() - Date.parse(record.startedAt)),
  });
  record.responseChunkTimelineBytes += storedChunk.length;

  if (storedChunk.length < chunk.length) {
    record.responseChunkTimelineTruncated = true;
  }
}

function serializeRecord(record: MutableCaptureRecord): E2ENetworkCaptureRecord {
  const {
    requestChunks: _requestChunks,
    responseChunkTimelineBytes: _responseChunkTimelineBytes,
    responseChunks: _responseChunks,
    responseSseBuffer: _responseSseBuffer,
    responseSseStartedAtMs: _responseSseStartedAtMs,
    ...serialized
  } = record;
  return serialized;
}

function writeCombinedCaBundle(caDir: string, caCertPath: string): string {
  const caBundlePath = join(caDir, "certs", "ca-bundle.pem");
  const configuredCaFiles = [
    ...new Set(
      [process.env.NODE_EXTRA_CA_CERTS, process.env.SSL_CERT_FILE]
        .map((path) => path?.trim())
        .filter((path): path is string => Boolean(path)),
    ),
  ].filter((path) => existsSync(path));
  const certificates = [
    ...rootCertificates,
    ...configuredCaFiles.map((path) => readFileSync(path, "utf-8")),
    readFileSync(caCertPath, "utf-8"),
  ];

  // 修复原因：只把 MITM CA 写入 SSL_CERT_FILE 会覆盖 Node 的公共根证书，
  // 抓包代理随后访问真实上游时会误报 self-signed certificate in certificate chain。
  writeFileSync(
    caBundlePath,
    `${certificates.map((certificate) => certificate.trim()).join("\n")}\n`,
    "utf-8",
  );
  return caBundlePath;
}

function buildProxyEnv(
  proxyUrl: string,
  caCertPath: string,
  caBundlePath: string,
): Record<string, string> {
  const noProxy = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
  return {
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    CURL_CA_BUNDLE: caBundlePath,
    GIT_SSL_CAINFO: caBundlePath,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    NODE_EXTRA_CA_CERTS: caBundlePath,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    REQUESTS_CA_BUNDLE: caBundlePath,
    SSL_CERT_FILE: caBundlePath,
    // Bugfix: agent provider fetch 会过滤标准 HTTP_PROXY/HTTPS_PROXY，只认
    // ZCode 显式网络出口配置；否则真实模型请求会直连上游，capture artifact 为空。
    [ZCODE_AGENT_CA_CERT_ENV_KEY]: caCertPath,
    [ZCODE_HTTP_PROXY_ENV_KEY]: proxyUrl,
    [ZCODE_NO_PROXY_ENV_KEY]: noProxy,
  };
}

function buildProxyUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function durationMs(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function stringValue(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  if (value === undefined) {
    return undefined;
  }
  return String(value);
}
