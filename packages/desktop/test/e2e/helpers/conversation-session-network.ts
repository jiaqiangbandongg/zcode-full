import { readFile } from "node:fs/promises";
import type { E2ENetworkCaptureArtifact } from "./network-capture-proxy.js";

export interface UpstreamRequestQuery {
  excludes?: string[];
  includes?: string[];
  lastUserMessageExcludes?: string[];
  lastUserMessageIncludes?: string[];
}

export interface UpstreamRequestIndexOptions {
  afterIndex?: number;
  beforeIndex?: number;
}

export interface UpstreamToolResultSnapshot {
  content: string;
  isError: boolean;
  toolCallId: string;
}

export interface UpstreamRequestEvidence {
  fixtureId: string | null;
  path: string;
  requestJson: unknown;
  responseBodyBytes: number;
  responseEventCount: number;
  responseTextPreview: string | null;
  startedAt: string;
  status: E2ENetworkCaptureArtifact["records"][number]["status"];
}

export async function countUpstreamRequestsContaining(text: string) {
  return countUpstreamRequests({ includes: [text] });
}

export async function countUpstreamRequestsContainingAll(texts: string[]) {
  return countUpstreamRequests({ includes: texts });
}

export async function countUpstreamTitleRequestsContaining(text: string) {
  const artifact = await readUpstreamCaptureArtifact();
  return (
    artifact?.records.filter(
      (record) =>
        record.method === "POST" &&
        isUpstreamModelRequestPath(record.path) &&
        captureContainsText(record.requestJson, "Generate a concise title") &&
        captureContainsText(record.requestJson, text),
    ).length ?? 0
  );
}

export async function countUpstreamRequests(
  query: UpstreamRequestQuery,
  options: UpstreamRequestIndexOptions = {},
) {
  const artifact = await readUpstreamCaptureArtifact();
  return (
    artifact?.records.filter(
      (record, recordIndex) =>
        isWithinIndexOptions(recordIndex, options) && matchesUpstreamRequest(record, query),
    ).length ?? 0
  );
}

export async function getUpstreamRequestRecordCount() {
  const artifact = await readUpstreamCaptureArtifact();
  return artifact?.records.length ?? 0;
}

/**
 * 返回已经脱敏的 replay 请求证据，供 fault-stream E2E 同时核对 fixture、请求历史和
 * capture 状态。不能只看 UI 完成文案，否则一次未命中 fixture 的 500 retry 也可能被误判。
 */
export async function getUpstreamRequestEvidence(
  query: UpstreamRequestQuery,
  options: UpstreamRequestIndexOptions = {},
): Promise<UpstreamRequestEvidence[]> {
  const artifact = await readUpstreamCaptureArtifact();
  return (artifact?.records ?? [])
    .filter(
      (record, recordIndex) =>
        isWithinIndexOptions(recordIndex, options) && matchesUpstreamRequest(record, query),
    )
    .map((record) => ({
      fixtureId: record.replay?.fixtureId ?? null,
      path: record.path,
      requestJson: record.requestJson,
      responseBodyBytes: record.responseBodyBytes,
      responseEventCount: record.responseEvents?.length ?? 0,
      responseTextPreview: record.responseTextPreview ?? null,
      startedAt: record.startedAt,
      status: record.status,
    }));
}

export async function getLatestUpstreamToolResultByToolCallId(
  toolCallId: string,
): Promise<UpstreamToolResultSnapshot | null> {
  const artifact = await readUpstreamCaptureArtifact();
  const records = artifact?.records ?? [];
  for (
    let recordIndex = records.length - 1;
    recordIndex >= 0;
    recordIndex -= 1
  ) {
    const result = readUpstreamToolResultFromRequest(
      records[recordIndex]?.requestJson,
      toolCallId,
    );
    if (result) return result;
  }
  return null;
}

/** 返回首个匹配 provider 请求实际暴露的工具名，用于核对 turn-scoped 工具权限边界。 */
export async function getUpstreamRequestToolNames(
  query: UpstreamRequestQuery,
): Promise<string[]> {
  const record = await findUpstreamRequestRecord(query);
  return readUpstreamRequestTools(record?.requestJson)
    .map(readUpstreamToolName)
    .filter(Boolean);
}

/** 返回首个匹配 provider 请求里的原始工具 contract，覆盖 description 与 input schema。 */
export async function getUpstreamRequestToolContract(
  query: UpstreamRequestQuery,
  toolName: string,
): Promise<unknown | null> {
  const record = await findUpstreamRequestRecord(query);
  return (
    readUpstreamRequestTools(record?.requestJson).find(
      (tool) => readUpstreamToolName(tool) === toolName,
    ) ?? null
  );
}

export async function findFirstUpstreamRequestIndex(
  query: UpstreamRequestQuery,
  options: UpstreamRequestIndexOptions = {},
) {
  const artifact = await readUpstreamCaptureArtifact();
  const records = artifact?.records ?? [];
  const index = records.findIndex(
    (record, recordIndex) =>
      isWithinIndexOptions(recordIndex, options) && matchesUpstreamRequest(record, query),
  );
  return index >= 0 ? index : null;
}

export async function findLastUpstreamRequestIndex(
  query: UpstreamRequestQuery,
  options: UpstreamRequestIndexOptions = {},
) {
  const artifact = await readUpstreamCaptureArtifact();
  const records = artifact?.records ?? [];
  for (let index = records.length - 1; index >= 0; index--) {
    if (isWithinIndexOptions(index, options) && matchesUpstreamRequest(records[index]!, query)) {
      return index;
    }
  }
  return null;
}

export async function waitForUpstreamRequestContaining(
  text: string,
  timeout = 30000,
) {
  await waitForUpstreamRequest(
    { includes: [text] },
    `没有捕获到 上游 请求 body: ${text}`,
    timeout,
  );
}

export async function waitForUpstreamRequest(
  query: UpstreamRequestQuery,
  timeoutMsg: string,
  timeout = 30000,
  options: UpstreamRequestIndexOptions = {},
) {
  let latestCount = 0;
  try {
    await browser.waitUntil(
      async () => {
        latestCount = await countUpstreamRequests(query, options);
        return latestCount > 0;
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    const artifact = await readUpstreamCaptureArtifact();
    // Bug 根因：旧 timeoutMsg 在 waitUntil 启动前就把 latestCount 插值成 0，
    // shard 失败后无法区分“请求未发出”和“请求已发出但 body 不匹配”。超时现场
    // 必须重新读取最终 artifact，并只输出脱敏后的 fixture/status/缺失条件摘要。
    throw new Error(
      `${timeoutMsg}; latestCount=${latestCount}; capture=${JSON.stringify(
        summarizeUpstreamCapture(artifact, query, options),
      )}`,
      { cause: error },
    );
  }
}

export async function expectNoUpstreamRequestForTextWithin(
  text: string,
  durationMs: number,
) {
  const before = await countUpstreamRequestsContaining(text);
  await browser.pause(durationMs);
  const after = await countUpstreamRequestsContaining(text);
  expect(after).toBe(before);
}

async function readUpstreamCaptureArtifact(): Promise<E2ENetworkCaptureArtifact | null> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    return null;
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

function captureContainsText(value: unknown, expected: string): boolean {
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

function matchesUpstreamRequest(
  record: E2ENetworkCaptureArtifact["records"][number],
  query: UpstreamRequestQuery,
) {
  const latestUserMessageText =
    query.lastUserMessageIncludes || query.lastUserMessageExcludes
      ? readLatestUserMessageText(record.requestJson)
      : "";
  return (
    record.method === "POST" &&
    isUpstreamModelRequestPath(record.path) &&
    !captureContainsText(record.requestJson, "Generate a concise title") &&
    (query.includes ?? []).every((text) => captureContainsText(record.requestJson, text)) &&
    !(query.excludes ?? []).some((text) => captureContainsText(record.requestJson, text)) &&
    (query.lastUserMessageIncludes ?? []).every((text) =>
      latestUserMessageText.includes(text),
    ) &&
    !(query.lastUserMessageExcludes ?? []).some((text) =>
      latestUserMessageText.includes(text),
    )
  );
}

function isUpstreamModelRequestPath(path: string): boolean {
  return (
    path.includes("/messages") || path.includes("/chat/completions") || path.includes("/responses")
  );
}

async function findUpstreamRequestRecord(query: UpstreamRequestQuery) {
  const artifact = await readUpstreamCaptureArtifact();
  return (
    artifact?.records.find((record) => matchesUpstreamRequest(record, query)) ?? null
  );
}

function readUpstreamRequestTools(requestJson: unknown): unknown[] {
  if (!requestJson || typeof requestJson !== "object") return [];
  const tools = (requestJson as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools : [];
}

function readUpstreamToolName(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const directName = (tool as { name?: unknown }).name;
  if (typeof directName === "string") return directName;
  const nestedFunction = (tool as { function?: unknown }).function;
  if (!nestedFunction || typeof nestedFunction !== "object") return "";
  const nestedName = (nestedFunction as { name?: unknown }).name;
  return typeof nestedName === "string" ? nestedName : "";
}

function readLatestUserMessageText(requestJson: unknown): string {
  if (!requestJson || typeof requestJson !== "object") {
    return "";
  }
  const messages = (requestJson as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    if ((message as { role?: unknown }).role !== "user") {
      continue;
    }
    return readMessageContentText((message as { content?: unknown }).content);
  }
  return "";
}

export function readUpstreamToolResultFromRequest(
  requestJson: unknown,
  toolCallId: string,
): UpstreamToolResultSnapshot | null {
  if (!requestJson || typeof requestJson !== "object") return null;
  const messages = (requestJson as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex];
      if (!part || typeof part !== "object") continue;
      const record = part as {
        content?: unknown;
        is_error?: unknown;
        tool_use_id?: unknown;
        type?: unknown;
      };
      if (
        record.type !== "tool_result" ||
        record.tool_use_id !== toolCallId
      ) {
        continue;
      }
      return {
        content: readMessageContentText(record.content),
        isError: record.is_error === true,
        toolCallId,
      };
    }
  }
  return null;
}

function readMessageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return text;
      // 和 replay matcher 保持同一语义：latest user message 包含 tool_result，
      // 不能退化成全 body 搜索并误命中 assistant tool code 里的 marker。
      if ((part as { type?: unknown }).type === "tool_result") {
        return readMessageContentText((part as { content?: unknown }).content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isWithinIndexOptions(index: number, options: UpstreamRequestIndexOptions) {
  if (options.afterIndex !== undefined && index <= options.afterIndex) return false;
  if (options.beforeIndex !== undefined && index >= options.beforeIndex) return false;
  return true;
}

function summarizeUpstreamCapture(
  artifact: E2ENetworkCaptureArtifact | null,
  query: UpstreamRequestQuery,
  options: UpstreamRequestIndexOptions,
) {
  const records = artifact?.records ?? [];
  return {
    configured: Boolean(process.env.E2E_PROVIDER_CAPTURE_PATH?.trim()),
    recordCount: records.length,
    records: records.slice(-12).map((record, offset) => {
      const index = Math.max(0, records.length - 12) + offset;
      const latestUserMessageText = readLatestUserMessageText(record.requestJson);
      return {
        fixtureId: record.replay?.fixtureId ?? null,
        index,
        matches: isWithinIndexOptions(index, options) && matchesUpstreamRequest(record, query),
        missingIncludes: (query.includes ?? []).filter(
          (text) => !captureContainsText(record.requestJson, text),
        ),
        missingLastUserMessageIncludes: (query.lastUserMessageIncludes ?? []).filter(
          (text) => !latestUserMessageText.includes(text),
        ),
        status: record.status,
        statusCode: record.statusCode ?? null,
      };
    }),
  };
}
