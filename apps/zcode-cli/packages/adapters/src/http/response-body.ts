import { createHttpClientError } from "@zcode/contracts";

/**
 * 读正文所需的最小形状：原生 fetch 的 `Response` 与 adapter 自己读出的 `IncomingResponse` 都满足它。
 * 不要求是 `Response`：后者表示不了 200–599 之外的状态码（network/incoming-response.ts）。
 */
export interface ResponseLike {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export async function readResponseBody(
  response: ResponseLike,
  maxResponseBytes: number,
  signal: AbortSignal,
  url: string,
): Promise<Uint8Array> {
  if (maxResponseBytes < 0) {
    throw createHttpClientError({
      code: "too_large",
      url,
      status: response.status,
      message: "HTTP response size limit must not be negative",
    });
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxResponseBytes) {
      throw createHttpClientError({
        code: "too_large",
        url,
        status: response.status,
        message: `HTTP response is too large: content-length=${parsed}, max=${maxResponseBytes}`,
      });
    }
  }

  // 没有正文流只发生在无正文状态（204 / 304 …）：正文就是空的。
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    if (signal.aborted) {
      throw createHttpClientError({
        code: "cancelled",
        url,
        status: response.status,
        message: "HTTP request was cancelled while reading response body",
      });
    }

    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw createHttpClientError({
        code: "too_large",
        url,
        status: response.status,
        message: `HTTP response is too large: bytes>${maxResponseBytes}`,
      });
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
