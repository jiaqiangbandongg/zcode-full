const MODEL_AUTH_HEADER_NAMES = new Set(["authorization", "x-api-key"]);
export const MODEL_QUERY_SOURCE_HEADER = "x-zcode-query-source";

/** 请求用途由调用上下文拥有，不能从 Provider 静态配置或 SDK 默认 header 继承。 */
export function withoutModelQuerySourceHeader(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== MODEL_QUERY_SOURCE_HEADER,
    ),
  );
}

/** 账号认证由请求期 owner 决定，静态默认值和 Personal 配置不能覆盖新凭据。 */
export function withoutModelAuthHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => !MODEL_AUTH_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
}

/** HTTP 头名不区分大小写；后来的值替换旧值，避免不同大小写被 SDK 拼成重复头。 */
export function mergeModelRequestHeaders(
  ...sources: (Readonly<Record<string, string>> | undefined)[]
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
      }
      headers[name] = value;
    }
  }
  return headers;
}
