import type { IncomingMessage, Server, ServerResponse } from "node:http";

export type DrainWaitResult = "drain" | "closed";

export function waitForDrainOrDisconnect(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<DrainWaitResult> {
  // 只等待 drain 时，客户端在背压期间 close 不会结算 Promise，最终无法释放 Host 全局槽位。
  const isClosed = () => request.aborted || response.destroyed || response.writableEnded;
  if (isClosed()) return Promise.resolve("closed");

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      request.removeListener("aborted", onAborted);
      response.removeListener("close", onClose);
      response.removeListener("drain", onDrain);
      response.removeListener("error", onError);
    };
    const settle = (result: DrainWaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAborted = () => settle("closed");
    const onClose = () => settle("closed");
    const onDrain = () => settle("drain");
    const onError = () => settle("closed");

    request.once("aborted", onAborted);
    response.once("close", onClose);
    response.once("drain", onDrain);
    response.once("error", onError);
    if (isClosed()) settle("closed");
  });
}

export function isPathWithinWorkspace(path: string, workspacePath: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/\/+/gu, "/");
    return normalized.length > 1 ? normalized.replace(/\/$/u, "") : normalized;
  };
  const candidate = normalize(path);
  const root = normalize(workspacePath);
  if (root === "/") return candidate.startsWith("/");
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function parseRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | undefined | "invalid" {
  if (!value) return undefined;
  if (!value.startsWith("bytes=") || value.slice("bytes=".length).includes(",")) {
    return "invalid";
  }
  const [startValue, endValue] = value.slice("bytes=".length).split("-", 2);
  if (!startValue && !endValue) return "invalid";
  if (size === 0) return "invalid";
  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startValue);
  const end = endValue ? Number(endValue) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

export function writeError(response: ServerResponse, message: string, statusCode: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

export async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0 });
  });
}
