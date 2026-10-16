import { requestSecuritySensitiveHeaders } from "@zcode/shared";
const HEADER_REDACTION_VALUE = "[redacted]";

const redactedHeaderNames = new Set([
  ...requestSecuritySensitiveHeaders,
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "openai-api-key",
  "x-off-peak-ticket-id",
]);

export function sanitizeModelNetworkHeaders(value: unknown): Record<string, string> {
  const headers = normalizeModelNetworkHeaders(value);
  const sanitized: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    sanitized[normalizedName] = shouldRedactHeader(normalizedName)
      ? HEADER_REDACTION_VALUE
      : headerValue;
  }
  return sanitized;
}

function shouldRedactHeader(normalizedName: string): boolean {
  return (
    redactedHeaderNames.has(normalizedName) ||
    normalizedName.includes("authorization") ||
    normalizedName.includes("api-key") ||
    normalizedName.includes("token") ||
    normalizedName.includes("secret") ||
    normalizedName.includes("cookie")
  );
}

function normalizeModelNetworkHeaders(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }

  const forEach = (value as { forEach?: unknown }).forEach;
  if (typeof forEach === "function") {
    const headers: Record<string, string> = {};
    forEach.call(value, (headerValue: unknown, name: unknown) => {
      if (typeof name === "string") {
        headers[name] = headerValueToString(headerValue);
      }
    });
    return headers;
  }

  if (Array.isArray(value)) {
    const headers: Record<string, string> = {};
    for (const item of value) {
      if (!Array.isArray(item) || item.length < 2 || typeof item[0] !== "string") {
        continue;
      }
      headers[item[0]] = headerValueToString(item[1]);
    }
    return headers;
  }

  if (typeof value !== "object") {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    headers[name] = headerValueToString(headerValue);
  }
  return headers;
}

function headerValueToString(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(headerValueToString).join(", ");
  }
  return value === undefined || value === null ? "" : String(value);
}
