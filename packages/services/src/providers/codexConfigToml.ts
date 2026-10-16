import { stringify as stringifyToml } from "smol-toml";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOML_BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(key: string): string {
  return TOML_BARE_KEY_PATTERN.test(key) ? key : JSON.stringify(key);
}

function isTomlTableHeaderLine(line: string | undefined): boolean {
  return typeof line === "string" && line.startsWith("[") && line.endsWith("]");
}

function getTomlTableEndIndex(lines: string[], tableStartIndex: number): number {
  let tableEnd = tableStartIndex + 1;
  while (tableEnd < lines.length) {
    if (isTomlTableHeaderLine(lines[tableEnd])) {
      break;
    }
    tableEnd += 1;
  }
  return tableEnd;
}

function formatTomlInlineValue(value: unknown): string {
  if (value === null || value === undefined) {
    throw new TypeError("inline table 不支持 null/undefined");
  }

  if (typeof value === "string") {
    return JSON.stringify(value).replace(/\x7f/g, "\\u007f");
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return "nan";
    }
    if (value === Infinity) {
      return "inf";
    }
    if (value === -Infinity) {
      return "-inf";
    }
    return String(value);
  }

  if (typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError("inline table 不支持无效 Date");
    }
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    return `[ ${value.map((item) => formatTomlInlineValue(item)).join(", ")} ]`;
  }

  if (!isObjectRecord(value)) {
    throw new TypeError(`inline table 不支持值类型: ${typeof value}`);
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}";
  }

  const formattedEntries = entries.map(
    ([entryKey, entryValue]) => `${formatTomlKey(entryKey)} = ${formatTomlInlineValue(entryValue)}`,
  );
  return `{ ${formattedEntries.join(", ")} }`;
}

function rewriteHttpHeadersAsInlineTable(options: {
  toml: string;
  providerId: string;
  headers: Record<string, unknown>;
}): string {
  const { toml, providerId, headers } = options;
  const providerSegment = formatTomlKey(providerId);
  const providerTableHeader = `[model_providers.${providerSegment}]`;
  const headersTableHeader = `[model_providers.${providerSegment}.http_headers]`;
  const inlineHeaderLine = `http_headers = ${formatTomlInlineValue(headers)}`;

  const lines = toml.split("\n");
  let providerHeaderIndex = lines.findIndex((line) => line === providerTableHeader);
  const headersTableIndex = lines.findIndex((line) => line === headersTableHeader);

  if (headersTableIndex < 0) {
    return toml;
  }

  const headersTableEnd = getTomlTableEndIndex(lines, headersTableIndex);

  let removeStart = headersTableIndex;
  if (removeStart > 0 && lines[removeStart - 1] === "") {
    removeStart -= 1;
  }

  let nextLines = [...lines.slice(0, removeStart), ...lines.slice(headersTableEnd)];
  providerHeaderIndex = nextLines.findIndex((line) => line === providerTableHeader);

  if (providerHeaderIndex < 0) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines = [...nextLines, ""];
    }
    return [...nextLines, providerTableHeader, inlineHeaderLine].join("\n");
  }

  let providerTableEnd = getTomlTableEndIndex(nextLines, providerHeaderIndex);
  const providerBodyStart = providerHeaderIndex + 1;

  for (let lineIndex = providerBodyStart; lineIndex < providerTableEnd; lineIndex += 1) {
    if (/^http_headers\s*=/.test(nextLines[lineIndex] ?? "")) {
      const replaced = [...nextLines];
      replaced[lineIndex] = inlineHeaderLine;
      return replaced.join("\n");
    }
  }

  let insertIndex = providerTableEnd;
  while (insertIndex > providerBodyStart && nextLines[insertIndex - 1] === "") {
    insertIndex -= 1;
  }

  nextLines = [
    ...nextLines.slice(0, insertIndex),
    inlineHeaderLine,
    ...nextLines.slice(insertIndex),
  ];

  providerTableEnd = getTomlTableEndIndex(nextLines, providerHeaderIndex);
  if (providerTableEnd < nextLines.length && nextLines[providerTableEnd - 1] !== "") {
    nextLines = [
      ...nextLines.slice(0, providerTableEnd),
      "",
      ...nextLines.slice(providerTableEnd),
    ];
  }

  return nextLines.join("\n");
}

function stripNestedQueryParamHttpHeaders(providerConfig: Record<string, unknown>): {
  providerConfig: Record<string, unknown>;
  changed: boolean;
} {
  const queryParams = providerConfig.query_params;
  if (!isObjectRecord(queryParams) || !("http_headers" in queryParams)) {
    return {
      providerConfig,
      changed: false,
    };
  }

  // Bugfix: 历史错误实现会把 provider 的 http_headers 写进 query_params.http_headers。
  // Codex 只认 provider 主表的 http_headers；这里在序列化前剔除错误层级，避免持续污染 config.toml。
  const nextProviderConfig = { ...providerConfig };
  const nextQueryParams = { ...queryParams };
  delete nextQueryParams.http_headers;

  if (Object.keys(nextQueryParams).length === 0) {
    delete nextProviderConfig.query_params;
  } else {
    nextProviderConfig.query_params = nextQueryParams;
  }

  return {
    providerConfig: nextProviderConfig,
    changed: true,
  };
}

export function stringifyCodexConfigToml(config: Record<string, unknown>): string {
  const modelProviders = isObjectRecord(config.model_providers)
    ? config.model_providers
    : null;

  if (!modelProviders) {
    return stringifyToml(config);
  }

  let hasConfigChanged = false;
  const normalizedModelProviders: Record<string, unknown> = {
    ...modelProviders,
  };

  for (const [providerId, providerConfig] of Object.entries(modelProviders)) {
    if (!isObjectRecord(providerConfig)) {
      continue;
    }

    const normalizedProviderResult = stripNestedQueryParamHttpHeaders(providerConfig);
    if (!normalizedProviderResult.changed) {
      continue;
    }

    hasConfigChanged = true;
    normalizedModelProviders[providerId] = normalizedProviderResult.providerConfig;
  }

  const configToSerialize = hasConfigChanged
    ? {
        ...config,
        model_providers: normalizedModelProviders,
      }
    : config;
  const baseToml = stringifyToml(configToSerialize);

  let resultToml = baseToml;
  for (const [providerId, providerConfig] of Object.entries(normalizedModelProviders)) {
    if (!isObjectRecord(providerConfig)) {
      continue;
    }

    const headers = providerConfig.http_headers;
    if (!isObjectRecord(headers)) {
      continue;
    }

    resultToml = rewriteHttpHeadersAsInlineTable({
      toml: resultToml,
      providerId,
      headers,
    });
  }

  return resultToml;
}
