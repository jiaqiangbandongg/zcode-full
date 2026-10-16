import { once } from "node:events";
import { connect, createServer } from "node:net";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { requestControl } from "../src/ipc/controlClient.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { encodeJsonLine, JsonLineDecoder } from "../src/ipc/framing.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

async function createControlTestEndpoint(): Promise<string> {
  // Bug 原因：macOS 的 Unix socket 路径上限很短，测试名语义化前缀叠加系统临时目录后
  // 会让 control.sock 超过上限并报 EINVAL；固定使用短前缀，随机后缀仍保证用例隔离。
  const root = await mkdtemp(join(tmpdir(), "z2-"));
  const endpoint = resolveServerLayout(join(root, "server")).controlEndpoint;
  // Bugfix：POSIX 下 endpoint 是 <root>/server/run/control.sock，原生
  // net.createServer().listen() 不像 createControlServer 那样自带父目录 mkdir，
  // 目录缺失会在 POSIX CI 上 ENOENT；Windows named pipe（\\.\pipe\ 前缀）无目录概念。
  if (!endpoint.startsWith("\\\\.\\pipe\\")) {
    await mkdir(dirname(endpoint), { recursive: true });
  }
  return endpoint;
}

describe("JSONL framing", () => {
  it("handles split and coalesced frames", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push(encodeJsonLine({ id: 1 })).length).toBe(1);
    expect(decoder.push('{"id":2}\n{"id":3}\n')).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it("rejects oversized or malformed frames", () => {
    const decoder = new JsonLineDecoder({ maxFrameBytes: 10 });
    expect(() => decoder.push('{"too-long":true}\n')).toThrow(/frame/i);
    expect(() => new JsonLineDecoder().push("not-json\n")).toThrow(/json/i);
  });
});

describe("control client", () => {
  it("times out when the supervisor never responds", async () => {
    const endpoint = await createControlTestEndpoint();
    // 故意不回复任何帧，验证客户端有界超时而不是永久挂起。
    // 服务端连接不消费数据，server.close 回调要等连接结束，清理时必须主动 destroy。
    const connections: import("node:net").Socket[] = [];
    const server = createServer((socket) => connections.push(socket));
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    try {
      await expect(requestControl(endpoint, { command: "ping" }, 100)).rejects.toThrow(/timed out/);
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("survives a client disconnect before a delayed response", async () => {
    const endpoint = await createControlTestEndpoint();
    let signalHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      signalHandlerStarted = resolve;
    });
    let releaseHandler!: () => void;
    const handlerRelease = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let callCount = 0;
    const uncaughtErrors: unknown[] = [];
    const onUncaughtException = (error: unknown): void => {
      uncaughtErrors.push(error);
    };
    process.on("uncaughtException", onUncaughtException);
    const control = await createControlServer(endpoint, async () => {
      callCount += 1;
      if (callCount === 1) {
        signalHandlerStarted();
        await handlerRelease;
      }
      return { accepted: true };
    });
    const client = connect(endpoint);
    client.on("error", () => undefined);
    try {
      await once(client, "connect");
      client.write(encodeJsonLine({ id: "disconnect", command: "ping" }));
      await handlerStarted;
      client.destroy();
      releaseHandler();
      await once(client, "close");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(uncaughtErrors).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onUncaughtException);
      client.destroy();
      await control.close();
    }
  });

  it("closes active control clients when the server closes", async () => {
    const endpoint = await createControlTestEndpoint();
    const control = await createControlServer(endpoint, async () => undefined);
    const client = connect(endpoint);
    await once(client, "connect");

    const closeResult = await Promise.race([
      control.close().then(() => "closed" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    if (closeResult === "hung") {
      client.destroy();
      await control.close();
    }

    expect(closeResult).toBe("closed");
    expect(client.destroyed).toBe(true);
  });
});
