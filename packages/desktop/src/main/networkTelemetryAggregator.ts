import { computeAggregateStats, type AggregateStats } from "./resourceMetricsStats.js";
import type { NetworkObservation, NetworkTransportKind } from "@zcode/rpc";

export type NetworkErrorKind =
  | "timeout"
  | "dns_failure"
  | "connection_reset"
  | "proxy_error"
  | "tls_error"
  | "server_error"
  | "client_error"
  | "other";

const NETWORK_ERROR_KIND_ORDER: readonly NetworkErrorKind[] = [
  "timeout",
  "dns_failure",
  "connection_reset",
  "proxy_error",
  "tls_error",
  "server_error",
  "client_error",
  "other",
];

export interface InterfaceNetworkStats {
  transport: NetworkTransportKind;
  interface: string;
  requestTotal: number;
  successCount: number;
  failCount: number;
  retryCount: number;
  primaryErrorKind?: NetworkErrorKind;
  primaryErrorCount: number;
  duration: AggregateStats;
  dns: AggregateStats;
  tcp: AggregateStats;
  tls: AggregateStats;
  ttfb: AggregateStats;
  download: AggregateStats;
  errorCounts: Partial<Record<NetworkErrorKind, number>>;
}

interface InterfaceBucket {
  transport: NetworkTransportKind;
  interface: string;
  durations: number[];
  dns: number[];
  tcp: number[];
  tls: number[];
  ttfb: number[];
  download: number[];
  successCount: number;
  failCount: number;
  retryCount: number;
  errorCounts: Map<NetworkErrorKind, number>;
}

const buckets = new Map<string, InterfaceBucket>();
export const MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT = 128;

const NETWORK_ERROR_KINDS = new Set<string>(NETWORK_ERROR_KIND_ORDER);

/**
 * 只有仓内已知、低基数的 API 路由段可以进入 ARMS；其他段统一视为动态标识。
 * 新增静态接口时必须显式登记，避免把用户 slug、邮箱或路径片段误当作安全路由。
 */
const STATIC_HTTP_PATH_SEGMENTS = new Set([
  "anthropic",
  "api",
  "authorize",
  "availability",
  "balance",
  "billing",
  "biz",
  "bootstrap",
  "cancel",
  "claim",
  "client",
  "coding-plan",
  "configs",
  "customer",
  "electron",
  "enterprise",
  "event",
  "getCustomerInfo",
  "health",
  "latest",
  "manifest",
  "messages",
  "mcp",
  "mobile-view-state",
  "models",
  "oauth",
  "off-peak",
  "order",
  "orders",
  "organization",
  "pay",
  "pending",
  "platform",
  "preview",
  "pricing",
  "projects",
  "releases",
  "remote-control",
  "report",
  "reset",
  "responses",
  "rpc-host-capability",
  "scenes",
  "server-info",
  "sessions",
  "snapshot",
  "status",
  "subscription",
  "tasks",
  "ticket",
  "token",
  "upload-credential",
  "usage",
  "users",
  "v1",
  "v2",
  "v3",
  "v4",
  "windows",
  "workspace-bridge",
  "zcode-plan",
]);

function normalizeErrorKind(value: string | undefined): NetworkErrorKind {
  const normalized = value?.trim().toLowerCase();
  return normalized && NETWORK_ERROR_KINDS.has(normalized)
    ? (normalized as NetworkErrorKind)
    : "other";
}

function bucketKey(transport: NetworkTransportKind, iface: string): string {
  return `${transport}\0${iface}`;
}

function canonicalInterface(transport: NetworkTransportKind, value: string): string {
  if (transport === "http") {
    return normalizeHttpInterface(value);
  }
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.:-]+/gu, "_");
  return (normalized || "unknown").slice(0, 120);
}

function resolveBucketInterface(transport: NetworkTransportKind, value: string): string {
  const iface = canonicalInterface(transport, value);
  if (buckets.has(bucketKey(transport, iface))) {
    return iface;
  }
  let transportBucketCount = 0;
  for (const bucket of buckets.values()) {
    if (bucket.transport === transport) {
      transportBucketCount += 1;
    }
  }
  if (
    iface !== "other" &&
    transportBucketCount >= MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT - 1
  ) {
    return "other";
  }
  return iface;
}

function getOrCreateBucket(observation: NetworkObservation): InterfaceBucket {
  const iface = resolveBucketInterface(observation.transport, observation.interface);
  const key = bucketKey(observation.transport, iface);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      transport: observation.transport,
      interface: iface,
      durations: [],
      dns: [],
      tcp: [],
      tls: [],
      ttfb: [],
      download: [],
      successCount: 0,
      failCount: 0,
      retryCount: 0,
      errorCounts: new Map(),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

function pushIfPositive(target: number[], value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return;
  }
  target.push(value);
}

export function recordNetworkObservation(observation: NetworkObservation): void {
  const bucket = getOrCreateBucket(observation);
  bucket.durations.push(observation.durationMs);
  pushIfPositive(bucket.dns, observation.dnsMs);
  pushIfPositive(bucket.tcp, observation.tcpMs);
  pushIfPositive(bucket.tls, observation.tlsMs);
  pushIfPositive(bucket.ttfb, observation.ttfbMs);
  pushIfPositive(bucket.download, observation.downloadMs);

  if (observation.ok) {
    bucket.successCount += 1;
  } else {
    bucket.failCount += 1;
    const kind = normalizeErrorKind(observation.errorKind);
    bucket.errorCounts.set(kind, (bucket.errorCounts.get(kind) ?? 0) + 1);
  }

  const attempt = observation.attempt ?? 1;
  if (attempt > 1) {
    bucket.retryCount += attempt - 1;
  }
}

export function normalizeHttpInterface(name?: string, url?: string): string {
  const raw = (url ?? name ?? "").trim();
  if (!raw) {
    return "unknown";
  }
  if (
    /^file:/iu.test(raw) ||
    /^[a-zA-Z]:[\\/]/u.test(raw) ||
    // Bug 根因：枚举常见根目录会漏掉 /opt、/root、/mnt 等合法 POSIX 绝对路径。
    raw.startsWith("/")
  ) {
    return "local_file";
  }
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (parsed.protocol === "file:" || !parsed.host) {
      return "local_file";
    }
    const path = parsed.pathname
      .split("/")
      .map((segment) => normalizeHttpPathSegment(segment))
      .join("/")
      .replace(/\/+$/u, "");
    return `${parsed.host}${path}`.slice(0, 120);
  } catch {
    return "unknown";
  }
}

function normalizeHttpPathSegment(segment: string): string {
  const decoded = safeDecodeURIComponent(segment);
  if (!decoded || STATIC_HTTP_PATH_SEGMENTS.has(decoded)) {
    return decoded;
  }
  // Bug 根因：旧实现默认保留未命中规则的 segment，邮箱和短用户 slug 会直接进入 ARMS。
  return ":id";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function ingestArmsApiEvent(event: Record<string, unknown>): void {
  const eventType = String(event.event_type ?? event.type ?? "").toLowerCase();
  if (eventType !== "api" && !eventType.includes("resource")) {
    return;
  }

  const url =
    typeof event.name === "string" ? event.name : typeof event.url === "string" ? event.url : "";
  const statusCode =
    typeof event.status_code === "number"
      ? event.status_code
      : typeof event.status_code === "string"
        ? Number(event.status_code)
        : undefined;
  const successFlag = event.success;
  const ok =
    successFlag === true ||
    successFlag === 1 ||
    successFlag === "1" ||
    (typeof statusCode === "number" && statusCode >= 200 && statusCode < 400);

  const times = typeof event.times === "number" ? event.times : 1;
  const duration =
    typeof event.duration === "number"
      ? event.duration
      : typeof event.duration === "string"
        ? Number(event.duration)
        : 0;

  recordNetworkObservation({
    transport: "http",
    interface: normalizeHttpInterface(url, url),
    durationMs: Number.isFinite(duration) ? duration : 0,
    ok,
    statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
    errorKind: ok ? undefined : classifyHttpError(statusCode),
    attempt: times,
    dnsMs: readDurationField(event, "dns_duration"),
    tcpMs: readDurationField(event, "connect_duration"),
    tlsMs: readDurationField(event, "ssl_duration"),
    ttfbMs: readDurationField(event, "first_byte_duration"),
    downloadMs: readDurationField(event, "download_duration"),
  });
}

function readDurationField(event: Record<string, unknown>, key: string): number | undefined {
  const raw = event[key];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function classifyHttpError(statusCode?: number): string {
  if (statusCode === 408) {
    return "timeout";
  }
  if (statusCode === 0) {
    return "connection_reset";
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return "server_error";
  }
  if (statusCode !== undefined && statusCode >= 400) {
    return "client_error";
  }
  return "other";
}

function buildStats(bucket: InterfaceBucket): InterfaceNetworkStats {
  const requestTotal = bucket.successCount + bucket.failCount;

  const errorCounts: Partial<Record<NetworkErrorKind, number>> = {};
  for (const [kind, count] of bucket.errorCounts) {
    errorCounts[kind] = count;
  }
  let primaryErrorKind: NetworkErrorKind | undefined;
  let primaryErrorCount = 0;
  for (const kind of NETWORK_ERROR_KIND_ORDER) {
    const count = errorCounts[kind] ?? 0;
    if (count > primaryErrorCount) {
      primaryErrorKind = kind;
      primaryErrorCount = count;
    }
  }

  return {
    transport: bucket.transport,
    interface: bucket.interface,
    requestTotal,
    successCount: bucket.successCount,
    failCount: bucket.failCount,
    retryCount: bucket.retryCount,
    primaryErrorKind,
    primaryErrorCount,
    duration: computeAggregateStats(bucket.durations),
    dns: computeAggregateStats(bucket.dns),
    tcp: computeAggregateStats(bucket.tcp),
    tls: computeAggregateStats(bucket.tls),
    ttfb: computeAggregateStats(bucket.ttfb),
    download: computeAggregateStats(bucket.download),
    errorCounts,
  };
}

export function flushInterfaceNetworkStats(maxPerTransport = 40): InterfaceNetworkStats[] {
  const grouped = new Map<NetworkTransportKind, InterfaceNetworkStats[]>();

  for (const bucket of buckets.values()) {
    if (bucket.durations.length === 0) {
      continue;
    }
    const stats = buildStats(bucket);
    const list = grouped.get(stats.transport) ?? [];
    list.push(stats);
    grouped.set(stats.transport, list);
  }

  buckets.clear();

  const result: InterfaceNetworkStats[] = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => b.requestTotal - a.requestTotal);
    result.push(...list.slice(0, maxPerTransport));
  }

  return result;
}

export function resetNetworkTelemetryAggregator(): void {
  buckets.clear();
}
