import type { PluginDiagnosticCode } from "@zcode/contracts";

export class PluginSourceMaterializationError extends Error {
  readonly diagnosticCode: PluginDiagnosticCode;

  constructor(diagnosticCode: PluginDiagnosticCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginSourceMaterializationError";
    this.diagnosticCode = diagnosticCode;
  }
}

export function createGitUnavailableError(source: string, reason?: string): Error {
  const safeSource = redactPluginSource(source);
  const reasonSuffix = reason ? ` (${redactPluginDiagnosticText(reason)})` : "";
  return new PluginSourceMaterializationError(
    "plugin_git_unavailable",
    `System Git is required for plugin source ${safeSource}${reasonSuffix}, but git is unavailable on this Agent Host. Install Git on the Agent Host, or use a public GitHub HTTPS or verified ZIP source.`,
  );
}

export function createArchiveFetchError(source: string, cause: unknown): Error {
  const safeSource = redactPluginSource(source);
  const detail = redactPluginDiagnosticText(cause instanceof Error ? cause.message : String(cause));
  const safeCause = cause instanceof Error ? new Error(detail) : undefined;
  return new PluginSourceMaterializationError(
    "plugin_archive_fetch_failed",
    `Failed to materialize public GitHub plugin source archive ${safeSource}: ${detail}`,
    safeCause ? { cause: safeCause } : undefined,
  );
}

/**
 * source materialization 错误现在会被持久化并投影到桌面/Web UI，不能把 URL
 * userinfo 带入状态文件、日志或截图。凭据只在诊断生成边界清理，所有消费者共享同一规则。
 */
export function redactPluginSource(source: string): string {
  const trimmed = source.trim();
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    if (/^[^\s:@]+:[^\s@]+@/u.test(trimmed)) return "configured Git source";
    return trimmed;
  }
}

function redactPluginDiagnosticText(text: string): string {
  return text
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>()[\]{}]+/giu, (source) =>
      redactPluginSource(source),
    )
    .replace(/\b[^\s:@]+:[^\s@]+@[^\s]+/gu, "configured Git source");
}

export function getPluginSourceDiagnosticCode(error: unknown): PluginDiagnosticCode | undefined {
  return error instanceof PluginSourceMaterializationError ? error.diagnosticCode : undefined;
}

export function isCommandUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
