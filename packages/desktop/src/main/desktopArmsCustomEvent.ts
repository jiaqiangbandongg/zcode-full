import type {
  ArmsCustomEventPayload,
  ArmsRumEnv,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
  FinalArmsCustomEventPayload,
} from "@zcode/shared";

export const MAX_FINAL_ARMS_CUSTOM_EVENT_E2E_ENTRIES = 200;
const MAX_SUPPRESSED_EVENT_NAMES = 100;
const MAX_EVENT_NAME_LENGTH = 256;

export interface FinalArmsCustomEventE2EController {
  record(payload: FinalArmsCustomEventPayload): void;
  read(): FinalArmsCustomEventE2EEntry[];
  clear(): void;
  configure(request: ConfigureFinalArmsCustomEventE2ERequest): void;
  shouldSuppress(eventName: string): boolean;
}

function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function cloneFinalPayload(payload: FinalArmsCustomEventPayload): FinalArmsCustomEventPayload {
  return {
    ...payload,
    properties: { ...payload.properties },
  };
}

function normalizeSuppressedEventNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SUPPRESSED_EVENT_NAMES) {
    throw new Error("suppressedEventNames 必须是最多 100 项的字符串数组");
  }
  const names = value.map((item) => {
    if (typeof item !== "string") {
      throw new Error("suppressedEventNames 只能包含字符串");
    }
    const normalized = item.trim();
    if (!normalized || normalized.length > MAX_EVENT_NAME_LENGTH) {
      throw new Error("suppressedEventNames 包含空值或超长 event name");
    }
    return normalized;
  });
  return [...new Set(names)];
}

/** Main-process 内存 ring；不写磁盘，也不进入 renderer store。 */
export function createFinalArmsCustomEventE2EController(
  options: {
    capacity?: number;
    now?: () => number;
  } = {},
): FinalArmsCustomEventE2EController {
  const requestedCapacity = options.capacity ?? MAX_FINAL_ARMS_CUSTOM_EVENT_E2E_ENTRIES;
  const capacity = Math.max(
    1,
    Math.min(
      Number.isFinite(requestedCapacity)
        ? Math.trunc(requestedCapacity)
        : MAX_FINAL_ARMS_CUSTOM_EVENT_E2E_ENTRIES,
      MAX_FINAL_ARMS_CUSTOM_EVENT_E2E_ENTRIES,
    ),
  );
  const now = options.now ?? Date.now;
  const entries: FinalArmsCustomEventE2EEntry[] = [];
  let nextSequence = 1;
  let suppressedEventNames = new Set<string>();

  return {
    record(payload) {
      entries.push({
        sequence: nextSequence,
        recordedAt: now(),
        payload: cloneFinalPayload(payload),
      });
      nextSequence += 1;
      if (entries.length > capacity) {
        entries.splice(0, entries.length - capacity);
      }
    },
    read() {
      return entries.map((entry) => ({
        ...entry,
        payload: cloneFinalPayload(entry.payload),
      }));
    },
    clear() {
      entries.splice(0, entries.length);
    },
    configure(request) {
      suppressedEventNames = new Set(normalizeSuppressedEventNames(request?.suppressedEventNames));
    },
    shouldSuppress(eventName) {
      return suppressedEventNames.has(eventName);
    },
  };
}

/**
 * main 侧共享的 E2E 捕获环。
 *
 * renderer 经 IPC 来的自定义事件与 main 自己发出的资源 / 稳定性事件必须进同一个环，
 * 否则 E2E 只能看到 renderer 那一半。由 `desktopMainIpcRemote` 在双门禁下开启。
 */
let sharedFinalArmsCustomEventE2E: FinalArmsCustomEventE2EController | null = null;

export function enableSharedFinalArmsCustomEventE2EController(
  options?: Parameters<typeof createFinalArmsCustomEventE2EController>[0],
): FinalArmsCustomEventE2EController {
  sharedFinalArmsCustomEventE2E = createFinalArmsCustomEventE2EController(options);
  return sharedFinalArmsCustomEventE2E;
}

export function getSharedFinalArmsCustomEventE2EController(): FinalArmsCustomEventE2EController | null {
  return sharedFinalArmsCustomEventE2E;
}

export function buildFinalArmsCustomEventPayload(params: {
  payload: ArmsCustomEventPayload;
  context: {
    deviceMid: string;
    platform: NodeJS.Platform;
    appVersion: string;
    armsEnv: ArmsRumEnv;
    rendererId: number;
  };
}): FinalArmsCustomEventPayload {
  const metricValue = params.payload.value ?? 1;
  const rawProperties: Record<string, string | number | boolean | undefined> = {
    event_name: params.payload.name,
    app_version: params.context.appVersion,
    arms_env: params.context.armsEnv,
    device_mid: params.context.deviceMid,
    platform: normalizeOsCategory(params.context.platform),
    renderer_id: params.context.rendererId,
    metric_value: metricValue,
    ...params.payload.properties,
  };
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawProperties)) {
    if (value !== undefined) {
      properties[key] = String(value);
    }
  }

  return {
    name: params.payload.name,
    type: "custom",
    group: params.payload.group,
    value: metricValue,
    properties,
  };
}

/** 捕获发生在 sendCustom 调用前，网络抑制只跳过目标 event name。 */
export function dispatchFinalArmsCustomEvent(params: {
  payload: ArmsCustomEventPayload;
  context: Parameters<typeof buildFinalArmsCustomEventPayload>[0]["context"];
  e2eController?: FinalArmsCustomEventE2EController | null;
  sendCustom: (payload: FinalArmsCustomEventPayload) => void;
}): { payload: FinalArmsCustomEventPayload; suppressed: boolean } {
  const payload = buildFinalArmsCustomEventPayload(params);
  params.e2eController?.record(payload);
  const suppressed = params.e2eController?.shouldSuppress(payload.name) ?? false;
  if (!suppressed) {
    params.sendCustom(payload);
  }
  return { payload, suppressed };
}
