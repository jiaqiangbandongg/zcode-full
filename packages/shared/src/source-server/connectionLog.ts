function redactUnquotedPath(value: string): string {
  // 裸路径可能含空格，不能把空格后的用户名/目录当成正文放行。只保留机器可识别的
  // 诊断尾部和已经脱敏的字段；其他无法消歧的尾部继续保守过滤，生产者应给路径加引号。
  const suffix =
    value.match(
      /(?:\s+(?:failed with exit code -?\d+|permission denied|no space left on device|read-only file system|[\w-]+=\[redacted\]))+\.?$/iu,
    )?.[0] ?? "";
  return `[redacted-path]${suffix}`;
}

/**
 * Bug 原因：已知秘密曾按子串替换，短密码（如 `dev`）会把固定文案 `device` 改成
 * `[redacted]ice`，看日志即可反推出密码。秘密必须按完整 token 匹配：秘密首/尾是
 * ASCII 单词字符时，相邻字符不能也是 ASCII 单词字符；中文等非 ASCII 字符仍视为边界。
 */
function secretTokenPattern(secret: string): RegExp {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = /^\w/.test(secret) ? "(?<!\\w)" : "";
  const after = /\w$/.test(secret) ? "(?!\\w)" : "";
  return new RegExp(`${before}${escaped}${after}`, "g");
}

/** 所有用户可见连接日志（含反馈附件）共用的过滤边界；原始诊断另行落盘。 */
export function sanitizeRemoteConnectionLog(
  message: string,
  secrets: readonly string[] = [],
): string {
  let result = message;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replace(secretTokenPattern(secret), "[redacted]");
  }
  return (
    result
      .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, "[redacted]")
      // Header 里的 Basic/Cookie 值可含空格和分号，按单个 token 截断会泄漏剩余凭据。
      // 只有带引号的键按结构字段处理；普通 Header 一律遮蔽到行尾，包含带引号值之后的内容。
      .replace(
        /(["'](?:authorization|(?:set-)?cookie)["'][ \t]*[:=][ \t]*)(?:\[redacted\](?=[,}\]\r\n]|$)|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n]*)/gi,
        "$1[redacted]",
      )
      .replace(/(\b(?:authorization|(?:set-)?cookie)[ \t]*[:=][ \t]*)[^\r\n]*/gi, "$1[redacted]")
      .replace(/\b(Bearer|Basic)[ \t]+[^\s,"'};]+/gi, "$1 [redacted]")
      .replace(
        /(["']?(?:[\w-]*token|[\w-]*api[_-]?key|[\w-]*secret|password|passphrase|privateKey|credentialRef|credentialId|profileId|sourceServerId|serverId|deviceId)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
        "$1[redacted]",
      )
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[redacted]")
      .replace(/(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, "[redacted-url]")
      // 引号提供精确边界，保留后续正文；无引号时不能靠空格猜测路径结束位置。
      .replace(/"(?:~?\/|[A-Za-z]:[\\/]|\\\\)(?:\\[^\r\n]|[^"\\\r\n])*"/g, "[redacted-path]")
      .replace(/'(?:~?\/|[A-Za-z]:[\\/]|\\\\)[^'\r\n]*'/g, "[redacted-path]")
      .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>]+/g, redactUnquotedPath)
      .replace(
        /(^|[\s("'=:[])(~?\/[^\r\n"'<>),;]+)/g,
        (_match, prefix: string, path: string) => `${prefix}${redactUnquotedPath(path)}`,
      )
      // oxlint-disable-next-line no-control-regex -- 清除终端 ANSI 控制序列，用户日志只保留可读文本。
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .trim()
  );
}

export function remoteConnectionFailureLogLevel(code: string): "info" | "error" {
  return code === "source-server-install-required" ||
    code === "remote-connection-canceled" ||
    code === "remote-bind-canceled"
    ? "info"
    : "error";
}
