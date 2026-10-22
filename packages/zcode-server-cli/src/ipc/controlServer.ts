import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import {
  CONTROL_CLOSE_TIMEOUT_MS,
  controlRequestSchema,
  controlResponseSchema,
  type ControlRequest,
  type ControlResponse,
} from "../contracts.js";
import { encodeJsonLine, JsonLineDecoder } from "./framing.js";
import { ControlRequestError } from "./controlError.js";

export interface ControlHandler {
  (request: ControlRequest): Promise<unknown>;
}

export async function createControlServer(
  endpoint: string,
  handler: ControlHandler,
): Promise<{ server: Server; close: () => Promise<void> }> {
  await rm(endpoint, { force: true }).catch(() => undefined);
  await mkdir(endpoint.includes("/") ? endpoint.slice(0, endpoint.lastIndexOf("/")) : ".", {
    recursive: true,
  }).catch(() => undefined);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleSocket(socket, handler);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(endpoint, 0o600).catch(() => undefined);
  // server.close() 只会停止新连接，仍然会等待已有连接自然结束。
  // 控制 socket 属于生命周期收口的一部分，必须主动收集并销毁，避免同 UID 的挂起客户端
  // 永久占住 close 回调，进而让 Supervisor 的 lock 和 lifecycle operation 一直不释放。
  let closePromise: Promise<void> | undefined;
  return {
    server,
    close: async () => {
      if (closePromise) return await closePromise;
      closePromise = (async () => {
        const serverClosed = new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        for (const socket of sockets) socket.destroy();
        // 只等待 server.close() 的自然回调会让半帧或失联客户端把
        // stop/restart/uninstall 永久 pending。销毁活动连接后仍保留有界兜底，保证 endpoint
        // 和上层 data-root lock 最终可以收口。
        await Promise.race([
          serverClosed,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, CONTROL_CLOSE_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
        await rm(endpoint, { force: true }).catch(() => undefined);
      })();
      return await closePromise;
    },
  };
}

function handleSocket(socket: Socket, handler: ControlHandler): void {
  const decoder = new JsonLineDecoder();
  // 客户端超时会主动 destroy socket，迟到的 response write 可能异步发出
  // EPIPE/ECONNRESET。socket 的 error 若无人消费会升级成未处理事件并退出 Supervisor；
  // 控制客户端断开属于正常的 best-effort 回写失败，不能影响 Supervisor 生命周期。
  socket.on("error", () => {
    socket.destroy();
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      writeResponse(socket, {
        id: randomUUID(),
        ok: false,
        error: errorResponse("invalid-frame", error),
      });
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      void dispatch(socket, frame, handler);
    }
  });
  socket.on("end", () => {
    try {
      decoder.finish();
    } catch {
      socket.destroy();
    }
  });
}

async function dispatch(socket: Socket, raw: unknown, handler: ControlHandler): Promise<void> {
  const parsed = controlRequestSchema.safeParse(raw);
  if (!parsed.success) {
    writeResponse(socket, {
      id: randomUUID(),
      ok: false,
      error: { code: "invalid-request", message: "Invalid control request" },
    });
    return;
  }
  try {
    const result = await handler(parsed.data);
    writeResponse(socket, { id: parsed.data.id, ok: true, result });
  } catch (error: unknown) {
    writeResponse(socket, {
      id: parsed.data.id,
      ok: false,
      error: errorResponse("request-failed", error),
    });
  }
}

function writeResponse(socket: Socket, response: ControlResponse): void {
  const parsed = controlResponseSchema.parse(response);
  if (socket.destroyed || socket.writableEnded) return;
  try {
    socket.write(encodeJsonLine(parsed), (error) => {
      if (error) socket.destroy();
    });
  } catch {
    socket.destroy();
  }
}

function errorResponse(
  code: string,
  error: unknown,
): { code: string; message: string; retryable?: boolean } {
  if (error instanceof ControlRequestError) {
    return { code: error.code, message: error.message.slice(0, 500), retryable: error.retryable };
  }
  return {
    code,
    message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  };
}
