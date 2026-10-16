type ProviderFetch = typeof globalThis.fetch;

const SSE_FRAME_SEPARATOR_PATTERN = /\r\n\r\n|\n\n|\r\r/;

export function createAnthropicCompatFetch(baseFetch: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    const response = await baseFetch(input, applyAnthropicRequestBodyCompatibility(init));
    return rewriteAnthropicJsonThinkingResponse(filterAnthropicStream(response));
  };
}

export const createAnthropicStreamCompatFetch = createAnthropicCompatFetch;

function applyAnthropicRequestBodyCompatibility(
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (typeof init?.body !== "string") return init;

  const body = safeParseRecord(init.body);
  if (!body) return init;
  const restoredSelectorBody = restoreMemorySelectorMessageBoundaries(body);
  const restoredSystemBody = restoreMidConversationSystemStringContent(restoredSelectorBody);
  if (restoredSystemBody === body) return init;

  return {
    ...init,
    body: JSON.stringify(restoredSystemBody),
  };
}

function restoreMemorySelectorMessageBoundaries(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = Array.isArray(body?.messages) ? body.messages : undefined;
  const firstMessage = safeRecord(messages?.[0]);
  const content = Array.isArray(firstMessage?.content) ? firstMessage.content : undefined;
  if (
    !isMemorySelectorOutput(body?.output_config) ||
    firstMessage?.role !== "user" ||
    content?.length !== 2 ||
    !hasTextPrefix(content[0], "Available memories:\n") ||
    !hasTextPrefix(content[1], "Select memories relevant to:\n")
  ) {
    return body;
  }

  // 修复原因：AI SDK 会在发请求前合并连续的 user message；Memory selector 的
  // provider-visible 基线要求 manifest 与当前 query 保持为两个独立 message。
  return {
    ...body,
    messages: [
      { ...firstMessage, content: [content[0]] },
      { role: "user", content: [content[1]] },
      ...messages!.slice(1),
    ],
  };
}

function restoreMidConversationSystemStringContent(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;

  let changed = false;
  const messages = body.messages.map((value) => {
    const message = safeRecord(value);
    if (message?.role !== "system") return value;
    const text = singlePlainTextBlock(message.content);
    if (text === undefined) return value;

    changed = true;
    return { ...message, content: text };
  });

  // 在最终 messages[] 中保留 string content；
  // AI SDK 会将同一纯文本扩成单元素 block array。这里只恢复该 wire shape，顶层
  // system[]、带 cache_control 的 block 和其他 message role 均保持原样。
  return changed ? { ...body, messages } : body;
}

function singlePlainTextBlock(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const block = safeRecord(value[0]);
  if (block?.type !== "text" || typeof block.text !== "string") return undefined;
  if (Object.keys(block).some((key) => key !== "type" && key !== "text")) return undefined;
  return block.text;
}

function isMemorySelectorOutput(value: unknown): boolean {
  const outputConfig = safeRecord(value);
  const format = safeRecord(outputConfig?.format);
  const schema = safeRecord(format?.schema);
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return format?.type === "json_schema" && required.includes("selected_memories");
}

function hasTextPrefix(value: unknown, prefix: string): boolean {
  const block = safeRecord(value);
  return block?.type === "text" && typeof block.text === "string" && block.text.startsWith(prefix);
}

function shouldFilterAnthropicStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true;
}

function filterAnthropicStream(response: Response): Response {
  if (!shouldFilterAnthropicStream(response)) {
    return response;
  }

  const body = response.body;
  if (!body) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  return new Response(body.pipeThrough(createAnthropicStreamCompatTransform()), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function rewriteAnthropicJsonThinkingResponse(response: Response): Promise<Response> {
  if (!shouldRewriteAnthropicJson(response)) {
    return response;
  }

  const text = await response.clone().text();
  const parsed = safeParseRecord(text);
  if (!parsed) {
    return response;
  }

  const sanitized = sanitizeJsonThinkingBlocks(parsed);
  if (!sanitized.changed) {
    return response;
  }

  return cloneTextResponse(response, JSON.stringify(sanitized.value));
}

function shouldRewriteAnthropicJson(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json") || contentType.includes("+json");
}

function cloneTextResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function sanitizeJsonThinkingBlocks(value: Record<string, unknown>): {
  changed: boolean;
  value: Record<string, unknown>;
} {
  if (!Array.isArray(value.content)) {
    return { changed: false, value };
  }

  const content = value.content.filter((block) => !isUnsignedThinkingBlock(block));
  if (content.length === value.content.length) {
    return { changed: false, value };
  }

  return {
    changed: true,
    value: {
      ...value,
      content,
    },
  };
}

function isUnsignedThinkingBlock(value: unknown): boolean {
  const block = safeRecord(value);
  if (block?.type !== "thinking") {
    return false;
  }

  // 部分 Anthropic-compatible 服务在非流式 JSON 中返回无签名
  // thinking block。AI SDK 会按 Anthropic 原生 schema 校验 signature 并拒绝
  // 整个响应；这里删除不可校验的思考块，保留 text/usage/stop_reason 继续解析。
  return typeof block.signature !== "string" && typeof block.redactedData !== "string";
}

interface AnthropicStreamCompatState {
  pendingThinkingSignatures: Map<number, string>;
  suppressedIndexes: Set<number>;
}

function createAnthropicStreamCompatTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state: AnthropicStreamCompatState = {
    pendingThinkingSignatures: new Map(),
    suppressedIndexes: new Set(),
  };
  let pending = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      pending = emitCompleteFrames(pending, controller, encoder, state);
    },
    flush(controller) {
      pending += decoder.decode();
      pending = emitCompleteFrames(pending, controller, encoder, state);
      if (pending.length > 0) {
        emitFrame(pending, "", controller, encoder, state);
      }
    },
  });
}

function emitCompleteFrames(
  input: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: AnthropicStreamCompatState,
): string {
  let pending = input;
  for (;;) {
    const match = SSE_FRAME_SEPARATOR_PATTERN.exec(pending);
    if (!match) {
      return pending;
    }

    const separator = match[0] ?? "";
    const frame = pending.slice(0, match.index);
    pending = pending.slice(match.index + separator.length);
    emitFrame(frame, separator, controller, encoder, state);
  }
}

function emitFrame(
  frame: string,
  separator: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: AnthropicStreamCompatState,
): void {
  const decision = decideFrame(frame, state);
  if (decision === false) {
    return;
  }

  if (decision !== true) {
    controller.enqueue(encoder.encode(createSignatureDeltaFrame(decision, separator)));
  }
  controller.enqueue(encoder.encode(`${frame}${separator}`));
}

function decideFrame(
  frame: string,
  state: AnthropicStreamCompatState,
): boolean | { index: number; signature: string } {
  const data = readSseData(frame);
  if (data === undefined || data === "[DONE]") {
    return true;
  }

  const parsed = safeParseRecord(data);
  if (!parsed) {
    return true;
  }

  const type = typeof parsed.type === "string" ? parsed.type : undefined;
  if (type === "message_start") {
    state.pendingThinkingSignatures.clear();
    state.suppressedIndexes.clear();
    return true;
  }

  const index = typeof parsed.index === "number" ? parsed.index : undefined;
  if (index === undefined) {
    return true;
  }

  if (type === "content_block_start") {
    const block = safeRecord(parsed.content_block);
    if (
      block?.type === "thinking" &&
      typeof block.signature === "string" &&
      block.signature.length > 0
    ) {
      state.pendingThinkingSignatures.set(index, block.signature);
    }

    // Some Anthropic-compatible APIs expose provider-internal image tool results as
    // assistant-side bare tool_result blocks. AI SDK rejects that non-standard shape.
    if (block?.type === "tool_result") {
      state.suppressedIndexes.add(index);
      return false;
    }
  }

  if (type === "content_block_delta" && safeRecord(parsed.delta)?.type === "signature_delta") {
    state.pendingThinkingSignatures.delete(index);
  }

  let missingSignatureDelta: { index: number; signature: string } | undefined;
  if (type === "content_block_stop") {
    const signature = state.pendingThinkingSignatures.get(index);
    state.pendingThinkingSignatures.delete(index);
    if (signature) {
      // 部分 Anthropic-compatible 服务把最终签名直接放在 thinking start，
      // 但 AI SDK 只从 signature_delta 读取签名；仅在缺少原生 delta 时补成标准事件。
      missingSignatureDelta = { index, signature };
    }
  }

  if (state.suppressedIndexes.has(index)) {
    if (type === "content_block_stop") {
      state.suppressedIndexes.delete(index);
    }
    return false;
  }

  return missingSignatureDelta ?? true;
}

function createSignatureDeltaFrame(
  value: { index: number; signature: string },
  separator: string,
): string {
  const frameSeparator = separator || "\n\n";
  const lineEnding =
    frameSeparator === "\r\n\r\n" ? "\r\n" : frameSeparator === "\r\r" ? "\r" : "\n";
  const data = JSON.stringify({
    type: "content_block_delta",
    index: value.index,
    delta: { type: "signature_delta", signature: value.signature },
  });
  return `event: content_block_delta${lineEnding}data: ${data}${frameSeparator}`;
}

function readSseData(frame: string): string | undefined {
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r\n|\n|\r/)) {
    if (!rawLine.startsWith("data:")) {
      continue;
    }

    let value = rawLine.slice("data:".length);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    dataLines.push(value);
  }

  return dataLines.length === 0 ? undefined : dataLines.join("\n");
}

function safeParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    return safeRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
