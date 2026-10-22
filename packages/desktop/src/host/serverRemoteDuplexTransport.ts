import { Agent, request } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";

export type ServerRemoteDuplexFactory = () => Duplex | Promise<Duplex>;

interface SocketCompatibleDuplex extends Duplex {
  ref(): this;
  unref(): this;
  setKeepAlive(enable?: boolean, initialDelay?: number): this;
  setNoDelay(noDelay?: boolean): this;
  setTimeout(timeout: number, callback?: () => void): this;
}

function asSocketCompatibleDuplex(stream: Duplex): SocketCompatibleDuplex {
  // 原因：ssh2 ClientChannel 与 child stdio 都满足 Duplex，但 ws 在 upgrade 完成时会调用
  // net.Socket 的可选调优方法。隧道已经建立，这些 TCP 调优不属于上层 HTTP/WS 合同，
  // 因而在普通 Duplex 上提供链式 no-op，避免把 transport 具体类型泄漏到握手层。
  const socket = stream as SocketCompatibleDuplex;
  // keep-alive Agent 释放 HTTP socket 时会调用 unref；opaque Duplex 没有事件循环引用语义，
  // 链式 no-op 与上面的 TCP 调优方法相同，只补 Node Agent 所需的结构合同。
  socket.ref ??= () => socket;
  socket.unref ??= () => socket;
  socket.setKeepAlive ??= () => socket;
  socket.setNoDelay ??= () => socket;
  socket.setTimeout ??= (_timeout: number, callback?: () => void) => {
    if (callback) socket.once("timeout", callback);
    return socket;
  };
  return socket;
}

export async function createReusableDuplexHttpAgent(
  createConnection: ServerRemoteDuplexFactory,
): Promise<Agent> {
  const stream = asSocketCompatibleDuplex(await createConnection());
  // Bug 原因：Source 握手的 server-info、capability 和 WebSocket upgrade 过去各启动一条
  // proxy-stdio。Docker/SSH 每条都要创建远端 CLI 进程，冷启动时三次握手会耗尽 10 秒预算。
  // 三个请求严格串行且指向同一 loopback server，可在一次 HTTP keep-alive 连接上完成，
  // 最后由 WebSocket upgrade 接管该 Duplex。
  const agent = new Agent({
    keepAlive: true,
    maxFreeSockets: 1,
    maxSockets: 1,
  });
  let connectionCreated = false;
  agent.createConnection = (() => {
    if (connectionCreated) {
      throw new Error("Reusable Duplex HTTP agent attempted to create a second connection");
    }
    connectionCreated = true;
    return stream;
  }) as Agent["createConnection"];
  return agent;
}

export interface DuplexJsonRequestOptions {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  createConnection: ServerRemoteDuplexFactory;
  agent?: Agent;
}

export async function requestJsonOverDuplex<T>(
  options: DuplexJsonRequestOptions,
): Promise<{ status: number; body: T }> {
  const url = new URL(options.url);
  if (url.protocol !== "http:") {
    throw new Error(`Duplex Server requests require http:, received ${url.protocol}`);
  }
  let agent = options.agent;
  if (!agent) {
    const stream = asSocketCompatibleDuplex(await options.createConnection());
    agent = new Agent({ keepAlive: false });
    agent.createConnection = (() => stream) as Agent["createConnection"];
  }
  return await new Promise((resolve, reject) => {
    const clientRequest = request(
      url,
      {
        agent,
        method: options.method ?? "GET",
        headers: {
          connection: options.agent ? "keep-alive" : "close",
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | Uint8Array | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.once("error", reject);
        response.once("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    clientRequest.once("error", reject);
    if (options.body) clientRequest.write(options.body);
    clientRequest.end();
  });
}

export interface DuplexWebSocketOptions {
  url: string;
  headers?: Record<string, string>;
  createConnection: ServerRemoteDuplexFactory;
  agent?: Agent;
  onSocketCreated?: (socket: WebSocket) => void;
}

export async function connectWebSocketOverDuplex(
  options: DuplexWebSocketOptions,
): Promise<WebSocket> {
  const url = new URL(options.url);
  if (url.protocol !== "ws:") {
    throw new Error(`Duplex Server WebSockets require ws:, received ${url.protocol}`);
  }
  let agent = options.agent;
  if (!agent) {
    const stream = asSocketCompatibleDuplex(await options.createConnection());
    agent = new Agent({ keepAlive: false });
    agent.createConnection = (() => stream) as Agent["createConnection"];
  }
  return await new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, {
      agent,
      headers: options.headers,
    });
    // 原因：隧道 Duplex 可能比普通 TCP 更快交付 upgrade 后首帧。ChannelServer 会在
    // open 回调中同步发送 Initialize；若等 open Promise resolve 后才订阅 message，首帧会丢失，
    // 所有 RPC 永久停在 whenInitialized。必须在等待 open 前建立协议监听。
    options.onSocketCreated?.(webSocket);
    let settled = false;
    webSocket.once("open", () => {
      settled = true;
      resolve(webSocket);
    });
    webSocket.once("error", (error) => {
      if (!settled) reject(error);
    });
    webSocket.once("close", (code, reason) => {
      if (!settled) {
        reject(
          new Error(
            reason.length > 0
              ? `WebSocket closed before ready: ${reason.toString("utf8")}`
              : `WebSocket closed before ready (${code})`,
          ),
        );
      }
    });
  });
}
