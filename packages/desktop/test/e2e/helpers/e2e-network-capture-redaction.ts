import { requestSecuritySensitiveHeaders } from "@zcode/shared";
export const E2E_NETWORK_CAPTURE_REDACTION_VALUE = "[redacted]";

const REDACTED_HEADER_NAMES = new Set([
  ...requestSecuritySensitiveHeaders,
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "openai-api-key",
  "anthropic-api-key",
]);

type HeaderValue = string | string[] | number | undefined;

export function sanitizeE2ENetworkCaptureHeaders(
  headers: Readonly<Record<string, HeaderValue>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    sanitized[normalizedName] = REDACTED_HEADER_NAMES.has(normalizedName)
      ? E2E_NETWORK_CAPTURE_REDACTION_VALUE
      : headerToString(value);
  }
  return sanitized;
}

export function redactE2ENetworkCaptureJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactE2ENetworkCaptureJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = shouldRedactJsonKey(key)
      ? E2E_NETWORK_CAPTURE_REDACTION_VALUE
      : redactE2ENetworkCaptureJson(child);
  }
  return result;
}

export function redactE2ENetworkCaptureJsonText(text: string): string {
  if (!text.trim()) {
    return text;
  }
  try {
    return JSON.stringify(redactE2ENetworkCaptureJson(JSON.parse(text)));
  } catch {
    return text;
  }
}

export function shouldRecordE2ENetworkResponseChunkTimeline(
  enabled: boolean,
  responseHeaders: Readonly<Record<string, string>>,
): boolean {
  return (
    enabled &&
    Object.entries(responseHeaders).some(
      ([name, value]) =>
        name.toLowerCase() === "content-type" && value.toLowerCase().includes("text/event-stream"),
    )
  );
}

function headerToString(value: HeaderValue): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value === undefined ? "" : String(value);
}

function shouldRedactJsonKey(key: string): boolean {
  const normalizedKey = key.replaceAll(/[-_]/gu, "").toLowerCase();
  return (
    /api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|secret/i.test(key) ||
    normalizedKey === "sig" ||
    normalizedKey === "signature" ||
    // 密文字段（如私钥密文）一律按密钥材料脱敏。
    normalizedKey.endsWith("cipher") ||
    normalizedKey === "privatekey" ||
    normalizedKey === "pkcs8"
  );
}
