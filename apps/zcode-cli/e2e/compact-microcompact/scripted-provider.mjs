import http from "node:http";
import { writeFile } from "node:fs/promises";

const LOCALHOST = "127.0.0.1";
const MAX_CAPTURE_BODY_CHARS = 500_000;

export async function startScriptedProvider(input) {
  const records = [];
  const server = http.createServer(async (request, response) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const requestBody = await readRequestBody(request);
    const requestJson = parseJson(requestBody);
    const requestHeaders = normalizeHeaders(request.headers);
    const upstreamURL = `scripted://${input.name}${request.url ?? "/"}`;

    try {
      const scripted = await input.handler({
        body: requestJson,
        headers: requestHeaders,
        method: request.method,
        url: request.url ?? "/",
      });
      const responseBody = scripted.bodyText ?? JSON.stringify(scripted.body);
      if (typeof responseBody !== "string") {
        throw new Error("Scripted provider response must include body or bodyText");
      }
      const responseHeaders = scripted.headers ?? { "content-type": "application/json" };
      records.push({
        durationMs: Date.now() - startedMs,
        method: request.method,
        requestBody: truncateCaptureBody(requestBody),
        requestHeaders,
        responseBody: truncateCaptureBody(responseBody),
        responseHeaders,
        startedAt,
        status: scripted.status ?? 200,
        upstreamURL,
        url: request.url,
      });
      response.writeHead(scripted.status ?? 200, responseHeaders);
      response.end(responseBody);
    } catch (error) {
      const responseBody = JSON.stringify({ error: { message: String(error) } });
      records.push({
        durationMs: Date.now() - startedMs,
        error: error instanceof Error ? error.message : String(error),
        method: request.method,
        requestBody: truncateCaptureBody(requestBody),
        requestHeaders,
        responseBody,
        startedAt,
        status: 500,
        upstreamURL,
        url: request.url,
      });
      response.writeHead(500, { "content-type": "application/json" });
      response.end(responseBody);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCALHOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Scripted provider did not bind to a TCP port");
  }

  return {
    baseURL: `http://${LOCALHOST}:${address.port}`,
    records,
    server,
    upstreamBaseURL: `scripted://${input.name}`,
  };
}

export async function stopScriptedProvider(provider) {
  if (!provider) return;
  await new Promise((resolve, reject) => {
    provider.server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function writeScriptedCaptureFile(provider, capturePath) {
  if (!provider) return undefined;
  const payload = {
    capturedAt: new Date().toISOString(),
    records: provider.records,
    upstreamBaseURL: provider.upstreamBaseURL,
  };
  await writeFile(capturePath, `${JSON.stringify(payload, null, 2)}\n`);
  return capturePath;
}

export function chatCompletion(input) {
  return {
    id: `chatcmpl-${input.id ?? crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        finish_reason: input.toolCalls ? "tool_calls" : (input.finishReason ?? "stop"),
        message: {
          role: "assistant",
          content: input.content ?? "",
          ...(input.toolCalls ? { tool_calls: input.toolCalls } : {}),
        },
      },
    ],
    usage: input.usage ?? {
      prompt_tokens: input.promptTokens ?? 100,
      completion_tokens: input.completionTokens ?? 20,
      total_tokens: (input.promptTokens ?? 100) + (input.completionTokens ?? 20),
    },
  };
}

export function contextExceededError() {
  return {
    error: {
      code: "context_length_exceeded",
      message: "context length exceeded: prompt too long, 500 tokens > 300 tokens.",
      type: "invalid_request_error",
    },
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return normalized;
}

function truncateCaptureBody(body) {
  if (body.length <= MAX_CAPTURE_BODY_CHARS) return body;
  return `${body.slice(0, MAX_CAPTURE_BODY_CHARS)}...<capture truncated>`;
}
