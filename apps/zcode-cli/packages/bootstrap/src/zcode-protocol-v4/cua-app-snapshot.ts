import type { CuaAppIdentity } from "@zcode/shared/zcode-protocol-v4";

const OFFICIAL_CUA_PREFIXES = [
  "mcp__computer-use__",
  "mcp__plugin_zcode-cua_computer-use__",
] as const;

export function readOfficialCuaAction(toolName: string): string | null {
  const prefix = OFFICIAL_CUA_PREFIXES.find((candidate) => toolName.startsWith(candidate));
  return prefix ? toolName.slice(prefix.length) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asAppRef(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") return asRecord(parseJson(value));
  return asRecord(value);
}

export function readCuaInputPid(input: unknown): number | null {
  const root = asRecord(input);
  const candidates = [root?.app_ref, root?.app, asRecord(root?.target)?.app_ref];
  for (const candidate of candidates) {
    const pid = asAppRef(candidate)?.pid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

export function readCuaInputBundleId(input: unknown): string | null {
  const root = asRecord(input);
  const candidates = [root?.app_ref, root?.app, asRecord(root?.target)?.app_ref];
  for (const candidate of candidates) {
    const bundleId = asAppRef(candidate)?.bundle_id;
    if (typeof bundleId === "string" && bundleId.trim()) return bundleId.trim();
  }
  return null;
}

export function resolveCuaAppIdentity(
  input: unknown,
  snapshot: ReadonlyMap<number, CuaAppIdentity>,
): CuaAppIdentity | undefined {
  const pid = readCuaInputPid(input);
  if (pid !== null) return snapshot.get(pid);
  const bundleId = readCuaInputBundleId(input);
  if (!bundleId) return undefined;
  const matches = [...snapshot.values()].filter((app) => app.bundleId === bundleId);
  // 同一 bundle 可能存在多个进程；没有 PID 时不能猜测具体进程身份。
  return matches.length === 1 ? matches[0] : undefined;
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  const candidate = value.split("\n\nStructured content:", 1)[0]?.trim();
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function unwrapApps(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return null;
  if (Array.isArray(record.apps)) return record.apps;
  if (typeof record.result === "string") return unwrapApps(parseJson(record.result));
  return unwrapApps(record.result);
}

export function parseListAppsSnapshot(
  content: string,
  display: unknown,
): Map<number, CuaAppIdentity> | null {
  const displayRecord = asRecord(display);
  const structured =
    displayRecord?.kind === "cua" && typeof displayRecord.structuredContent === "string"
      ? parseJson(displayRecord.structuredContent)
      : undefined;
  const rows = unwrapApps(structured) ?? unwrapApps(parseJson(content));
  if (!rows) return null;
  const snapshot = new Map<number, CuaAppIdentity>();
  for (const value of rows) {
    const record = asRecord(value);
    if (!record) continue;
    const pid = record?.pid;
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !name) continue;
    const bundleId =
      typeof record.bundle_id === "string" && record.bundle_id.trim()
        ? record.bundle_id.trim()
        : undefined;
    snapshot.set(pid, { pid, name, ...(bundleId ? { bundleId } : {}) });
  }
  return snapshot;
}
