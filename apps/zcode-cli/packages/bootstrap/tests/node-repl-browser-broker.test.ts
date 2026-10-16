import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { BrowserControlPort, Logger, McpServerConfig } from "@zcode/contracts";
import {
  NODE_REPL_BROWSER_BROKER_SOCKET_ENV,
  NODE_REPL_BROWSER_BROKER_TOKEN_ENV,
  nodeReplBrowserBrokerResponseSchema,
} from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "../src/app/node-repl-browser-broker.js";

const logger: Logger = {
  child: () => logger,
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

describe("node_repl browser broker", () => {
  let broker: NodeReplBrowserBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it("injects an authenticated local endpoint only into the global node_repl server", async () => {
    broker = createNodeReplBrowserBroker({
      browserControlPort: createBrowserControlPort(),
      logger,
    });
    await broker.ready;
    const untouched: McpServerConfig = { type: "http", url: "https://example.test/mcp" };
    const servers = injectNodeReplBrowserBroker(
      {
        node_repl: { type: "stdio", command: "node", args: ["server.js"] },
        remote: untouched,
      },
      broker,
    );

    expect(servers.node_repl).toMatchObject({
      env: {
        [NODE_REPL_BROWSER_BROKER_SOCKET_ENV]: broker.socketPath,
        [NODE_REPL_BROWSER_BROKER_TOKEN_ENV]: broker.token,
      },
    });
    expect(servers.remote).toBe(untouched);
  });

  it("shares one broker across sessions and forwards the exact session, turn, trace, and browser identity", async () => {
    const browserControlPort = createBrowserControlPort();
    broker = createNodeReplBrowserBroker({ browserControlPort, logger });
    await broker.ready;

    const listResponse = await exchange(broker.socketPath, {
      id: randomUUID(),
      op: "list",
      runtimeScope: "main",
      sessionId: "session-1",
      token: broker.token,
      trace: { traceId: "trace-1", spanId: "span-1" },
      turnId: "turn-1",
    });
    expect(listResponse).toMatchObject({
      ok: true,
      browsers: [{ id: "iab-1", generation: 7 }],
    });
    expect(browserControlPort.list).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        traceContext: { traceId: "trace-1", spanId: "span-1" },
      }),
    );

    const executeResponse = await exchange(broker.socketPath, {
      browserGeneration: 7,
      browserId: "iab-1",
      command: { method: "getState" },
      id: randomUUID(),
      op: "execute",
      runtimeScope: "main",
      sessionId: "session-2",
      token: broker.token,
      turnId: "turn-2",
    });
    expect(executeResponse).toMatchObject({ ok: true, result: { ok: true, value: "ready" } });
    expect(browserControlPort.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        browserGeneration: 7,
        browserId: "iab-1",
        command: { method: "getState" },
        sessionId: "session-2",
        turnId: "turn-2",
      }),
    );
  });

  it("rejects an invalid token before reaching BrowserControlPort", async () => {
    const browserControlPort = createBrowserControlPort();
    broker = createNodeReplBrowserBroker({ browserControlPort, logger });
    await broker.ready;

    const unauthorized = await exchange(broker.socketPath, {
      id: randomUUID(),
      op: "list",
      runtimeScope: "main",
      sessionId: "session-1",
      token: "0".repeat(64),
    });
    expect(unauthorized).toMatchObject({ ok: false });
    expect(browserControlPort.list).not.toHaveBeenCalled();
  });

  it("forwards subagent Browser Use to BrowserControlPort with the child sessionId", async () => {
    const browserControlPort = createBrowserControlPort();
    broker = createNodeReplBrowserBroker({ browserControlPort, logger });
    await broker.ready;

    const subagent = await exchange(broker.socketPath, {
      id: randomUUID(),
      op: "list",
      runtimeScope: "subagent",
      sessionId: "child-session",
      token: broker.token,
    });
    expect(subagent).toMatchObject({ ok: true });
    expect(browserControlPort.list).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "child-session" }),
    );
  });

  it("preserves the client request id when strict command validation fails", async () => {
    broker = createNodeReplBrowserBroker({
      browserControlPort: createBrowserControlPort(),
      logger,
    });
    await broker.ready;
    const requestId = randomUUID();

    const response = await exchange(broker.socketPath, {
      browserGeneration: 7,
      browserId: "iab-1",
      command: {
        action: {
          name: "locator",
          operation: "click",
          selector: "button",
          // 真机调用按 Playwright 原生字段传 timeout；ZCode 严格 schema 只接受 timeoutMs。
          timeout: 10_000,
        },
        method: "playwright",
      },
      id: requestId,
      op: "execute",
      runtimeScope: "main",
      sessionId: "session-parse-error",
      token: broker.token,
    });

    // 参数错误必须原样回到对应调用；随机占位 id 会让 client 把真实 schema 错误覆盖成 mismatch。
    expect(response).toMatchObject({ id: requestId, ok: false });
    expect(response.ok === false ? response.error : "").toContain("timeout");
  });

  it("stays alive and keeps serving when the client drops the socket while a large response is written", async () => {
    // 回归：steer 会 abort node_repl 客户端并立即 socket.destroy()，此时 broker 往往正要回写
    // 截图 base64。写入死管道产生的 EPIPE 必须被吞掉，而不是变成进程级 unhandled error。
    const debugEvents: string[] = [];
    const spyLogger = createSpyLogger(debugEvents);
    const executing = createDeferred<void>();
    const finishExecute = createDeferred<string>();
    const browserControlPort: BrowserControlPort = {
      list: vi.fn(async () => []),
      execute: vi.fn(async () => {
        executing.resolve();
        return { elapsedMs: 1, ok: true as const, value: await finishExecute.promise };
      }),
    };
    broker = createNodeReplBrowserBroker({ browserControlPort, logger: spyLogger });
    await broker.ready;

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const socket = createConnection(broker.socketPath);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `${JSON.stringify({
          browserGeneration: 1,
          browserId: "iab-1",
          command: { method: "screenshot" },
          id: randomUUID(),
          op: "execute",
          runtimeScope: "main",
          sessionId: "session-1",
          token: broker.token,
          turnId: "turn-1",
        })}\n`,
      );

      await executing.promise;
      // 这里必须在 destroy 之后同步 resolve，中间不能 await 让出事件循环：broker 端的 socket
      // 要等到本轮 IO poll 才会看到对端 FIN，此刻 writable 仍为 true，respond 会真的写下去，
      // 从而复现「写入死管道」。一旦先 await，writable 已翻假，走的就是另一条防御分支了。
      socket.destroy();
      finishExecute.resolve("A".repeat(4 * 1024 * 1024));
      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      expect(uncaught).toEqual([]);
      // 光断言「没崩」还不够：把 error 监听留着但改成静默吞掉，测试同样会绿。这里锁死写入阶段
      // 的错误确实被 broker 的监听接住并记录了，避免后续改动把 EPIPE 悄悄吞成无迹可寻的黑洞。
      expect(debugEvents).toContain("node_repl.browser_broker.connection.dropped");
    } finally {
      process.off("uncaughtException", onUncaught);
    }

    const next = await exchange(broker.socketPath, {
      id: randomUUID(),
      op: "list",
      runtimeScope: "main",
      sessionId: "session-2",
      token: broker.token,
    });
    expect(next).toMatchObject({ ok: true });
  });

  it("propagates the client disconnect as an abort into the in-flight BrowserControlPort request", async () => {
    // 与上一条互补：上一条守住「写死管道不能击穿进程」，这一条守住另一半承诺——对端断开必须
    // 作为取消传到 BrowserControlPort，steer 之后底层浏览器请求不能还在后台继续跑。
    const executing = createDeferred<void>();
    const finishExecute = createDeferred<string>();
    const aborted = createDeferred<void>();
    let executeSignal: AbortSignal | undefined;
    const browserControlPort: BrowserControlPort = {
      list: vi.fn(async () => []),
      execute: vi.fn(async (input) => {
        executeSignal = input.signal;
        input.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
        executing.resolve();
        return { elapsedMs: 1, ok: true as const, value: await finishExecute.promise };
      }),
    };
    broker = createNodeReplBrowserBroker({ browserControlPort, logger });
    await broker.ready;

    const socket = createConnection(broker.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `${JSON.stringify({
        browserGeneration: 1,
        browserId: "iab-1",
        command: { method: "screenshot" },
        id: randomUUID(),
        op: "execute",
        runtimeScope: "main",
        sessionId: "session-1",
        token: broker.token,
        turnId: "turn-1",
      })}\n`,
    );

    await executing.promise;
    // destroy 而非 end：真实客户端（browser-bridge.ts 的 finish）只会 destroy，测试要跟它一致。
    socket.destroy();
    // 条件等待而非固定 sleep：断开传播到 signal 就是这一步要断言的行为本身，等到即证明。
    await aborted.promise;
    expect(executeSignal?.aborted).toBe(true);

    finishExecute.resolve("A".repeat(64 * 1024));
  });
});

function createSpyLogger(debugEvents: string[]): Logger {
  return {
    ...logger,
    debug: (_message, fields) => {
      const event = (fields as { event?: string } | undefined)?.event;
      if (event) debugEvents.push(event);
    },
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createBrowserControlPort(): BrowserControlPort {
  return {
    list: vi.fn(async () => [
      {
        capabilities: { browser: [], tab: [] },
        generation: 7,
        id: "iab-1",
        name: "ZCode Browser",
        type: "iab" as const,
      },
    ]),
    execute: vi.fn(async () => ({ elapsedMs: 1, ok: true, value: "ready" })),
  };
}

async function exchange(socketPath: string, request: unknown) {
  return await new Promise<ReturnType<typeof nodeReplBrowserBrokerResponseSchema.parse>>(
    (resolve, reject) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          resolve(nodeReplBrowserBrokerResponseSchema.parse(JSON.parse(buffer.slice(0, newline))));
        } catch (error) {
          reject(error);
        } finally {
          socket.destroy();
        }
      });
      socket.once("error", reject);
    },
  );
}
