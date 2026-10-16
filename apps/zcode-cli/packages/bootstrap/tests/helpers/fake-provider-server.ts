/**
 * 假 provider 服务器（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Verification」）。
 *
 * 一台进程内 `node:http` 服务器，同时会说 Anthropic Messages 与 OpenAI chat completions 两种
 * wire（帧在 fake-provider-wire.ts）；前面挂一层与格式无关的**故障程序**（按到达序号 / 在飞数 /
 * 对话进度作出判决），后面是一个**罐头模型**：按对话里已有的 `tool_result` 数决定这是第几轮——
 * 前 K 轮回一个空转 `Glob` 工具调用，之后回 `submit_result`。应答是请求内容的纯函数：同一请求
 * 重试若干次得到同一答案，这是矩阵确定性的根。
 *
 * 只绑 127.0.0.1:0；一格一台；`close()` 连同挂着的 socket 一起销毁，免得 hang 判决把测试进程
 * 拖住。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  businessErrorBody,
  cannedTurn,
  DEFAULT_VISIBLE_TEXT,
  firstFrame,
  SSE_HEADERS,
  streamErrorFrame,
  successBody,
  successStream,
  visibleFrame,
  type CannedModelOptions,
  type WireFormat,
} from "./fake-provider-wire.js";

export {
  type WireFormat,
} from "./fake-provider-wire.js";

/** 故障程序对一个到达请求的判决；与 wire 无关。 */
export type Verdict =
  | { kind: "serve" }
  | {
      kind: "status";
      status: number;
      code?: string;
      message?: string;
      headers?: Record<string, string>;
      bodyShape?: "error-object" | "top-level";
    }
  | { kind: "reset" }
  | { kind: "hang" }
  | { kind: "cut"; after: "headers" | "message_start" | "visible" }
  | { kind: "stream_error"; code: string; message: string }
  | { kind: "delay"; ms: number; next: Verdict };

/** 故障程序看到的请求事实：到达序号（从 1 起）、到达时**不含自己**的在飞数、对话进度、是否流式、路由。 */
export interface FaultRequest {
  ordinal: number;
  inFlight: number;
  toolResultCount: number;
  stream: boolean;
  route: WireFormat;
}

export type FaultProgram = (request: FaultRequest) => Verdict;

export interface RequestLedgerEntry {
  ordinal: number;
  /** 到达时刻（Date.now()）。 */
  at: number;
  route: WireFormat;
  stream: boolean;
  toolResultCount: number;
  inFlightAtArrival: number;
  verdict: Verdict;
  /** 实际写出的状态码；reset / hang 没有。 */
  servedStatus?: number;
  /** 客户端在应答写完之前断开（abort 的物证）。 */
  closedByClient: boolean;
  finishedAt?: number;
}

export interface FakeProviderServer {
  readonly baseURL: string;
  readonly requests: readonly RequestLedgerEntry[];
  readonly inFlightPeak: number;
  readonly inFlight: number;
  setProgram(program: FaultProgram): void;
  close(): Promise<void>;
}

// ————————————————————————————————————————————————————————————————
// 请求解析
// ————————————————————————————————————————————————————————————————

function routeOf(pathname: string): WireFormat | undefined {
  if (pathname.endsWith("/messages")) return "anthropic-messages";
  if (pathname.endsWith("/chat/completions")) return "openai-chat-completions";
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 对话里已有的 tool_result 数：Anthropic 数 user 消息里的 `tool_result` 块，OpenAI 数 `role:"tool"` 消息。 */
function countToolResults(route: WireFormat, body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let count = 0;
  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    if (route === "openai-chat-completions") {
      if (message.role === "tool") count += 1;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (asRecord(block)?.type === "tool_result") count += 1;
    }
  }
  return count;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 写一段数据并等它真的进了内核缓冲区（cut 判决要在切断之前把前面的帧送出去）。 */
function writeFlushed(response: ServerResponse, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    response.write(chunk, () => resolve());
  });
}

// ————————————————————————————————————————————————————————————————
// 服务器
// ————————————————————————————————————————————————————————————————

interface ServerState {
  program: FaultProgram;
  canned: CannedModelOptions;
  requests: RequestLedgerEntry[];
  inFlight: number;
  inFlightPeak: number;
  nextOrdinal: number;
}

/** 把一条已记账、已判决的请求按判决写出去。 */
async function respond(
  entry: RequestLedgerEntry,
  verdict: Exclude<Verdict, { kind: "delay" }>,
  request: IncomingMessage,
  response: ServerResponse,
  state: ServerState,
): Promise<void> {
  const { route, ordinal, stream } = entry;
  switch (verdict.kind) {
    case "reset": {
      request.socket.destroy();
      return;
    }
    case "hang": {
      // 永不应答；客户端断开时 response 'close' 会把账记上。
      return;
    }
    case "status": {
      entry.servedStatus = verdict.status;
      response.writeHead(verdict.status, { "content-type": "application/json", ...verdict.headers });
      response.end(businessErrorBody(verdict));
      return;
    }
    case "cut": {
      entry.servedStatus = 200;
      if (!stream) {
        // 非流式请求没有「帧」可切：发了头就断，等价于 reset。
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        await sleep(0);
        response.socket?.destroy();
        return;
      }
      response.writeHead(200, SSE_HEADERS);
      response.flushHeaders();
      if (verdict.after !== "headers") {
        await writeFlushed(response, firstFrame(route, ordinal));
        if (verdict.after === "visible") {
          await writeFlushed(
            response,
            visibleFrame(route, ordinal, state.canned.visibleText ?? DEFAULT_VISIBLE_TEXT),
          );
        }
      }
      // 让已写的帧先离开进程，再撕掉连接。
      await sleep(5);
      response.socket?.destroy();
      return;
    }
    case "stream_error": {
      entry.servedStatus = 200;
      response.writeHead(200, SSE_HEADERS);
      response.flushHeaders();
      await writeFlushed(response, firstFrame(route, ordinal));
      response.end(streamErrorFrame(route, verdict.code, verdict.message));
      return;
    }
    case "serve": {
      entry.servedStatus = 200;
      const turn = cannedTurn(entry.toolResultCount, state.canned);
      if (!stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(successBody(route, ordinal, turn));
        return;
      }
      response.writeHead(200, SSE_HEADERS);
      response.end(successStream(route, ordinal, turn));
      return;
    }
    default: {
      const never: never = verdict;
      throw new Error(`fake provider: unknown verdict ${JSON.stringify(never)}`);
    }
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  state: ServerState,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const route = routeOf(pathname);
  const rawBody = await readBody(request);
  if (request.method !== "POST" || route === undefined) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `fake provider: no route for ${pathname}` } }));
    return;
  }
  let body: Record<string, unknown> = {};
  try {
    body = asRecord(JSON.parse(rawBody)) ?? {};
  } catch {
    body = {};
  }
  const stream = body.stream === true;
  const toolResultCount = countToolResults(route, body);

  const entry: RequestLedgerEntry = {
    ordinal: state.nextOrdinal++,
    at: Date.now(),
    route,
    stream,
    toolResultCount,
    inFlightAtArrival: state.inFlight,
    verdict: { kind: "serve" },
    closedByClient: false,
  };
  state.requests.push(entry);
  state.inFlight += 1;
  state.inFlightPeak = Math.max(state.inFlightPeak, state.inFlight);

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    state.inFlight -= 1;
    entry.finishedAt = Date.now();
  };
  response.on("finish", finish);
  response.on("close", () => {
    if (!response.writableFinished) entry.closedByClient = true;
    finish();
  });

  let verdict = state.program({
    ordinal: entry.ordinal,
    inFlight: entry.inFlightAtArrival,
    toolResultCount,
    stream,
    route,
  });
  while (verdict.kind === "delay") {
    await sleep(verdict.ms);
    verdict = verdict.next;
  }
  entry.verdict = verdict;
  if (response.destroyed) return;
  await respond(entry, verdict, request, response, state);
}

export async function startFakeProviderServer(options: {
  program: FaultProgram;
  canned?: CannedModelOptions;
}): Promise<FakeProviderServer> {
  const state: ServerState = {
    program: options.program,
    canned: options.canned ?? {},
    requests: [],
    inFlight: 0,
    inFlightPeak: 0,
    nextOrdinal: 1,
  };
  const sockets = new Set<Socket>();

  const server: Server = createServer((request, response) => {
    void handle(request, response, state).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: `fake provider crashed: ${String(error)}` } }));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const baseURL = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    baseURL,
    requests: state.requests,
    get inFlightPeak() {
      return state.inFlightPeak;
    },
    get inFlight() {
      return state.inFlight;
    },
    setProgram(next) {
      state.program = next;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
