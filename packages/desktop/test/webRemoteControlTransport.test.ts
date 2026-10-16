import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  encodeWebRemoteControlRpcTransportMessage,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import {
  WebRemoteControlDeviceTransport,
  type WebRemoteControlDeviceTransportState,
} from "../src/main/webRemoteControlTransport.js";

const servers: WebSocketServer[] = [];

// 相关测试会与其他单测并发启动多个 WebSocket/SQLite worker；2 秒阈值在 pre-push
// 的高负载调度下会把正常的协议回调延迟误判为失败，等待上限只影响测试收敛时间。
function waitUntil(assertion: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (assertion()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("Timed out waiting for assertion"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createRelayDataJsonWithExactBytes(targetBytes: number): string {
  const multibytePrefix = "中🙂";
  const createJson = (error: string) =>
    JSON.stringify({
      type: "data",
      payload: {
        zcode_type: "app-error",
        reason: "unexpected-error",
        error,
      },
    });
  const empty = createJson(multibytePrefix);
  const paddingBytes = targetBytes - Buffer.byteLength(empty, "utf8");
  if (paddingBytes < 0) throw new Error("target relay frame is smaller than its fixed envelope");
  const result = createJson(`${multibytePrefix}${"x".repeat(paddingBytes)}`);
  if (Buffer.byteLength(result, "utf8") !== targetBytes) {
    throw new Error("failed to construct exact relay frame bytes");
  }
  return result;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function createRelayServer(
  onMessage: (context: { message: any; socket: import("ws").WebSocket; messages: any[] }) => void,
  options?: { perMessageDeflate?: boolean },
) {
  const server = new WebSocketServer({
    port: 0,
    perMessageDeflate: options?.perMessageDeflate ?? false,
  });
  servers.push(server);
  const messages: any[] = [];
  const rawMessages: string[] = [];
  const clientCompressedFrames: boolean[] = [];
  let deviceHeader: string | string[] | undefined;
  let requestUrl: string | undefined;
  let requestExtensions: string | string[] | undefined;
  let connectionCount = 0;

  let rawBuffer = Buffer.alloc(0);
  function collectClientFrameCompression(chunk: Buffer): void {
    rawBuffer = Buffer.concat([rawBuffer, chunk]);
    while (rawBuffer.length >= 2) {
      const firstByte = rawBuffer[0];
      const secondByte = rawBuffer[1];
      let offset = 2;
      let payloadLength = secondByte & 0x7f;
      if (payloadLength === 126) {
        if (rawBuffer.length < offset + 2) {
          return;
        }
        payloadLength = rawBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (rawBuffer.length < offset + 8) {
          return;
        }
        const longLength = rawBuffer.readBigUInt64BE(offset);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("WebSocket frame too large for test parser");
        }
        payloadLength = Number(longLength);
        offset += 8;
      }
      const masked = (secondByte & 0x80) !== 0;
      if (masked) {
        offset += 4;
      }
      const frameLength = offset + payloadLength;
      if (rawBuffer.length < frameLength) {
        return;
      }
      clientCompressedFrames.push((firstByte & 0x40) !== 0);
      rawBuffer = rawBuffer.subarray(frameLength);
    }
  }

  server.on("connection", (socket, request) => {
    connectionCount += 1;
    deviceHeader = request.headers["x-device-id"];
    requestUrl = request.url;
    requestExtensions = request.headers["sec-websocket-extensions"];
    request.socket.on("data", collectClientFrameCompression);
    socket.on("message", (raw) => {
      rawMessages.push(raw.toString());
      const message = JSON.parse(raw.toString());
      messages.push(message);
      onMessage({ message, socket, messages });
    });
  });

  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    messages,
    rawMessages,
    url: `ws://127.0.0.1:${address.port}`,
    getDeviceHeader: () => deviceHeader,
    getRequestUrl: () => requestUrl,
    getRequestExtensions: () => requestExtensions,
    getClientCompressedFrames: () => [...clientCompressedFrames],
    getConnectionCount: () => connectionCount,
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("WebRemoteControlDeviceTransport", () => {
  it("uses the measured final JSON verbatim for initial send and replay", async () => {
    const states: WebRemoteControlDeviceTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
    });
    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: (state) => states.push(state),
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    try {
      transport.start();
      await waitUntil(() => states.includes("paired"));
      const [frame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
        bridgeSessionId: "bridge-1",
        firstPhysicalSeq: 1,
        messageSeq: 1,
      });
      const measuredBytes = transport.measurePayloadBytes(frame);

      expect(transport.sendPayloadResult(frame)).toMatchObject({
        kind: "sent",
        bytes: measuredBytes,
      });
      expect(transport.sendPayloadResult(frame)).toMatchObject({
        kind: "sent",
        bytes: measuredBytes,
      });
      await waitUntil(
        () => relay.messages.filter((message) => message.type === "data").length === 2,
      );

      const dataJson = relay.rawMessages.filter(
        (raw) => (JSON.parse(raw) as { type?: string }).type === "data",
      );
      expect(dataJson).toHaveLength(2);
      expect(dataJson[1]).toBe(dataJson[0]);
      expect(Buffer.byteLength(dataJson[0]!, "utf8")).toBe(measuredBytes);
    } finally {
      transport.dispose();
    }
  });

  it("accepts exactly 1MiB inbound JSON and faults 1MiB+1 before app routing", async () => {
    const payloads: WebRemoteControlAppPayload[] = [];
    const rawFaults: string[] = [];
    const exact = createRelayDataJsonWithExactBytes(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
    );
    const oversize = createRelayDataJsonWithExactBytes(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 1,
    );
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
        socket.send(exact);
        socket.send(oversize);
      }
    });
    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: (payload) => payloads.push(payload),
      onRawTransportFault: (reasonCode) => rawFaults.push(reasonCode),
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    try {
      transport.start();
      await waitUntil(() => payloads.length === 1 && rawFaults.length === 1, 5_000);

      expect(payloads[0]).toMatchObject({
        zcode_type: "app-error",
        reason: "unexpected-error",
      });
      expect(rawFaults).toEqual(["remote.rpcFrame.envelopeTooLarge"]);
    } finally {
      transport.dispose();
    }
  });

  it("distinguishes temporary unavailability from permanent envelope oversize", () => {
    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: "ws://127.0.0.1:1/ws",
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    expect(
      transport.sendPayloadResult({
        zcode_type: "app-error",
        reason: "unexpected-error",
        error: "bounded",
      }),
    ).toEqual({ kind: "unavailable" });
    expect(
      transport.sendPayloadResult({
        zcode_type: "app-error",
        reason: "unexpected-error",
        error: "x".repeat(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes),
      }),
    ).toMatchObject({ kind: "oversize" });
  });

  it("does not write relay message trace in local development runtime", async () => {
    const logger = createLogger();
    const relayMessageLogger = { info: vi.fn() };
    const states: WebRemoteControlDeviceTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 20,
      logger,
      relayMessageLogger,
      onRegisteredAuth: () => {},
      onStateChange: (state) => states.push(state),
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    try {
      transport.start();
      await waitUntil(() => states.includes("paired"));

      expect(relayMessageLogger.info).not.toHaveBeenCalled();
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
        "[web-remote-control][relay-message]",
      );
    } finally {
      transport.dispose();
    }
  });

  it("negotiates permessage-deflate with relay and sends compressed data frames", async () => {
    const logger = createLogger();
    const states: WebRemoteControlDeviceTransportState[] = [];
    const relay = await createRelayServer(
      ({ message, socket }) => {
        if (message.type === "auth_init") {
          socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
        }
        if (message.type === "auth_response") {
          socket.send(
            JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
          );
        }
      },
      { perMessageDeflate: true },
    );

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 20,
      logger,
      onRegisteredAuth: () => {},
      onStateChange: (state) => states.push(state),
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => relay.messages.some((message) => message.type === "auth_response"));
    await waitUntil(() => states.includes("paired"));

    transport.sendPayload({
      zcode_type: "workspace-list-request",
      requestId: "req-compressed",
      padding: "x".repeat(4096),
    } as WebRemoteControlAppPayload);
    await waitUntil(() => relay.messages.some((message) => message.type === "data"));

    expect(String(relay.getRequestExtensions())).toContain("permessage-deflate");
    expect(logger.info).toHaveBeenCalledWith(
      "[web-remote-control] external relay negotiated extensions",
      expect.objectContaining({ perMessageDeflate: true }),
    );
    expect(relay.getClientCompressedFrames()).toContain(true);
    transport.dispose();
  });

  it("registers without persisted auth and authenticates after register ack", async () => {
    const states: WebRemoteControlDeviceTransportState[] = [];
    const registered: { deviceSid: string; passHash: string }[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "device_register_init") {
        socket.send(JSON.stringify({ type: "device_register_ack", device_sid: "sid-1" }));
      }
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "waiting" }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "register", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof-1",
      },
      logger: createLogger(),
      onRegisteredAuth: (auth) => registered.push(auth),
      onStateChange: (state) => states.push(state),
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => states.includes("waiting_terminal"));

    expect(relay.getDeviceHeader()).toBe("mid-1");
    expect(relay.getRequestUrl()).toBe("/?mid=mid-1");
    expect(relay.messages.map((message) => message.type)).toEqual([
      "device_register_init",
      "auth_init",
      "auth_response",
    ]);
    expect(registered).toEqual([{ deviceSid: "sid-1", passHash: "hash-1" }]);
    transport.dispose();
  });

  it("uses persisted auth directly and heartbeats after pairing", async () => {
    const states: WebRemoteControlDeviceTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: (_passHash, nonce, role, deviceSid) =>
          `${nonce}:${role}:${deviceSid}:proof`,
      },
      heartbeatIntervalMs: 20,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: (state) => states.push(state),
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    // Bugfix: 全量 pre-push 并发运行时，WebSocket message 回调和 setInterval 可能被同进程测试挤压。
    // 心跳是 paired 之后的真实 timer 行为，先等协议完成配对，避免把正常调度延迟误判为没有发心跳。
    await waitUntil(() => states.includes("paired"));
    await waitUntil(() => relay.messages.some((message) => message.type === "pair_status_query"));

    expect(relay.messages[0]).toMatchObject({
      type: "auth_init",
      role: "device",
      device_sid: "sid-1",
    });
    expect(relay.messages.find((message) => message.type === "auth_response")).toMatchObject({
      proof: "nonce-1:device:sid-1:proof",
    });
    expect(states).toContain("paired");
    transport.dispose();
  });

  it("keeps waiting_terminal sessions alive with pair status heartbeats", async () => {
    const states: WebRemoteControlDeviceTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "waiting" }),
        );
      }
      if (message.type === "pair_status_query") {
        socket.send(
          JSON.stringify({ type: "pair_status_ack", device_sid: "sid-1", pair_status: "waiting" }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: (_passHash, nonce, role, deviceSid) =>
          `${nonce}:${role}:${deviceSid}:proof`,
      },
      heartbeatIntervalMs: 100,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: (state) => states.push(state),
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => states.includes("waiting_terminal"));
    await waitUntil(() => relay.messages.some((message) => message.type === "pair_status_query"));

    expect(relay.messages.find((message) => message.type === "pair_status_query")).toMatchObject({
      type: "pair_status_query",
      device_sid: "sid-1",
    });
    transport.dispose();
  });

  it("uses the ACK deadline independently from the next jittered heartbeat", async () => {
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 5_000,
      heartbeatJitterMs: 0,
      heartbeatAckTimeoutMs: 50,
      reconnectJitterMs: 0,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    try {
      transport.start();
      await waitUntil(() => relay.getConnectionCount() > 1, 5_000);
    } finally {
      transport.dispose();
    }
  });

  it("enters connecting before closing the stale socket during jittered recovery", async () => {
    const stateHistory: WebRemoteControlDeviceTransportState[] = [];
    let paired = false;
    let postPairConnecting = false;
    let firstSocketClosedAt = 0;
    let firstRelaySocket: import("ws").WebSocket | undefined;
    let staleAckInjected = false;
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const originalClose = WebSocket.prototype.close;
    const closeSpy = vi.spyOn(WebSocket.prototype, "close").mockImplementation(function (this) {
      if (!staleAckInjected && firstRelaySocket) {
        staleAckInjected = true;
        firstRelaySocket.send(
          JSON.stringify({ type: "pair_status_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
      return originalClose.call(this);
    });
    const relay = await createRelayServer(({ message, socket }) => {
      firstRelaySocket ??= socket;
      if (!firstSocketClosedAt) {
        socket.once("close", () => {
          firstSocketClosedAt = Date.now();
        });
      }
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 5_000,
      heartbeatJitterMs: 0,
      heartbeatAckTimeoutMs: 50,
      reconnectJitterMs: 250,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: (state) => {
        stateHistory.push(state);
        if (state === "paired") {
          paired = true;
        }
        if (paired && state === "connecting") {
          postPairConnecting = true;
        }
      },
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    try {
      transport.start();
      await waitUntil(() => stateHistory.includes("paired"));
      await waitUntil(() => firstSocketClosedAt > 0, 5_000);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(postPairConnecting).toBe(true);
      expect(staleAckInjected).toBe(true);
      expect(stateHistory.at(-1)).toBe("connecting");
    } finally {
      transport.dispose();
      closeSpy.mockRestore();
      random.mockRestore();
    }
  });

  it("pauses business payloads after a stale waiting heartbeat once paired", async () => {
    let heartbeatCount = 0;
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
      if (message.type === "pair_status_query") {
        heartbeatCount += 1;
        // First heartbeat returns "waiting" (stale), second returns "matched" (recovered).
        // This avoids triggering reconnectBeforePairing, which would close the socket
        // before sendPayload can send on it.
        socket.send(
          JSON.stringify({
            type: "pair_status_ack",
            device_sid: "sid-1",
            pair_status: heartbeatCount === 1 ? "waiting" : "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 100,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => heartbeatCount >= 1, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sentWhileSuspect = transport.sendPayload({
      zcode_type: "workspace-list-response",
      requestId: "req-1",
      success: true,
      result: {
        workspaces: [],
        activeWorkspaceKey: null,
        activeTaskId: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sentWhileSuspect).toBe(false);
    expect(relay.messages.some((message) => message.type === "data")).toBe(false);

    await waitUntil(() => heartbeatCount >= 2, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sentAfterMatched = transport.sendPayload({
      zcode_type: "workspace-list-response",
      requestId: "req-2",
      success: true,
      result: {
        workspaces: [],
        activeWorkspaceKey: null,
        activeTaskId: null,
      },
    });
    await waitUntil(() => relay.messages.some((message) => message.type === "data"));

    expect(sentAfterMatched).toBe(true);
    expect(relay.messages.find((message) => message.type === "data")).toMatchObject({
      payload: { zcode_type: "workspace-list-response", requestId: "req-2" },
    });
    transport.dispose();
  });

  it("notifies send readiness when a stale waiting heartbeat recovers to matched", async () => {
    let heartbeatCount = 0;
    const sendReady = vi.fn();
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
      if (message.type === "pair_status_query") {
        heartbeatCount += 1;
        socket.send(
          JSON.stringify({
            type: "pair_status_ack",
            device_sid: "sid-1",
            pair_status: heartbeatCount === 1 ? "waiting" : "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 100,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: () => {},
      onError: () => {},
      onSendReady: sendReady,
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    // Bugfix: 服务端收到第 2 次 heartbeat 不代表客户端已经处理 matched ACK。
    // 这里直接等待 onSendReady，避免全量并发测试时断言抢在 WebSocket message 回调前执行。
    await waitUntil(() => sendReady.mock.calls.length === 1, 5_000);

    expect(sendReady).toHaveBeenCalledOnce();
    expect(sendReady).toHaveBeenCalledWith({ kind: "same-socket" });
    transport.dispose();
  });

  it("keeps the desktop socket during a waiting window longer than one production heartbeat", async () => {
    let heartbeatCount = 0;
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
      if (message.type === "pair_status_query") {
        heartbeatCount += 1;
        if (heartbeatCount === 1) {
          socket.send(
            JSON.stringify({
              type: "pair_status_ack",
              device_sid: "sid-1",
              pair_status: "waiting",
            }),
          );
        }
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 200,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => heartbeatCount >= 1, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sent = transport.sendPayload({
      zcode_type: "workspace-list-response",
      requestId: "req-waiting",
      success: true,
      result: {
        workspaces: [],
        activeWorkspaceKey: null,
        activeTaskId: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10_500));

    expect(sent).toBe(false);
    expect(relay.getConnectionCount()).toBe(1);
    expect(
      relay.messages.some(
        (message) =>
          message.type === "data" &&
          typeof message.payload === "object" &&
          message.payload &&
          "requestId" in message.payload &&
          message.payload.requestId === "req-waiting",
      ),
    ).toBe(false);
    transport.dispose();
  });

  it("reconnects when paired heartbeat stays waiting", async () => {
    const sendReady = vi.fn();
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
      if (message.type === "pair_status_query") {
        socket.send(
          JSON.stringify({ type: "pair_status_ack", device_sid: "sid-1", pair_status: "waiting" }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 20,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: () => {},
      onError: () => {},
      onSendReady: sendReady,
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => relay.messages.some((message) => message.type === "pair_status_query"));
    await waitUntil(() => relay.getConnectionCount() > 1, 5_000);
    await waitUntil(() => sendReady.mock.calls.length === 1, 5_000);

    expect(sendReady).toHaveBeenCalledWith({ kind: "reconnected-socket" });

    transport.dispose();
  });

  it("reuses registered device auth instead of registering again after reconnect", async () => {
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "device_register_init") {
        socket.send(JSON.stringify({ type: "device_register_ack", device_sid: "sid-registered" }));
      }
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-registered",
            pair_status: "matched",
          }),
        );
      }
      if (message.type === "pair_status_query") {
        socket.send(
          JSON.stringify({
            type: "pair_status_ack",
            device_sid: "sid-registered",
            pair_status: "waiting",
          }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "register", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 20,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => relay.getConnectionCount() > 1, 5_000);
    await waitUntil(
      () => relay.messages.filter((message) => message.type === "auth_init").length >= 2,
      5_000,
    );
    // Bugfix: 全量 pre-push 并发跑测试时，第二次 auth_init 到 auth_response 中间存在异步间隙。
    // 这里等待第二次响应完成后再断言，避免把正常的中间态误判为认证复用失败。
    await waitUntil(
      () => relay.messages.filter((message) => message.type === "auth_response").length >= 2,
      5_000,
    );

    expect(
      relay.messages.filter((message) => message.type === "device_register_init"),
    ).toHaveLength(1);
    expect(relay.messages.filter((message) => message.type === "auth_init")).toHaveLength(2);
    expect(relay.messages.at(-1)).toMatchObject({
      type: "auth_response",
      device_sid: "sid-registered",
    });
    transport.dispose();
  });

  it("clears invalid persisted auth and retries registration once", async () => {
    const invalidations: string[] = [];
    const relay = await createRelayServer(({ message, socket, messages }) => {
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({ type: "error", code: "AUTH_FAILED", message: "bad persisted auth" }),
        );
        socket.close();
      }
      if (messages.filter((item) => item.type === "device_register_init").length === 1) {
        socket.send(JSON.stringify({ type: "device_register_ack", device_sid: "sid-new" }));
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-old", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      reconnectDelayMs: 0,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {
        invalidations.push("cleared");
      },
    });

    transport.start();
    await waitUntil(() =>
      relay.messages.some((message) => message.type === "device_register_init"),
    );

    expect(invalidations).toEqual(["cleared"]);
    transport.dispose();
  });

  it("reconnects after a relay internal error", async () => {
    const errors: string[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "error", code: "INTERNAL", message: "relay bounced" }));
        socket.close();
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      reconnectDelayMs: 0,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: () => {},
      onError: (error) => errors.push(error.message),
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => relay.getConnectionCount() > 1);

    expect(errors).toContain("relay bounced");
    transport.dispose();
  });

  it("keeps the device socket open when paired data forwarding reports no pair", async () => {
    const errors: string[] = [];
    const states: WebRemoteControlDeviceTransportState[] = [];
    let pairStatus: "matched" | "waiting" = "matched";
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
      if (message.type === "data") {
        pairStatus = "waiting";
        socket.send(JSON.stringify({ type: "error", code: "INTERNAL", message: "no such pair" }));
      }
      if (message.type === "pair_status_query") {
        socket.send(
          JSON.stringify({ type: "pair_status_ack", device_sid: "sid-1", pair_status: pairStatus }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 20,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: (state) => states.push(state),
      onPayload: () => {},
      onError: (error) => errors.push(error.message),
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => states.includes("paired"));

    // 修复原因：先到的心跳若直接回复 waiting，会在 data 转发前暂停发送，
    // 导致用例未进入待验证的 no pair 分支；只有转发失败后才切换配对状态。
    await waitUntil(() => relay.messages.some((message) => message.type === "pair_status_query"));

    const sent = transport.sendPayload({
      zcode_type: "workspace-list-response",
      requestId: "req-1",
      success: true,
      result: {
        workspaces: [],
        activeWorkspaceKey: null,
        activeTaskId: null,
      },
    });

    await waitUntil(() => states.includes("waiting_terminal"));
    expect(sent).toBe(true);
    expect(errors).toEqual(["no such pair"]);
    expect(relay.getConnectionCount()).toBe(1);
    transport.dispose();
  });

  it("keeps the device socket open for paired WRONG_PARAM relay errors", async () => {
    const errors: string[] = [];
    const states: WebRemoteControlDeviceTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
      if (message.type === "pair_status_query") {
        socket.send(JSON.stringify({ type: "error", code: "WRONG_PARAM", message: "bad request" }));
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 20,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: (state) => states.push(state),
      onPayload: () => {},
      onError: (error) => errors.push(error.message),
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => states.includes("paired"));
    await waitUntil(() => errors.includes("bad request"));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(states).not.toContain("error");
    expect(relay.getConnectionCount()).toBe(1);
    transport.dispose();
  });

  it("treats relay WRONG_PARAM as a terminal protocol error", async () => {
    const errors: string[] = [];
    const states: WebRemoteControlDeviceTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "error", code: "WRONG_PARAM", message: "bad request" }));
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      reconnectDelayMs: 0,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: (state) => states.push(state),
      onPayload: () => {},
      onError: (error) => errors.push(error.message),
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => states.includes("error"));

    expect(errors).toEqual(["bad request"]);
    expect(relay.getConnectionCount()).toBe(1);
    transport.dispose();
  });

  it("recovers desktop device transport from relay KICKED without entering a terminal state", async () => {
    const states: WebRemoteControlDeviceTransportState[] = [];
    let authInitCount = 0;
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        authInitCount += 1;
        if (authInitCount === 1) {
          socket.send(
            JSON.stringify({
              type: "error",
              code: "KICKED",
              message: "Another mobile controller replaced this one.",
            }),
          );
          return;
        }
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "waiting" }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      reconnectDelayMs: 0,
      logger: createLogger(),
      onRegisteredAuth: () => {},
      onStateChange: (state) => states.push(state),
      onPayload: () => {},
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    try {
      transport.start();
      await waitUntil(() => states.includes("waiting_terminal"));

      expect(states).not.toContain("kicked");
      expect(states).not.toContain("error");
      expect(relay.getConnectionCount()).toBeGreaterThanOrEqual(2);
    } finally {
      transport.dispose();
    }
  });

  it("forwards only parsed data payloads after paired and redacts invalid payload logs", async () => {
    const payloads: WebRemoteControlAppPayload[] = [];
    const logger = createLogger();
    const [validFrame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
      if (message.type === "pair_status_query") {
        socket.send(
          JSON.stringify({
            type: "data",
            payload: { ...validFrame, seq: -1, raw: "secret" },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "data",
            payload: validFrame,
          }),
        );
      }
    });

    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.url,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "darwin", version: "1.0.0", name: "Mac" },
      authProvider: {
        createPassword: () => "password",
        createPassHash: () => "hash-1",
        calculateProof: () => "proof",
      },
      heartbeatIntervalMs: 20,
      logger,
      onRegisteredAuth: () => {},
      onStateChange: () => {},
      onPayload: (payload) => payloads.push(payload),
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });

    transport.start();
    await waitUntil(() => payloads.length === 1);

    expect(payloads[0]).toMatchObject({ zcode_type: "rpc-frame", seq: 1 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
    transport.dispose();
  });
});
