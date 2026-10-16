function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return undefined;
}

function getErrorCandidate(error: unknown): unknown {
  if (!isRecord(error) || !("error" in error) || !isRecord(error.error)) {
    return error;
  }

  if ("message" in error.error || "code" in error.error) {
    return error.error;
  }

  return error;
}

export interface NormalizedUnknownError {
  message: string;
  code?: string;
}

export const ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE = "ZCODE_FILE_LOCK_TIMEOUT" as const;

export function stringifyUnknownValue(value: unknown): string {
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
    // 某些协议错误对象会带循环引用。
    // 这里吞掉 JSON 序列化异常，避免在展示原始错误时再制造第二个错误。
  }

  return String(value);
}

export function normalizeUnknownError(error: unknown): NormalizedUnknownError {
  const candidate = getErrorCandidate(error);
  if (candidate instanceof Error) {
    const errorWithCode = candidate as Error & { code?: unknown };
    return {
      // 有些运行时 Error.message 可能为空字符串。
      // 这里按 message -> name -> String 的顺序兜底，确保前端始终能拿到可展示的文本。
      message: candidate.message || candidate.name || String(candidate),
      code: normalizeErrorCode(errorWithCode.code),
    };
  }

  if (isRecord(candidate)) {
    const code = "code" in candidate ? normalizeErrorCode(candidate.code) : undefined;
    const message =
      "message" in candidate
        ? stringifyUnknownValue(candidate.message)
        : stringifyUnknownValue(candidate);

    return {
      message:
        message !== "undefined" && message.length > 0 ? message : stringifyUnknownValue(candidate),
      code,
    };
  }

  return {
    message: stringifyUnknownValue(candidate),
  };
}

export function isZCodeFileLockTimeoutError(error: unknown): boolean {
  return normalizeUnknownError(error).code === ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE;
}

/**
 * 不可自动重试的 workspace ZCode Agent 预热错误模式列表。
 *
 * 这些错误代表确定性的配置/安装/鉴权问题，继续重试不会变好。
 * 同时用于 MCP-fallback 降级判断：命中这些模式时不做 MCP 降级，因为错误与 MCP 无关。
 */
export const NON_RETRYABLE_WORKSPACE_PREPARE_ERROR_PATTERNS = [
  "binary 未找到",
  "未正确安装",
  "binary not found",
  "not installed",
  "initialize 前进程已退出",
  "initialize 超时",
  "进程启动失败",
  "optional dependency was not installed",
  "Cannot find package '@openai/codex-",
  "Missing optional dependency @openai/codex-",
  "Missing Codex runtime files",
  "Gemini API key is missing or not configured",
  "Please fix the configuration file(s)",
  "Expected property name or '}' in JSON",
  "已暂停自动重试",
] as const;

/**
 * 额外的不可 MCP-fallback 降级的错误模式。
 *
 * session/new 超时属于 agent 自身启动/登录卡住，和 MCP 无关，降级也没用。
 */
export const NON_MCP_FALLBACK_EXTRA_ERROR_PATTERNS = ["session/new 超时"] as const;

const OPENCODE_RUNTIME_CRASH_ERROR_PATTERNS = [
  "opencode runtime 崩溃",
  "opencode runtime crashed",
  "bun has crashed",
  "segmentation fault",
  "panic(main thread)",
  "code=3221226505",
] as const;

/**
 * 判断错误消息是否代表确定性失败，不应自动重试 workspace ZCode Agent 预热。
 */
export function isNonRetryableWorkspacePrepareError(errorMessage: string): boolean {
  const normalizedMessage = errorMessage.toLowerCase();
  return NON_RETRYABLE_WORKSPACE_PREPARE_ERROR_PATTERNS.some((pattern) =>
    normalizedMessage.includes(pattern.toLowerCase()),
  );
}

/**
 * 判断 OpenCode 是否命中 Bun/运行时崩溃。
 *
 * 这类错误不同于配置缺失：短时间内重建进程可能恢复，但连续出现时应停止自动重试，
 * 避免 UI 只显示泛化的 “connection closed” 并把用户拖进 5/5 的无意义等待。
 */
export function isOpenCodeRuntimeCrashError(errorMessage: string): boolean {
  const normalizedMessage = errorMessage.toLowerCase();
  return OPENCODE_RUNTIME_CRASH_ERROR_PATTERNS.some((pattern) =>
    normalizedMessage.includes(pattern.toLowerCase()),
  );
}
