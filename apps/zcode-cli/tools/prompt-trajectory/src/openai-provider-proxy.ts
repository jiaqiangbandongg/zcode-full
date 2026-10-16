import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import { assembleNonStreamingAssistantMessage, assembleStreamingAssistantMessage } from "./openai-response-assembler.js";
import type { MessageLedger } from "./message-ledger.js";
import type { JsonObject } from "./types.js";

export interface OpenAiProviderProxy {
  baseURL: string;
  close(): Promise<void>;
}

export async function startOpenAiProviderProxy(input: {
  ledger: MessageLedger;
  mockResponses?: readonly unknown[];
  upstreamBaseURL: string;
}): Promise<OpenAiProviderProxy> {
  const upstreamBaseURL = normalizeBaseURL(input.upstreamBaseURL);
  const mockResponseResolver = input.mockResponses
    ? createMockResponseResolver(input.mockResponses)
    : undefined;
  const server = createServer((request, response) => {
    void handleRequest({
      ledger: input.ledger,
      getMockResponse: mockResponseResolver,
      request,
      response,
      upstreamBaseURL,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const baseURL = new URL(upstreamBaseURL.pathname, `http://127.0.0.1:${address.port}`);
  return {
    baseURL: baseURL.href.replace(/\/$/u, ""),
    close: () => closeServer(server),
  };
}

async function handleRequest(input: {
  getMockResponse?: (requestBody: JsonObject) => unknown;
  ledger: MessageLedger;
  request: IncomingMessage;
  response: ServerResponse;
  upstreamBaseURL: URL;
}): Promise<void> {
  try {
    const bodyText = await readRequestBody(input.request);
    const requestBody = parseRequestBody(bodyText);
    const requestIndex = await input.ledger.recordRequestBody(requestBody);
    if (input.getMockResponse) {
      await writeMockResponse({
        getMockResponse: input.getMockResponse,
        ledger: input.ledger,
        requestBody,
        requestIndex,
        response: input.response,
      });
      return;
    }
    const upstreamResponse = await fetch(resolveUpstreamURL(input.request, input.upstreamBaseURL), {
      body: bodyText,
      headers: forwardHeaders(input.request.headers),
      method: input.request.method,
    });

    writeResponseHead(input.response, upstreamResponse);
    if (isEventStream(upstreamResponse)) {
      await proxyStreamingResponse({
        ledger: input.ledger,
        requestIndex,
        response: input.response,
        upstreamResponse,
      });
      return;
    }

    await proxyJsonResponse({
      ledger: input.ledger,
      requestIndex,
      response: input.response,
      upstreamResponse,
    });
  } catch (error) {
    writeProxyError(input.response, error);
  }
}

async function writeMockResponse(input: {
  getMockResponse: (requestBody: JsonObject) => unknown;
  ledger: MessageLedger;
  requestBody: JsonObject;
  requestIndex: number;
  response: ServerResponse;
}): Promise<void> {
  const mockResponse = input.getMockResponse(input.requestBody);
  if (mockResponse === undefined) {
    throw new Error(`Missing mock OpenAI response for request ${input.requestIndex}.`);
  }
  const responseBody = normalizeMockResponseForRequest(mockResponse, input.requestBody);
  const responseText = JSON.stringify(responseBody);
  input.response.statusCode = 200;
  input.response.setHeader("content-type", "application/json");
  input.response.end(responseText);
  await input.ledger.recordAssistantMessage(
    input.requestIndex,
    assembleNonStreamingAssistantMessage(responseBody),
  );
}

interface MockResponseMatch {
  allMessageIncludes?: string[];
  messageIncludes?: string;
  notMessageIncludes?: string[];
}

interface MockResponseRule {
  match?: MockResponseMatch;
  response: unknown;
}

function createMockResponseResolver(
  mockResponses: readonly unknown[],
): (requestBody: JsonObject) => unknown {
  let sequentialIndex = 0;
  const consumed = new Set<number>();

  return (requestBody) => {
    for (let index = 0; index < mockResponses.length; index += 1) {
      if (consumed.has(index)) continue;
      const rule = asMockResponseRule(mockResponses[index]);
      if (!rule || !matchesMockResponseRule(rule, requestBody)) continue;
      consumed.add(index);
      return rule.response;
    }

    while (sequentialIndex < mockResponses.length) {
      const index = sequentialIndex;
      sequentialIndex += 1;
      if (consumed.has(index)) continue;
      if (asMockResponseRule(mockResponses[index])) continue;
      consumed.add(index);
      return mockResponses[index];
    }

    return undefined;
  };
}

function asMockResponseRule(value: unknown): MockResponseRule | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, "response")) return undefined;
  const match = isRecord(value.match) ? readMockResponseMatch(value.match) : undefined;
  return {
    ...(match ? { match } : {}),
    response: value.response,
  };
}

function readMockResponseMatch(value: Record<string, unknown>): MockResponseMatch {
  return {
    ...(Array.isArray(value.allMessageIncludes)
      ? { allMessageIncludes: value.allMessageIncludes.filter(isString) }
      : {}),
    ...(typeof value.messageIncludes === "string"
      ? { messageIncludes: value.messageIncludes }
      : {}),
    ...(Array.isArray(value.notMessageIncludes)
      ? { notMessageIncludes: value.notMessageIncludes.filter(isString) }
      : {}),
  };
}

function matchesMockResponseRule(rule: MockResponseRule, requestBody: JsonObject): boolean {
  const match = rule.match;
  if (!match) return true;
  const requestText = JSON.stringify(requestBody.messages ?? requestBody.input ?? []);
  if (match.messageIncludes && !requestText.includes(match.messageIncludes)) return false;
  if (match.allMessageIncludes?.some((value) => !requestText.includes(value))) return false;
  if (match.notMessageIncludes?.some((value) => requestText.includes(value))) return false;
  return true;
}

function normalizeMockResponseForRequest(mockResponse: unknown, requestBody: JsonObject): unknown {
  if (!Array.isArray(requestBody.input)) return mockResponse;
  if (isRecord(mockResponse) && Array.isArray(mockResponse.output)) return mockResponse;

  const message = firstChatChoiceMessage(mockResponse);
  if (!message) return mockResponse;
  const usage = isRecord(mockResponse) ? usageFromChatCompletion(mockResponse.usage) : undefined;
  const base = {
    id: stringProperty(mockResponse, "id") ?? "mock-response",
    created_at: numberProperty(mockResponse, "created") ?? 0,
    model: stringProperty(mockResponse, "model") ?? stringProperty(requestBody, "model"),
    ...(usage ? { usage } : {}),
  };

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length > 0) {
    return {
      ...base,
      output: toolCalls.flatMap((toolCall) => responseFunctionCallFromChatToolCall(toolCall)),
    };
  }

  return {
    ...base,
    output: [
      {
        type: "message",
        role: "assistant",
        id: `${base.id}_message`,
        content: [
          {
            type: "output_text",
            text: typeof message.content === "string" ? message.content : "",
            annotations: [],
          },
        ],
      },
    ],
  };
}

function firstChatChoiceMessage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  return first.message;
}

function responseFunctionCallFromChatToolCall(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !isRecord(value.function)) return [];
  const callId = stringProperty(value, "id") ?? randomUUID();
  return [
    {
      type: "function_call",
      id: `${callId}_item`,
      call_id: callId,
      name: stringProperty(value.function, "name") ?? "",
      arguments: stringProperty(value.function, "arguments") ?? "",
    },
  ];
}

function usageFromChatCompletion(value: unknown):
  | {
      input_tokens: number;
      output_tokens: number;
    }
  | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberProperty(value, "prompt_tokens");
  const outputTokens = numberProperty(value, "completion_tokens");
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

function stringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

async function proxyJsonResponse(input: {
  ledger: MessageLedger;
  requestIndex: number;
  response: ServerResponse;
  upstreamResponse: Response;
}): Promise<void> {
  const responseText = await input.upstreamResponse.text();
  input.response.end(responseText);
  const parsed = safeJsonParse(responseText);
  await input.ledger.recordAssistantMessage(
    input.requestIndex,
    assembleNonStreamingAssistantMessage(parsed),
  );
}

async function proxyStreamingResponse(input: {
  ledger: MessageLedger;
  requestIndex: number;
  response: ServerResponse;
  upstreamResponse: Response;
}): Promise<void> {
  const body = input.upstreamResponse.body;
  if (!body) {
    input.response.end();
    return;
  }

  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    input.response.write(value);
  }
  input.response.end();
  await input.ledger.recordAssistantMessage(
    input.requestIndex,
    assembleStreamingAssistantMessage(chunks),
  );
}

function parseRequestBody(bodyText: string): JsonObject {
  const parsed = safeJsonParse(bodyText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Provider proxy only supports JSON OpenAI request bodies.");
  }
  return parsed as JsonObject;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveUpstreamURL(request: IncomingMessage, upstreamBaseURL: URL): URL {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const upstreamPath = upstreamBaseURL.pathname.replace(/\/$/u, "");
  const requestPath = requestUrl.pathname;
  const suffix = requestPath.startsWith(upstreamPath)
    ? requestPath.slice(upstreamPath.length)
    : requestPath;
  const upstream = new URL(`${upstreamPath}/${suffix.replace(/^\/+/u, "")}`, upstreamBaseURL);
  upstream.search = requestUrl.search;
  return upstream;
}

function normalizeBaseURL(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url;
}

function forwardHeaders(headers: IncomingMessage["headers"]): Headers {
  const next = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "connection") continue;
    if (Array.isArray(value)) {
      for (const item of value) next.append(key, item);
      continue;
    }
    next.set(key, value);
  }
  return next;
}

function writeResponseHead(response: ServerResponse, upstreamResponse: Response): void {
  response.statusCode = upstreamResponse.status;
  upstreamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "content-encoding" ||
      lower === "content-length" ||
      lower === "connection" ||
      lower === "transfer-encoding"
    ) {
      return;
    }
    response.setHeader(key, value);
  });
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeProxyError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  response.statusCode = 502;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      error: error instanceof Error ? error.message : "Provider proxy failed.",
    }),
  );
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
