import { randomUUID } from "node:crypto";

type ProviderFetch = typeof globalThis.fetch;

export function createOpenAIResponsesJsonCompatFetch(baseFetch: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response.ok || isEventStream(response)) {
      return response;
    }

    const body = await parseJsonObject(response);
    if (!body) {
      return response;
    }

    const normalized = normalizeOpenAIResponsesJson(body);
    if (!normalized) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");

    return new Response(JSON.stringify(normalized), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

export function normalizeOpenAIResponsesJson(value: unknown): Record<string, unknown> | undefined {
  const response = asRecord(value);
  if (!response || !Array.isArray(response.output)) {
    return undefined;
  }

  const responseId =
    typeof response.id === "string" && response.id.length > 0 ? response.id : undefined;
  let changed = false;
  const output = response.output.map((item) => {
    const message = asRecord(item);
    if (message?.type !== "message") {
      return item;
    }

    let normalizedMessage = message;
    if (message.id === undefined && responseId) {
      // 部分 Responses-compatible 服务在非流式 compact 响应里省略
      // message.id，AI SDK 会在读取正文前拒绝整个 HTTP 200 响应。
      normalizedMessage = {
        ...normalizedMessage,
        id: `msg_${randomUUID()}`,
      };
      changed = true;
    }

    if (!Array.isArray(message.content)) {
      return normalizedMessage;
    }

    let contentChanged = false;
    const content = message.content.map((itemContent) => {
      const outputText = asRecord(itemContent);
      if (outputText?.type !== "output_text" || outputText.annotations !== undefined) {
        return itemContent;
      }

      contentChanged = true;
      return { ...outputText, annotations: [] };
    });

    if (!contentChanged) {
      return normalizedMessage;
    }

    changed = true;
    return { ...normalizedMessage, content };
  });

  return changed ? { ...response, output } : undefined;
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true;
}

async function parseJsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(JSON.parse(await response.clone().text()));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
