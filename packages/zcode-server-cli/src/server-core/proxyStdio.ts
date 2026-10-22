import { createConnection } from "node:net";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { ServerLayout } from "../runtime/paths.js";
import { readPersistedStatusDetailed } from "../runtime/statusSnapshot.js";

export class ProxyStdioError extends Error {
  public constructor(
    public readonly code: "daemon-not-ready" | "daemon-connect-failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProxyStdioError";
  }
}

export interface ProxyStdioOptions {
  layout: ServerLayout;
  input: Readable;
  output: Writable;
}

export async function runProxyStdio(options: ProxyStdioOptions): Promise<void> {
  const persisted = await readPersistedStatusDetailed(options.layout);
  const status = persisted.status;
  if (
    persisted.state !== "valid" ||
    status?.state !== "ready" ||
    status.port === null ||
    status.port <= 0
  ) {
    throw new ProxyStdioError(
      "daemon-not-ready",
      "ZCode Server daemon is not ready for proxy-stdio",
    );
  }

  const socket = createConnection({ host: "127.0.0.1", port: status.port });
  try {
    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([error]) => {
        throw error;
      }),
    ]);
  } catch (error) {
    socket.destroy();
    throw new ProxyStdioError(
      "daemon-connect-failed",
      "Unable to connect proxy-stdio to the ZCode Server daemon",
      { cause: error },
    );
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off("error", fail);
      options.input.off("error", fail);
      options.output.off("error", fail);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.output.writableNeedDrain) {
        options.output.once("drain", resolve);
      } else {
        resolve();
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    socket.once("close", finish);
    socket.once("error", fail);
    options.input.once("error", fail);
    options.output.once("error", fail);
    // stdout 必须保持纯字节通道；错误只由 CLI 写 stderr，桥内不注入任何 framing。
    options.input.pipe(socket);
    socket.pipe(options.output, { end: false });
  });
}
