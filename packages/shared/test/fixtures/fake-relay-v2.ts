import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import {
  parseWebRemoteControlRelayV2HttpRequest,
  parseWebRemoteControlRelayV2OutgoingMessage,
  WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH,
  type WebRemoteControlRelayV2Device,
  type WebRemoteControlRelayV2Role,
  type WebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2Meta,
  type WebRemoteControlRelayV2ErrorCode,
  type WebRemoteControlRelayV2PairStatus,
} from "@zcode/shared/web-remote-relay";

interface Connection {
  id: string;
  socket: WebSocket;
  userId: string;
  role: WebRemoteControlRelayV2Role;
  deviceSid?: string;
  terminalSid: string;
  meta: WebRemoteControlRelayV2Meta;
}
export interface FakeRelayV2Message {
  connectionId: string;
  userId: string;
  role: WebRemoteControlRelayV2Role;
  deviceSid?: string;
  message: unknown;
}

export type FakeRelayV2HttpAction = { status: number; body?: unknown } | { networkError: true };
export type FakeRelayV2MessageAction =
  | { pairStatus: WebRemoteControlRelayV2PairStatus }
  | { drop: true }
  | { error: WebRemoteControlRelayV2ErrorCode }
  | { disconnect: true };
export interface FakeRelayV2Target {
  connectionId?: string;
  deviceSid?: string;
  role?: WebRemoteControlRelayV2Role;
}
export interface FakeRelayV2Options {
  users: Readonly<Record<string, string>>;
  now?: () => number;
  onHttp?: (call: FakeRelayV2HttpCall) => FakeRelayV2HttpAction | void;
  onMessage?: (message: FakeRelayV2Message) => FakeRelayV2MessageAction | void;
}
export interface FakeRelayV2HttpCall {
  method: string;
  path: string;
  userId?: string;
  body: unknown;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function createFakeRelayV2(options: FakeRelayV2Options) {
  const now = options.now ?? Date.now;
  const devices = new Map<string, { userId: string; view: WebRemoteControlRelayV2Device }>();
  const httpCalls: FakeRelayV2HttpCall[] = [];
  const messages: FakeRelayV2Message[] = [];
  const tokens = new Map<
    string,
    { userId: string; role: WebRemoteControlRelayV2Role; expiresAt: number }
  >();
  const connections = new Set<Connection>();
  const owners = new Map<string, Partial<Record<WebRemoteControlRelayV2Role, Connection>>>();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const send = (connection: Connection, message: WebRemoteControlRelayV2IncomingMessage) => {
    if (connection.socket.readyState === WebSocket.OPEN)
      connection.socket.send(JSON.stringify({ ...message, server_ts: Math.floor(now() / 1000) }));
  };
  const peer = (connection: Connection) =>
    owners.get(connection.deviceSid ?? "")?.[connection.role === "device" ? "terminal" : "device"];
  const view = (device: WebRemoteControlRelayV2Device) => {
    const connection = owners.get(device.device_sid)?.device;
    return { ...device, online: !!connection, meta: connection?.meta ?? {} };
  };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const jwt = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const userId = jwt && Object.hasOwn(options.users, jwt) ? options.users[jwt] : undefined;
    let body: unknown;
    try {
      body = await readBody(request);
    } catch {
      response.destroy();
      return;
    }
    const call = { method: request.method ?? "GET", path, userId, body };
    httpCalls.push(call);
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const reply = (
      status: number,
      data?: unknown,
      code = status === 200 ? 0 : status,
      msg = "",
    ) => {
      response.writeHead(status);
      response.end(
        JSON.stringify({
          code,
          msg,
          ...(data === undefined ? {} : { data }),
        }),
      );
    };
    if (path === "/api/v1/remote/token") response.setHeader("Cache-Control", "no-store");
    const action = options.onHttp?.(call);
    if (action && "networkError" in action) {
      request.socket.destroy();
      return;
    }
    if (action && "status" in action) {
      response.writeHead(action.status);
      response.end(action.body === undefined ? undefined : JSON.stringify(action.body));
      return;
    }
    if (!userId) return reply(401);
    if (path === "/api/v1/remote/token" && request.method === "POST") {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("token", body);
      if (!parsed) return reply(400, undefined, 3001, "parameter error");
      const token = randomBytes(16).toString("base64url");
      tokens.set(token, { userId, role: parsed.role, expiresAt: now() + 60_000 });
      return reply(200, { token, expires_in: 60 });
    }
    if (path === "/api/v1/remote/device" && request.method === "POST") {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("register", body);
      if (!parsed) return reply(400, undefined, 3001, "parameter error");
      const view = {
        device_sid: `d_${randomUUID()}`,
        device_mid: parsed.device_mid,
        created_at: Math.floor(now() / 1000),
        online: false,
        meta: {},
      };
      devices.set(view.device_sid, { userId, view });
      return reply(200, view);
    }
    if (path === "/api/v1/remote/device" && request.method === "GET") {
      return reply(
        200,
        [...devices.values()]
          .filter((device) => device.userId === userId)
          .map((device) => view(device.view)),
      );
    }
    if (path === "/api/v1/remote/device/delete" && request.method === "POST") {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("delete", body);
      if (!parsed) return reply(400, undefined, 3001, "parameter error");
      const device = devices.get(parsed.device_sid);
      if (!device) return reply(200);
      if (device.userId !== userId) return reply(200, undefined, 1006, "no permission");
      if (owners.get(parsed.device_sid)?.device) return reply(400, undefined, 3005, "wrong status");
      devices.delete(parsed.device_sid);
      return reply(200);
    }
    return reply(404);
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const identity = tokens.get(token);
    if (
      url.pathname !== WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH ||
      !identity ||
      identity.expiresAt <= now()
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    tokens.delete(token);
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      const connection: Connection = {
        id: randomUUID(),
        socket: ws,
        ...identity,
        terminalSid: identity.role === "terminal" ? `t_${randomUUID()}` : "",
        meta: {},
      };
      connections.add(connection);
      ws.on("error", () => ws.terminate());
      ws.on("message", (data, isBinary) => {
        let message: unknown;
        try {
          message = JSON.parse(data.toString());
        } catch {
          message = data.toString();
        }
        const record = {
          connectionId: connection.id,
          userId: connection.userId,
          role: connection.role,
          deviceSid: connection.deviceSid,
          message,
        };
        messages.push(record);
        if (ws.readyState !== WebSocket.OPEN) return;
        const parsed = isBinary ? null : parseWebRemoteControlRelayV2OutgoingMessage(message);
        if (!parsed) {
          send(connection, { type: "error", code: "WRONG_PARAM" });
          ws.close();
          return;
        }
        const action = options.onMessage?.(record);
        if (action && "drop" in action) return;
        if (action && "disconnect" in action) {
          ws.close();
          return;
        }
        if (action && "error" in action) {
          send(connection, { type: "error", code: action.error });
          ws.close();
          return;
        }
        const override = action && "pairStatus" in action ? action.pairStatus : undefined;
        if (parsed.type === "auth_init") {
          if (connection.deviceSid) {
            send(connection, { type: "error", code: "WRONG_PARAM" });
            ws.close();
            return;
          }
          const device = devices.get(parsed.device_sid);
          if (!device || device.userId !== connection.userId) {
            send(connection, { type: "error", code: "AUTH_FAILED" });
            ws.close();
            return;
          }
          connection.deviceSid = parsed.device_sid;
          connection.meta = parsed.meta ?? {};
          const roles = owners.get(parsed.device_sid) ?? {};
          const old = roles[connection.role];
          roles[connection.role] = connection;
          if (old) {
            send(old, { type: "error", code: "KICKED" });
            old.socket.close();
          }
          owners.set(parsed.device_sid, roles);
          const other = peer(connection);
          const pair_status = override ?? (other ? "matched" : "waiting");
          if (other) send(other, { type: "pair_status_ack", pair_status, terminal_sid: "" });
          send(connection, {
            type: "auth_ack",
            device_sid: parsed.device_sid,
            terminal_sid: connection.terminalSid,
            pair_status,
          });
        } else if (!connection.deviceSid) {
          send(connection, { type: "error", code: "AUTH_FAILED" });
          ws.close();
        } else if (parsed.type === "pair_status_query") {
          const other = peer(connection);
          send(connection, {
            type: "pair_status_ack",
            pair_status: override ?? (other ? "matched" : "waiting"),
            terminal_sid: other?.terminalSid ?? "",
          });
        } else {
          const other = peer(connection);
          if (other) send(other, { type: "data", payload: parsed.payload });
          else send(connection, { type: "error", code: "INTERNAL" });
        }
      });
      ws.on("close", () => {
        connections.delete(connection);
        const roles = owners.get(connection.deviceSid ?? "");
        // 被替换连接的 close 晚于新认证完成，必须按连接身份释放，不能只按 SID/role 删除。
        if (roles?.[connection.role] !== connection) return;
        delete roles[connection.role];
        const other = peer(connection);
        if (other) {
          send(other, { type: "pair_status_ack", pair_status: "waiting", terminal_sid: "" });
          if (connection.role === "device") {
            send(other, { type: "error", code: "DEVICE_OFFLINE" });
            other.socket.close();
          }
        }
        if (!roles.device && !roles.terminal) owners.delete(connection.deviceSid ?? "");
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay address");
  const select = (target: FakeRelayV2Target) =>
    [...connections].filter(
      (connection) =>
        (!target.connectionId || target.connectionId === connection.id) &&
        (!target.deviceSid || target.deviceSid === connection.deviceSid) &&
        (!target.role || target.role === connection.role),
    );
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}${WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH}`,
    httpCalls,
    messages,
    sendError: (target: FakeRelayV2Target, code: WebRemoteControlRelayV2ErrorCode) => {
      for (const connection of select(target)) send(connection, { type: "error", code });
    },
    disconnect: (target: FakeRelayV2Target) => {
      for (const connection of select(target)) connection.socket.close();
    },
    close: async () => {
      for (const connection of connections) connection.socket.terminate();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
