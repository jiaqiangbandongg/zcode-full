import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { zcodeSessionStateSnapshotSchema } from "@zcode/shared";
import {
  DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS,
  ZCodeProtocolClient,
} from "../src/zcode-agent/zcodeProtocolClient.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "../src/zcode-agent/zcodeProtocolTransport.js";

const protocolModelProperties = {
  inputFormat: {
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
};

class FakeZCodeTransport implements ZCodeProtocolTransport {
  readonly kind = "memory" as const;
  readonly sent: ZCodeProtocolMessage[] = [];

  private readonly messageEmitter = new Emitter<ZCodeProtocolMessage>();
  private readonly closeEmitter = new Emitter<ZCodeProtocolTransportClosedEvent>();

  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;

  async send(message: ZCodeProtocolMessage): Promise<void> {
    this.sent.push(message);
  }

  receive(message: ZCodeProtocolMessage): void {
    this.messageEmitter.fire(message);
  }

  dispose(): void {
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

const snapshot = {
  protocol: { name: "ZCode Protocol", version: 1 },
  session: {
    sessionId: "sess_1",
    workspace: {
      workspacePath: "/workspace/app",
      workspaceKey: "/workspace/app",
    },
    sessionKind: "interactive",
    title: "Test",
    mode: "build",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  },
  settings: {
    model: {
      current: { providerId: "glm", modelId: "glm-4.6" },
      available: [
        {
          ref: { providerId: "glm", modelId: "glm-4.6" },
          label: "GLM 4.6",
          properties: protocolModelProperties,
        },
      ],
    },
    thoughtLevel: { enabled: true, available: [] },
    mode: { current: "build" },
  },
  projection: {
    sessionId: "sess_1",
    status: "idle",
    mode: "build",
    turnCount: 0,
    totalTokenCount: 0,
    contextUsed: 0,
    contextWindow: 128000,
    pendingPermissions: [],
    activeToolCalls: [],
    backgroundJobs: [],
  },
  runtime: { eventSeq: 0, stateRevision: 1, pendingRequestIds: [] },
  messages: [],
};

describe("ZCodeProtocolClient", () => {
  it("dispose 批量拒绝不会把 fire-and-forget 请求的外层 Promise 判为 unhandled", async () => {
    // CR 复现：request() 返回的外层 Promise 才是 unhandledRejection 判定对象；
    // 调用方在启动后、挂靠 .catch 前 dispose，内外两层都必须已有兜底 handler。
    const transport = new FakeZCodeTransport();
    const client = new ZCodeProtocolClient(transport);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // fire-and-forget：故意不挂任何 handler，模拟评审指出的调用方形态。
      void client.request("session/read", { sessionId: "sess_1" }, undefined, {
        timeoutMs: 5_000,
      });
      client.dispose();
      // 冲刷微任务与 macrotask，给 V8 的 unhandled 检测留出判定窗口。
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("观测超时不触发进程 watchdog，业务请求仍可完成", async () => {
    vi.useFakeTimers();
    const transport = new FakeZCodeTransport();
    const client = new ZCodeProtocolClient(transport);
    const timedOut = vi.fn(() => client.dispose());
    client.onRequestTimeout(timedOut);
    try {
      const observation = client
        .request("process/childProcesses", {}, undefined, {
          timeoutMs: 800,
          lifecycle: "observation",
        })
        .catch((error: unknown) => error);
      const business = client.request("session/read", { sessionId: "sess_1" });
      await vi.advanceTimersByTimeAsync(800);
      expect(await observation).toMatchObject({ name: "ZCodeProtocolRequestTimeoutError" });
      expect(timedOut).not.toHaveBeenCalled();
      transport.receive({ id: 2, result: snapshot });
      await expect(business).resolves.toEqual(snapshot);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it("观测不阻止业务 idle，成功和取消也不续期 idle", async () => {
    const transport = new FakeZCodeTransport();
    const client = new ZCodeProtocolClient(transport);
    const drained = vi.fn();
    client.onPendingRequestsDrained(drained);
    const controller = new AbortController();
    try {
      const observation = client
        .request("process/childProcesses", {}, undefined, {
          lifecycle: "observation",
          signal: controller.signal,
        })
        .catch((error: unknown) => error);
      const business = client.request("session/read", { sessionId: "sess_1" });
      transport.receive({ id: 2, result: snapshot });
      await business;
      expect(client.pendingOperationRequestCount).toBe(0);
      expect(drained).toHaveBeenCalledTimes(1);
      controller.abort();
      await observation;
      const second = client.request("process/childProcesses", {}, undefined, {
        lifecycle: "observation",
      });
      transport.receive({ id: 3, result: { processes: [] } });
      await second;
      expect(drained).toHaveBeenCalledTimes(1);
    } finally {
      client.dispose();
    }
  });

  it("迁移期间不发送业务请求，ready 后才开始普通请求 timeout", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeZCodeTransport();
      const client = new ZCodeProtocolClient(transport, {
        requireStorageStartup: true,
        requestTimeoutMs: 10,
      });
      const notification = (phase: string, sequence: number) =>
        transport.receive({
          method: "startup/storageState",
          params: {
            schemaVersion: 1,
            attemptId: "a",
            databaseId: "db",
            databaseKind: "session",
            phase,
            sequence,
            elapsedMs: 0,
          },
        });
      notification("checking", 1);
      const waiting = client.request("session/read", { sessionId: "s" });
      notification("migrating", 2);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(transport.sent).toEqual([]);
      expect(client.pendingRequestCount).toBe(0);
      notification("ready", 3);
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.sent).toMatchObject([{ id: 1, method: "session/read" }]);
      transport.receive({ id: 1, result: "done" });
      await expect(waiting).resolves.toBe("done");
      const ordinary = expect(client.request("session/read", { sessionId: "s" })).rejects.toThrow(
        /timed out/,
      );
      await vi.advanceTimersByTimeAsync(10);
      await ordinary;
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("自定义命令主动声明启动状态后，已经发出的首个握手请求也不会误触普通 watchdog", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeZCodeTransport();
      const client = new ZCodeProtocolClient(transport, { requestTimeoutMs: 10 });
      const result = client.request("session/read", { sessionId: "s" });
      const packet = {
        schemaVersion: 1,
        attemptId: "a",
        databaseId: "db",
        databaseKind: "session",
        elapsedMs: 0,
      };
      transport.receive({
        method: "startup/storageState",
        params: { ...packet, phase: "checking", sequence: 1 },
      });
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(client.pendingRequestCount).toBe(1);
      transport.receive({
        method: "startup/storageState",
        params: { ...packet, phase: "ready", sequence: 2 },
      });
      transport.receive({ id: 1, result: "done" });
      await expect(result).resolves.toBe("done");
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches requests with responses and validates result schemas", async () => {
    const transport = new FakeZCodeTransport();
    const client = new ZCodeProtocolClient(transport);

    const request = client.request(
      "session/read",
      { sessionId: "sess_1" },
      zcodeSessionStateSnapshotSchema,
    );

    expect(transport.sent).toMatchObject([
      { id: 1, method: "session/read", params: { sessionId: "sess_1" } },
    ]);
    transport.receive({ id: 1, result: snapshot });

    await expect(request).resolves.toMatchObject({
      session: { sessionId: "sess_1" },
      settings: { model: { current: { providerId: "glm" } } },
    });
  });

  it("emits notifications without requiring a jsonrpc field", () => {
    const transport = new FakeZCodeTransport();
    const client = new ZCodeProtocolClient(transport);
    const notifications: unknown[] = [];
    client.onNotification((event) => notifications.push(event));

    transport.receive({ method: "state.updated", params: { type: "state.updated" } });

    expect(notifications).toMatchObject([
      { method: "state.updated", params: { type: "state.updated" } },
    ]);
  });

  it("serializes protocol traces on the request envelope", async () => {
    const transport = new FakeZCodeTransport();
    const client = new ZCodeProtocolClient(transport);

    const request = client.request(
      "session/create",
      { workspace: { workspacePath: "/workspace/app", workspaceKey: "/workspace/app" } },
      zcodeSessionStateSnapshotSchema,
      { trace: { traceId: "trace_from_app" } },
    );

    expect(transport.sent[0]).toMatchObject({
      id: 1,
      method: "session/create",
      params: { workspace: { workspacePath: "/workspace/app" } },
      trace: { traceId: "trace_from_app" },
    });
    transport.receive({ id: 1, result: snapshot });

    await expect(request).resolves.toMatchObject({
      session: { sessionId: "sess_1" },
    });
  });

  it("uses a per-request timeout override when provided", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeZCodeTransport();
      const client = new ZCodeProtocolClient(transport, { requestTimeoutMs: 10 });
      const timeouts: unknown[] = [];
      client.onRequestTimeout((event) => timeouts.push(event));

      let settled = false;
      const request = client
        .request("session/read", { sessionId: "sess_1" }, undefined, { timeoutMs: 50 })
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error) => ({ error, status: "rejected" as const }),
        )
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);
      expect(timeouts).toEqual([]);

      await vi.advanceTimersByTimeAsync(40);
      await expect(request).resolves.toMatchObject({
        error: {
          method: "session/read",
          timeoutMs: 50,
        },
        status: "rejected",
      });
      expect(timeouts).toMatchObject([
        {
          method: "session/read",
          timeoutMs: 50,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a three minute default request timeout", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeZCodeTransport();
      const client = new ZCodeProtocolClient(transport);
      const timeouts: unknown[] = [];
      client.onRequestTimeout((event) => timeouts.push(event));

      let settled = false;
      const request = client
        .request("session/read", { sessionId: "sess_1" })
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error) => ({ error, status: "rejected" as const }),
        )
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      expect(timeouts).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await expect(request).resolves.toMatchObject({
        error: {
          method: "session/read",
          timeoutMs: DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS,
        },
        status: "rejected",
      });
      expect(timeouts).toMatchObject([
        {
          method: "session/read",
          timeoutMs: DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending request with an AbortSignal", async () => {
    const transport = new FakeZCodeTransport();
    const client = new ZCodeProtocolClient(transport);
    const controller = new AbortController();

    const request = client.request("workspace/generateText", {}, undefined, {
      signal: controller.signal,
    });

    expect(transport.sent).toHaveLength(1);
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });

    // 迟到的服务端响应不能重新结算已经取消的请求。
    transport.receive({ id: 1, result: { ignored: true } });
  });

  it("does not send a request when its AbortSignal is already aborted", async () => {
    const transport = new FakeZCodeTransport();
    const client = new ZCodeProtocolClient(transport);
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    const request = client.request("workspace/generateText", {}, undefined, {
      signal: controller.signal,
    });

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.sent).toEqual([]);
  });

  it("supports server-to-client requests and responses", async () => {
    const transport = new FakeZCodeTransport();
    const client = new ZCodeProtocolClient(transport);
    client.onRequest((request) => {
      void client.respond(request.id, { decision: "allow" });
    });

    transport.receive({
      id: "permission-1",
      method: "interaction/requestPermission",
      params: { requestId: "perm_1" },
    });

    expect(transport.sent).toEqual([{ id: "permission-1", result: { decision: "allow" } }]);
  });

  // Bug 根因：wiki stop 的取消 RPC 超时会触发 processManager 回收 client/进程，但进程异步退出，
  // client.onClose 尚未触发时 activeClientsByWorkspaceKey 仍指向已 disposed 的 client。
  // getClient 必须能在复用前通过 isDisposed 判断，避免对 disposed client 发请求秒败。
  it("exposes isDisposed so callers can detect a recycled client before reuse", async () => {
    const transport = new FakeZCodeTransport();
    const client = new ZCodeProtocolClient(transport);

    expect(client.isDisposed).toBe(false);

    client.dispose();
    expect(client.isDisposed).toBe(true);

    // disposed 后 request 应立即拒绝（assertNotDisposed），不能静默吞掉。
    await expect(client.request("session/read", {})).rejects.toThrow(/disposed/);
  });
});
