import { readFile } from "node:fs/promises";
import { TID_CHAT_CONTEXT_USAGE_TRIGGER } from "@zcode/shared";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "./network-capture-proxy.js";
import { sel } from "./selectors.js";

export interface UpstreamUsageSnapshot {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

interface UpstreamRequestAssertion {
  expectedText: string;
  model: string;
}

const CONTEXT_USAGE_CAPTURE_TOLERANCE_TOKENS = 256;

export async function waitForUpstreamNetworkCapture(expectedText: string) {
  let latestArtifact: E2ENetworkCaptureArtifact | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latestArtifact = await readCaptureArtifact();
        const record = findUpstreamRequestRecord(latestArtifact, expectedText);
        return Boolean(
          record?.requestJson &&
            record.status === "complete" &&
            record.statusCode !== undefined,
        );
      },
      {
        timeout: 60000,
        timeoutMsg: "没有捕获到 上游 请求",
      },
    );
  } catch (error) {
    throw new Error(
      `没有捕获到 上游 请求\n${JSON.stringify(
        summarizeCaptureArtifact(latestArtifact),
        null,
        2,
      )}`,
      { cause: error },
    );
  }

  const record = findUpstreamRequestRecord(latestArtifact, expectedText);
  if (!record) {
    throw new Error("上游 请求捕获记录在等待完成后仍不存在");
  }
  return record;
}

export async function waitForUpstreamNetworkRequestStarted(expectedText: string) {
  let latestArtifact: E2ENetworkCaptureArtifact | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latestArtifact = await readCaptureArtifact();
        const record = findUpstreamRequestRecord(latestArtifact, expectedText);
        return Boolean(record?.requestJson);
      },
      {
        timeout: 60000,
        timeoutMsg: "没有捕获到 上游 请求开始",
      },
    );
  } catch (error) {
    throw new Error(
      `没有捕获到 上游 请求开始\n${JSON.stringify(
        summarizeCaptureArtifact(latestArtifact),
        null,
        2,
      )}`,
      { cause: error },
    );
  }

  const record = findUpstreamRequestRecord(latestArtifact, expectedText);
  if (!record) {
    throw new Error("上游 请求开始记录在等待后仍不存在");
  }
  return record;
}

export function assertUpstreamRequestCapture(
  record: E2ENetworkCaptureRecord,
  assertion: UpstreamRequestAssertion,
) {
  const expectedHost = process.env.E2E_PROVIDER_EXPECTED_HOST?.trim();
  const expectedProtocol = process.env.E2E_PROVIDER_EXPECTED_PROTOCOL?.trim();
  if (expectedHost) {
    expect(record.host).toBe(expectedHost);
  }
  if (expectedProtocol) {
    expect(record.protocol).toBe(expectedProtocol);
  }
  expect(record.method).toBe("POST");
  expect(
    record.path.includes("/messages") || record.path.includes("/chat/completions"),
  ).toBe(true);
  if (!record.statusCode || record.statusCode < 200 || record.statusCode >= 300) {
    throw new Error(
      `上游 请求没有返回 2xx\n${JSON.stringify(summarizeCaptureRecord(record), null, 2)}`,
    );
  }
  expect(readModelFromCapture(record.requestJson)).toBe(assertion.model);
  expect(captureContainsText(record.requestJson, assertion.expectedText)).toBe(true);
}

export function assertUpstreamThoughtLevelCapture(
  record: E2ENetworkCaptureRecord,
  thoughtLevel: string,
) {
  const isThinkingToggleLevel = thoughtLevel === "enabled" || thoughtLevel === "disabled";
  if (record.path.includes("/anthropic/") || record.path.includes("/messages")) {
    expect(readNestedString(record.requestJson, ["thinking", "type"])).toBe(
      isThinkingToggleLevel ? thoughtLevel : "enabled",
    );
    if (!isThinkingToggleLevel) {
      expect(readNestedString(record.requestJson, ["output_config", "effort"])).toBe(
        thoughtLevel,
      );
    }
    return;
  }

  if (!isThinkingToggleLevel) {
    expect(readNestedString(record.requestJson, ["reasoning_effort"])).toBe(thoughtLevel);
  }
  expect(readNestedString(record.requestJson, ["thinking", "type"])).toBe(
    isThinkingToggleLevel ? thoughtLevel : "enabled",
  );
  expect(readNested(record.requestJson, ["extra_body"])).toBeUndefined();
  expect(readNestedBoolean(record.requestJson, ["stream_options", "include_usage"])).toBe(
    true,
  );
}

export function readUpstreamUsageFromCapture(
  record: E2ENetworkCaptureRecord,
): UpstreamUsageSnapshot {
  const usage = parseLatestSseUsage(record.responseTextPreview ?? "");
  if (!usage) {
    throw new Error(
      `上游 响应里没有解析到 usage\n${JSON.stringify(summarizeCaptureRecord(record), null, 2)}`,
    );
  }

  const providerInputTokens = numberValue(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.input,
  );
  const cacheReadTokens = numberValue(
    usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cache_read_tokens,
  );
  const cacheWriteTokens = numberValue(
    usage.cache_creation_input_tokens ?? usage.cacheWriteTokens ?? usage.cache_write_tokens,
  );
  // 修复原因：上游 Anthropic-compatible 响应会把 prompt token 和 cache token 拆开返回；
  // runtime context meter 展示的是本次请求实际占用的上下文总量，抓包断言必须同口径相加。
  const inputTokens =
    (providerInputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  if (!inputTokens || inputTokens <= 0) {
    throw new Error(
      `Upstream usage 缺少有效 input tokens\n${JSON.stringify({ usage }, null, 2)}`,
    );
  }

  const completionDetails = asRecord(usage.completion_tokens_details);
  return {
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
    outputTokens: numberValue(
      usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.output,
    ),
    totalTokens: numberValue(usage.total_tokens ?? usage.totalTokens ?? usage.total),
    reasoningTokens: numberValue(
      completionDetails.reasoning_tokens ?? usage.reasoning_tokens ?? usage.reasoningTokens,
    ),
  };
}

export async function waitForContextUsageFromCapture(usage: UpstreamUsageSnapshot) {
  const trigger = $(sel(TID_CHAT_CONTEXT_USAGE_TRIGGER));
  await trigger.waitForDisplayed({
    timeout: 45000,
    timeoutMsg: "上游 请求返回 usage 后，工具栏没有显示 context 消耗",
  });

  const expectedContextTokens = readExpectedContextUsageTokens(usage);
  let latestLabel = "";
  let latestUsedTokens = 0;
  await browser.waitUntil(
    async () => {
      latestLabel = await readContextUsageLabel();
      const numbers = numbersFromLabel(latestLabel);
      latestUsedTokens = numbers[0] ?? 0;
      // Bugfix: Provider SSE usage 是上游请求口径，UI context meter 会叠加本地会话
      // 估算和少量系统开销；回放验证只需要确认 usage 已进入 UI 且没有大幅偏离。
      return (
        latestUsedTokens >= expectedContextTokens &&
        latestUsedTokens - expectedContextTokens <= CONTEXT_USAGE_CAPTURE_TOLERANCE_TOKENS
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `context 消耗没有匹配 上游 usage=${expectedContextTokens}±${CONTEXT_USAGE_CAPTURE_TOLERANCE_TOKENS}，latest=${latestLabel} used=${latestUsedTokens}`,
    },
  );
}

function readExpectedContextUsageTokens(usage: UpstreamUsageSnapshot) {
  // 修复原因：运行结束后的 context meter 展示的是当前对话上下文已用量，
  // 包含本轮 assistant 输出；上游 usage 把 input/cache/output 拆开返回，
  // 旧断言只比 inputTokens 会把正确 UI 误报成失败。
  return usage.totalTokens ?? usage.inputTokens + (usage.outputTokens ?? 0);
}

function findUpstreamRequestRecord(
  artifact: E2ENetworkCaptureArtifact | null,
  expectedText?: string,
): E2ENetworkCaptureRecord | null {
  const records =
    artifact?.records.filter((record) => {
      const expectedHost = process.env.E2E_PROVIDER_EXPECTED_HOST?.trim();
      return (
        (!expectedHost || record.host === expectedHost) &&
        record.method === "POST" &&
        (record.path.includes("/messages") || record.path.includes("/chat/completions")) &&
        !isTitleGenerationRequest(record)
      );
    }) ?? [];

  if (expectedText) {
    return (
      records.findLast((record) => captureContainsText(record.requestJson, expectedText)) ??
      null
    );
  }

  return records.at(-1) ?? null;
}

function isTitleGenerationRequest(record: E2ENetworkCaptureRecord): boolean {
  return captureContainsText(record.requestJson, "Generate a concise title");
}

async function readCaptureArtifact(): Promise<E2ENetworkCaptureArtifact | null> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    throw new Error("Upstream e2e capture path is not configured");
  }

  try {
    return JSON.parse(await readFile(capturePath, "utf-8")) as E2ENetworkCaptureArtifact;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function parseLatestSseUsage(text: string): Record<string, unknown> | null {
  let latestUsage: Record<string, unknown> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(payload) as unknown;
      const directUsage = asRecord(asRecord(parsed).usage);
      const messageUsage = asRecord(asRecord(asRecord(parsed).message).usage);
      const usage = mergeSseUsage(directUsage, messageUsage);
      if (Object.keys(usage).length > 0) {
        latestUsage = mergeSseUsage(latestUsage ?? {}, usage);
      }
    } catch {
      // 真实 SSE 里可能穿插非 JSON keep-alive 行，忽略后继续找最终 usage。
    }
  }
  return latestUsage;
}

function mergeSseUsage(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value !== undefined && value !== null) {
      merged[key] = value;
    }
  }
  return merged;
}

function readContextUsageLabel() {
  return browser.execute((triggerTestId) => {
    const trigger = document.querySelector<HTMLElement>(
      `[data-testid="${triggerTestId}"]`,
    );
    return (
      trigger?.getAttribute("aria-label") ??
      trigger?.getAttribute("title") ??
      trigger?.innerText ??
      ""
    );
  }, TID_CHAT_CONTEXT_USAGE_TRIGGER);
}

function numbersFromLabel(label: string): number[] {
  return Array.from(label.matchAll(/\d[\d,\s.]*/g))
    .map((match) => Number(match[0]?.replace(/[^\d]/g, "") ?? ""))
    .filter((value) => Number.isFinite(value));
}

function readModelFromCapture(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const model = (value as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

function captureContainsText(value: unknown, expected: string): boolean {
  // 修复原因：JSON.stringify 会把 prompt 里的双引号转义成 `\"`，直接做字符串
  // contains 会误判。抓包断言改为递归读取真实字符串字段，验证请求内容本身。
  if (typeof value === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => captureContainsText(item, expected));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((child) => captureContainsText(child, expected));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNestedString(value: unknown, path: readonly string[]): string | null {
  const found = readNested(value, path);
  return typeof found === "string" ? found : null;
}

function readNestedBoolean(value: unknown, path: readonly string[]): boolean | null {
  const found = readNested(value, path);
  return typeof found === "boolean" ? found : null;
}

function readNested(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!(key in record)) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function summarizeCaptureArtifact(artifact: E2ENetworkCaptureArtifact | null) {
  return {
    configured: Boolean(process.env.E2E_PROVIDER_CAPTURE_PATH),
    mode: process.env.E2E_PROVIDER_CAPTURE_MODE,
    proxyUrl: process.env.E2E_PROVIDER_CAPTURE_PROXY_URL,
    records:
      artifact?.records.map((record) => summarizeCaptureRecord(record)) ?? [],
  };
}

function summarizeCaptureRecord(record: E2ENetworkCaptureRecord) {
  return {
    host: record.host,
    method: record.method,
    path: record.path,
    protocol: record.protocol,
    requestBodyBytes: record.requestBodyBytes,
    responsePreview: record.responseTextPreview?.slice(0, 800),
    status: record.status,
    statusCode: record.statusCode,
    url: record.url,
  };
}
