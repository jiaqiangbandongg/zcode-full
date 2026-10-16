import { WebSocket, type RawData } from "ws";
import { connectViaProtocol } from "@zcode/client";
import {
  Emitter,
  SocketProtocol,
  VSBuffer,
  ChannelServer,
  type IServerChannel,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import {
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  serverRemoteHostCapabilitySchema,
  serverRemoteInfoSchema,
  type ServerConnectOptions,
  type ServerRemoteInfo,
} from "@zcode/shared";

export interface ServerRemoteEndpoints {
  infoUrl: string;
  wsUrl: string;
  hostCapabilityUrl: string;
  hostWsUrl: string;
}

export interface ServerRemoteConnection {
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
  dispose(): void;
}

export interface ServerRemoteConnectionOptions {
  topicResourceChannel?: IServerChannel;
  fetchImpl?: typeof fetch;
  onClose?: (event: { code: number; reason: string }) => void;
}

function appendEndpointPath(basePath: string, endpointPath: string): string {
  const normalizedBase = basePath.replace(/\/+$/g, "");
  return normalizedBase ? `${normalizedBase}${endpointPath}` : endpointPath;
}

function stripWebSocketEndpointPath(pathname: string): string {
  const normalizedPath = pathname.replace(/\/+$/g, "");
  if (normalizedPath.endsWith("/ws/host")) {
    return normalizedPath.slice(0, -"/ws/host".length);
  }
  if (normalizedPath.endsWith("/ws")) {
    return normalizedPath.slice(0, -"/ws".length);
  }
  return normalizedPath;
}

export function resolveServerRemoteEndpoints(serverUrl: string): ServerRemoteEndpoints {
  const trimmedUrl = serverUrl.trim();
  if (!trimmedUrl) {
    throw new Error("Server URL is required");
  }

  const infoUrl = new URL(trimmedUrl);
  const wsUrl = new URL(trimmedUrl);
  const hostCapabilityUrl = new URL(trimmedUrl);
  const hostWsUrl = new URL(trimmedUrl);
  const infoBasePath = stripWebSocketEndpointPath(infoUrl.pathname);
  const wsBasePath = stripWebSocketEndpointPath(wsUrl.pathname);
  const hostCapabilityBasePath = stripWebSocketEndpointPath(hostCapabilityUrl.pathname);
  const hostWsBasePath = stripWebSocketEndpointPath(hostWsUrl.pathname);

  switch (infoUrl.protocol) {
    case "http:":
    case "https:":
      wsUrl.protocol = infoUrl.protocol === "https:" ? "wss:" : "ws:";
      hostWsUrl.protocol = wsUrl.protocol;
      break;
    case "ws:":
    case "wss:":
      infoUrl.protocol = infoUrl.protocol === "wss:" ? "https:" : "http:";
      hostCapabilityUrl.protocol = infoUrl.protocol;
      break;
    default:
      throw new Error(`Unsupported server URL protocol: ${infoUrl.protocol}`);
  }

  infoUrl.pathname = appendEndpointPath(infoBasePath, "/api/server-info");
  wsUrl.pathname = appendEndpointPath(wsBasePath, "/ws");
  hostCapabilityUrl.pathname = appendEndpointPath(
    hostCapabilityBasePath,
    "/api/rpc-host-capability",
  );
  hostWsUrl.pathname = appendEndpointPath(hostWsBasePath, "/ws/host");
  infoUrl.search = "";
  wsUrl.search = "";
  hostCapabilityUrl.search = "";
  hostWsUrl.search = "";
  infoUrl.hash = "";
  wsUrl.hash = "";
  hostCapabilityUrl.hash = "";
  hostWsUrl.hash = "";

  return {
    infoUrl: infoUrl.toString(),
    wsUrl: wsUrl.toString(),
    hostCapabilityUrl: hostCapabilityUrl.toString(),
    hostWsUrl: hostWsUrl.toString(),
  };
}

function authenticatedUrl(url: string, target: ServerConnectOptions): string {
  const token = target.token?.trim();
  if (!token) return url;
  const authenticated = new URL(url);
  authenticated.searchParams.set("token", token);
  return authenticated.toString();
}

function wrapNodeWebSocket(
  ws: WebSocket,
  onClose?: (event: { code: number; reason: string }) => void,
): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onSocketClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  const fireClosed = (code: number, reason: Buffer) => {
    onClose?.({ code, reason: reason.toString("utf8") });
    onSocketClose.fire();
    onEnd.fire();
  };

  ws.on("message", (raw: RawData) => {
    const data = Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw);
    onData.fire(VSBuffer.wrap(new Uint8Array(data)));
  });
  ws.on("close", fireClosed);
  ws.on("error", () => {
    onSocketClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onSocketClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

async function fetchServerInfo(
  infoUrl: string,
  target: ServerConnectOptions,
  fetchImpl: typeof fetch,
): Promise<ServerRemoteInfo> {
  const token = target.token?.trim();
  const response = await fetchImpl(authenticatedUrl(infoUrl, target), {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Server info request failed: ${response.status}`);
  }
  const rawBody = await response.json();
  const parsed = serverRemoteInfoSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new Error("Server info response is invalid");
  }
  return parsed.data;
}

async function fetchHostCapability(
  capabilityUrl: string,
  target: ServerConnectOptions,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(authenticatedUrl(capabilityUrl, target), {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Host capability request failed: ${response.status}`);
  }
  const parsed = serverRemoteHostCapabilitySchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Host capability response is invalid");
  }
  return parsed.data.capability;
}

function connectNodeWebSocket(
  wsUrl: string,
  target: ServerConnectOptions,
  capability: string,
  options: ServerRemoteConnectionOptions,
): Promise<{ socket: WebSocket; services: IServiceAccessor }> {
  return new Promise((resolve, reject) => {
    const token = target.token?.trim();
    const socket = new WebSocket(authenticatedUrl(wsUrl, target), {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability,
      },
    });
    let settled = false;

    socket.once("error", (error) => {
      if (!settled) {
        reject(error);
      }
    });
    socket.once("close", (code, reason) => {
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
    socket.once("open", () => {
      settled = true;
      const rpcSocket = wrapNodeWebSocket(socket, options.onClose);
      const protocol = new SocketProtocol(rpcSocket);
      const reverseServer = options.topicResourceChannel
        ? new ChannelServer(protocol, "desktop-resource")
        : undefined;
      if (reverseServer && options.topicResourceChannel)
        reverseServer.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, options.topicResourceChannel);
      rpcSocket.onClose(() => reverseServer?.dispose());
      resolve({
        socket,
        services: connectViaProtocol(protocol),
      });
    });
  });
}

export async function connectServerRemote(
  target: ServerConnectOptions,
  options: ServerRemoteConnectionOptions = {},
): Promise<ServerRemoteConnection> {
  const endpoints = resolveServerRemoteEndpoints(target.url);
  const serverInfo = await fetchServerInfo(endpoints.infoUrl, target, options.fetchImpl ?? fetch);
  const capability = await fetchHostCapability(
    endpoints.hostCapabilityUrl,
    target,
    options.fetchImpl ?? fetch,
  );
  const { socket, services } = await connectNodeWebSocket(
    endpoints.hostWsUrl,
    target,
    capability,
    options,
  );

  return {
    serverInfo,
    services,
    dispose() {
      socket.close();
    },
  };
}
