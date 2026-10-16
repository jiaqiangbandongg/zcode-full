import http from "node:http";
import { writeFile } from "node:fs/promises";

const LOCALHOST = "127.0.0.1";
const MAX_CAPTURE_BODY_CHARS = 500_000;

export async function startCaptureProxy(input) {
  const upstreamBaseURL = trimTrailingSlash(input.upstreamBaseURL);
  const records = [];
  const server = http.createServer(async (request, response) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const requestBody = await readRequestBody(request);
    const upstreamURL = `${upstreamBaseURL}${request.url ?? "/"}`;
    const requestHeaders = normalizeHeaders(request.headers);

    try {
      const upstreamResponse = await fetch(upstreamURL, {
        body: request.method === "GET" || request.method === "HEAD" ? undefined : requestBody,
        headers: forwardHeaders(requestHeaders),
        method: request.method,
      });
      const responseBody = await upstreamResponse.text();
      const responseHeaders = normalizeResponseHeaders(upstreamResponse.headers);

      records.push({
        durationMs: Date.now() - startedMs,
        method: request.method,
        requestBody: truncateCaptureBody(requestBody),
        requestHeaders,
        responseBody: truncateCaptureBody(responseBody),
        responseHeaders,
        startedAt,
        status: upstreamResponse.status,
        upstreamURL,
        url: request.url,
      });

      response.writeHead(upstreamResponse.status, responseHeaders);
      response.end(responseBody);
    } catch (error) {
      records.push({
        durationMs: Date.now() - startedMs,
        error: error instanceof Error ? error.message : String(error),
        method: request.method,
        requestBody: truncateCaptureBody(requestBody),
        requestHeaders,
        startedAt,
        upstreamURL,
        url: request.url,
      });
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "capture_proxy_upstream_failed" }));
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
    throw new Error("Capture proxy did not bind to a TCP port");
  }

  return {
    baseURL: `http://${LOCALHOST}:${address.port}`,
    records,
    server,
    upstreamBaseURL,
  };
}

export async function stopCaptureProxy(proxy) {
  if (!proxy) return;
  await new Promise((resolve, reject) => {
    proxy.server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function writeCaptureFile(proxy, capturePath) {
  if (!proxy) return undefined;
  const payload = {
    capturedAt: new Date().toISOString(),
    records: proxy.records,
    upstreamBaseURL: proxy.upstreamBaseURL,
  };
  await writeFile(capturePath, `${JSON.stringify(payload, null, 2)}\n`);
  return capturePath;
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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

function forwardHeaders(headers) {
  const forwarded = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "content-length") continue;
    forwarded.set(key, value);
  }
  return forwarded;
}

function normalizeResponseHeaders(headers) {
  const normalized = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-encoding" || lower === "transfer-encoding") return;
    normalized[key] = value;
  });
  return normalized;
}

function truncateCaptureBody(body) {
  if (body.length <= MAX_CAPTURE_BODY_CHARS) return body;
  return `${body.slice(0, MAX_CAPTURE_BODY_CHARS)}...<capture truncated>`;
}
