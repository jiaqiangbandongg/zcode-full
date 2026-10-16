import type { ZCodeConfigOption, ZCodeProvider, ZCodeTaskMode } from "@zcode/shared";

const ZCODE_TASK_MODE_VALUES: readonly ZCodeTaskMode[] = [
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
];

const ZCODE_TASK_MODE_SET = new Set<string>(ZCODE_TASK_MODE_VALUES);

function normalizeZCodeModeForTaskCreation(
  modeId: string,
  _provider?: ZCodeProvider,
): ZCodeTaskMode | undefined {
  if (ZCODE_TASK_MODE_SET.has(modeId)) {
    return modeId as ZCodeTaskMode;
  }

  switch (modeId) {
    case "full-access":
    case "full_access":
      return "bypassPermissions";
    case "read-only":
    case "read_only":
      return "plan";
    case "auto-edit":
    case "auto_edit":
    case "accept-edits":
    case "accept_edits":
      return "acceptEdits";
    case "full-auto":
    case "full_auto":
      return "yolo";
    default:
      return undefined;
  }
}

function stringifyUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Bugfix: 某些错误对象可能带循环引用，JSON 序列化失败时退回到 String，至少不要再抛新的异常。
  }

  return String(value);
}

// Bugfix: ZCode Agent 调用失败时不一定抛 Error，某些实现会直接抛普通对象。
// 直接 String(err) 只会得到 [object Object]，用户提示和日志都会丢掉真实错误信息。
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || String(err);
  }

  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    const normalizedMessage = stringifyUnknownValue(message);
    if (normalizedMessage !== "undefined" && normalizedMessage.length > 0) {
      return normalizedMessage;
    }
  }

  return stringifyUnknownValue(err);
}

export function readCurrentZCodeMode(
  options: readonly ZCodeConfigOption[],
  provider?: ZCodeProvider,
): ZCodeTaskMode | undefined {
  const modeOption = options.find(
    (option) => option.category === "mode" && option.type === "select",
  );
  const currentValue = modeOption?.currentValue;
  if (typeof currentValue !== "string") {
    return undefined;
  }

  // Bugfix: 之前只白名单了本地 ZCodeTaskMode，导致 provider 原生模式
  // 在首发建 session 时被丢弃。这里先归一化，避免 UI 已选模式和真实 ZCode Agent session 模式不一致。
  return normalizeZCodeModeForTaskCreation(currentValue, provider);
}
