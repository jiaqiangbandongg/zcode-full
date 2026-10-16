import { DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";

const PRODUCTION_WEB_REMOTE_ORIGIN = DEFAULT_ZCODE_ENDPOINT_ORIGIN;
const WEB_REMOTE_PATHS = new Set(["/web-remote", "/web-remote/"]);
const WEB_CALLBACK_PATHS = new Set(["/web-remote/callback", "/cn/share/callback", "/share/callback"]);
const SHARE_PATH_PATTERN = /^\/(?:cn\/share|share)\/[A-Za-z0-9._~-]{1,512}$/u;
const APP_RETURN_QUERY_ALLOWLIST = new Set(["remoteControlToken", "relayOrigin"]);
const PRIVATE_DEV_RETURN_TO_PATTERN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/;

interface OAuthStatePayload {
  nonce: string;
  app_return_to?: string;
  return_to?: string;
}

interface ResolveSafeAppReturnToOptions {
  currentOrigin?: string;
}

function getCurrentOrigin(): string {
  const location = globalThis.window?.location ?? globalThis.location;
  return location?.origin ?? PRODUCTION_WEB_REMOTE_ORIGIN;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

export function buildOAuthState(payload: OAuthStatePayload): string {
  return encodeBase64Url(JSON.stringify(payload));
}

export function parseOAuthState(state: string): OAuthStatePayload | null {
  try {
    const parsed = JSON.parse(decodeBase64Url(state)) as Partial<OAuthStatePayload>;
    if (!isNonEmptyString(parsed.nonce)) {
      return null;
    }

    return {
      nonce: parsed.nonce,
      ...(isNonEmptyString(parsed.app_return_to) ? { app_return_to: parsed.app_return_to } : {}),
      ...(isNonEmptyString(parsed.return_to) ? { return_to: parsed.return_to } : {}),
    };
  } catch {
    return null;
  }
}

export function parseOptionalUrl(value?: string): URL | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isTrustedDevReturnTo(url: URL): boolean {
  return PRIVATE_DEV_RETURN_TO_PATTERN.test(url.toString()) && WEB_CALLBACK_PATHS.has(url.pathname);
}

function resolveAllowedAppReturnOrigin(currentOrigin: string): string {
  return currentOrigin === PRODUCTION_WEB_REMOTE_ORIGIN
    ? PRODUCTION_WEB_REMOTE_ORIGIN
    : currentOrigin;
}

export function resolveSafeAppReturnTo(
  value?: string,
  options: ResolveSafeAppReturnToOptions = {},
): string | null {
  const url = parseOptionalUrl(value);
  if (!url || (!WEB_REMOTE_PATHS.has(url.pathname) && !SHARE_PATH_PATTERN.test(url.pathname))) {
    return null;
  }

  const currentOrigin = options.currentOrigin ?? getCurrentOrigin();
  const allowedOrigin = resolveAllowedAppReturnOrigin(currentOrigin);
  if (url.origin !== allowedOrigin) {
    return null;
  }

  if (SHARE_PATH_PATTERN.test(url.pathname)) return url.pathname;

  const safeSearch = new URLSearchParams();
  for (const key of APP_RETURN_QUERY_ALLOWLIST) {
    const existing = url.searchParams.get(key);
    if (existing !== null) {
      safeSearch.set(key, existing);
    }
  }

  const query = safeSearch.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

export function buildReturnToCallbackUrl(
  returnTo: string,
  params: { code?: string; error?: string; state: string },
): string | null {
  const returnToUrl = parseOptionalUrl(returnTo);
  if (!returnToUrl || !isTrustedDevReturnTo(returnToUrl) || !isNonEmptyString(params.state)) {
    return null;
  }

  returnToUrl.search = "";
  if (isNonEmptyString(params.code)) {
    returnToUrl.searchParams.set("code", params.code);
  }
  if (isNonEmptyString(params.error)) {
    returnToUrl.searchParams.set("error", params.error);
  }
  returnToUrl.searchParams.set("state", params.state);

  return returnToUrl.toString();
}
