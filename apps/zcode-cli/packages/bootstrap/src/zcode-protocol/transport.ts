import type {
  ZCodeProtocolError,
  ZCodeProtocolMessage,
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolResponse,
} from "@zcode/shared";
import {
  networkCaptureControlSchema,
  zcodeProtocolMessageSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
} from "@zcode/shared";
import type { Logger } from "@zcode/contracts";

type ZCodeProtocolOutgoingMessage =
  | ZCodeProtocolError
  | ZCodeProtocolNotification
  | ZCodeProtocolRequest
  | ZCodeProtocolResponse;

type ZCodeProtocolMessageHandler = (
  message: ZCodeProtocolMessage,
) => Promise<ZCodeProtocolOutgoingMessage | undefined>;

const PROTOCOL_EOF_DRAIN_MS = 100;
// MCP App 的请求由实例凭证和 callId 隔离；若与普通命令一起等待完成，
// uiCallTool 会挡住自己的 cancel/close，真实 stdio 链路将死锁。
const MCP_APP_CONCURRENT_METHODS = new Set<string>([
  zcodeProtocolMethods.mcpReadResource,
  zcodeProtocolMethods.mcpUiOpenInstance,
  zcodeProtocolMethods.mcpUiCloseInstance,
  zcodeProtocolMethods.mcpUiValidateInstance,
  zcodeProtocolMethods.mcpUiCallTool,
  zcodeProtocolMethods.mcpUiSampling,
  zcodeProtocolMethods.mcpUiCancelSampling,
  zcodeProtocolMethods.mcpUiCancelCall,
  zcodeProtocolMethods.mcpUiReadResource,
  zcodeProtocolMethods.mcpUiListResources,
  zcodeProtocolMethods.mcpUiListResourceTemplates,
  zcodeProtocolMethods.mcpUiSubscribeResource,
  zcodeProtocolMethods.mcpUiUnsubscribeResource,
  zcodeProtocolMethods.mcpUiRegisterAppTools,
  zcodeProtocolMethods.mcpUiUnregisterAppTools,
  zcodeProtocolMethods.mcpUiClaimAppToolCall,
  zcodeProtocolMethods.mcpUiResolveAppToolCall,
]);

interface ZCodeProtocolNdjsonConnectionOptions {
  signal?: AbortSignal;
  clearPostResponseMessages?: () => void;
  handleMessage: ZCodeProtocolMessageHandler;
  input: NodeJS.ReadableStream;
  logger?: Logger;
  onTransportClosed?: (error: Error) => void;
  output: NodeJS.WritableStream;
  takePostResponseMessages?: (
    requestId: ZCodeProtocolRequestId,
  ) => readonly ZCodeProtocolOutgoingMessage[];
  takePostResponseBatch?: (requestId: ZCodeProtocolRequestId) => {
    readonly messages: readonly ZCodeProtocolOutgoingMessage[];
    commit(): boolean;
  } | null;
}

export class ZCodeProtocolNdjsonConnection {
  private buffer = "";
  private processing: Promise<void> = Promise.resolve();
  private lastQueuedMessageStarted: Promise<void> = Promise.resolve();
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: Error) => void;
  private terminal = false;
  private transportCloseNotified = false;
  private draining = false;
  private drainTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ZCodeProtocolNdjsonConnectionOptions) {
    this.closedPromise = new Promise((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
  }

  start(): void {
    this.options.input.on("data", this.onData);
    this.options.input.once("end", this.onClose);
    this.options.input.once("close", this.onClose);
    this.options.input.on("error", this.onError);
    this.options.output.on("error", this.onError);
    this.options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (this.options.signal?.aborted) this.onAbort();
  }

  waitForClose(): Promise<void> {
    return this.closedPromise;
  }

  send(message: ZCodeProtocolOutgoingMessage): void {
    if (this.terminal) return;
    // 观测可丢弃，不能在 stdout 背压时无界积压或挤占业务协议输出。
    if (
      "method" in message &&
      message.method === zcodeProtocolNotifications.processNetworkRequests &&
      ((this.options.output as NodeJS.WritableStream & { writableLength?: number })
        .writableLength ?? 0) >=
        256 * 1024
    )
      return;
    try {
      this.options.output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.terminal || this.draining) return;
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.dispatchLine(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  };

  private readonly onClose = (): void => {
    if (this.terminal || this.draining) return;
    const trailing = this.buffer.trim();
    if (trailing.length > 0) {
      this.dispatchLine(trailing);
      this.buffer = "";
    }
    this.draining = true;
    this.notifyTransportClosed(new Error("ZCode Protocol client connection closed"));
    // EOF 保留短请求半关闭响应，但挂起 handler 不能让进程永久保活。
    this.drainTimer = setTimeout(() => this.finish(), PROTOCOL_EOF_DRAIN_MS);
    void this.processing.then(
      () => this.finish(),
      (error: Error) => this.fail(error),
    );
  };

  private readonly onAbort = (): void => {
    this.notifyTransportClosed(new Error("ZCode Protocol runtime stopping"));
    this.finish();
  };

  private readonly onError = (error: Error): void => {
    this.notifyTransportClosed(error);
    this.fail(error);
  };

  private notifyTransportClosed(error: Error): void {
    if (this.transportCloseNotified) return;
    this.transportCloseNotified = true;
    this.options.onTransportClosed?.(error);
  }

  private finish(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.detachInput();
    this.options.clearPostResponseMessages?.();
    this.resolveClosed();
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.notifyTransportClosed(error);
    this.detachInput();
    this.options.clearPostResponseMessages?.();
    this.rejectClosed(error);
  }

  private detachInput(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.options.input.off("data", this.onData);
    this.options.input.off("end", this.onClose);
    this.options.input.off("close", this.onClose);
    this.options.signal?.removeEventListener("abort", this.onAbort);
    // 错误 listener 保留到流本身结束，吸收已经排入事件循环的迟到 stream error。
  }

  private dispatchLine(line: string): void {
    if (this.terminal) return;
    const message = this.decodeLine(line);
    if (!message) {
      return;
    }
    if (
      !("id" in message) &&
      "method" in message &&
      message.method === zcodeProtocolMethods.processNetworkCapture
    ) {
      // 启停是进程观测控制，不等待正在执行的生成任务，也不进入 CommandInbox。
      if (networkCaptureControlSchema.safeParse(message.params).success) {
        void this.handleMessage(message).catch(() => {
          /* 观测失败不关闭业务连接 */
        });
      }
      return;
    }
    if ("id" in message && ("result" in message || "error" in message)) {
      // Agent 发出反向 request 前已同步登记 pending response。
      // 若 response 等待“最后一个排队请求开始”，后续普通请求会把等待点推到当前长请求之后，
      // 形成「当前请求等 response、response 等后续请求」的死锁。
      void this.handleMessage(message).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    if (this.shouldBypassProcessingQueue(message)) {
      // 停止/取消控制必须等它前面的普通请求真正进入 handler、建立 abort
      // controller，再越过该请求的异步执行；只延后一轮微任务会让控制请求提前成为空操作。
      void this.lastQueuedMessageStarted
        .then(() => this.handleMessage(message))
        .catch((error: unknown) => {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        });
      return;
    }
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.lastQueuedMessageStarted = started;
    this.processing = this.processing
      .then(async () => {
        const handling = this.handleMessage(message);
        markStarted();
        await handling;
      })
      .catch((error: unknown) => {
        markStarted();
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private decodeLine(line: string): ZCodeProtocolMessage | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (error) {
      this.options.logger?.warn("ZCode Protocol JSON parse failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.parse.failed",
        module: "bootstrap.zcode_protocol",
        status: "failed",
      });
      this.sendError("parse-error", -32700, "Parse error");
      return null;
    }

    const parsed = zcodeProtocolMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.sendError("invalid-message", -32600, "Invalid ZCode Protocol message", {
        issues: parsed.error.issues,
      });
      return null;
    }

    return parsed.data;
  }

  private shouldBypassProcessingQueue(message: ZCodeProtocolMessage): boolean {
    // 模型任务占住串行队列时，停止/取消请求必须仍能进入 server，
    // 才能把底层 AbortSignal 传给真实模型请求。控制面只旁路当前执行，普通请求仍保持串行。
    return (
      "id" in message &&
      "method" in message &&
      (message.method === zcodeProtocolMethods.sessionStop ||
        message.method === zcodeProtocolMethods.workspaceCancelGenerateText ||
        MCP_APP_CONCURRENT_METHODS.has(message.method))
    );
  }

  private async handleMessage(message: ZCodeProtocolMessage): Promise<void> {
    if (this.terminal) return;
    const response = await this.options.handleMessage(message);
    if (response) {
      // 确定性时序：先一次性 take 当前 request 的 outbox，再连续写 response
      // 与 notification。禁止 queueMicrotask/setTimeout 或依赖底层分包先后。
      const postResponseBatch =
        "id" in response && ("result" in response || "error" in response)
          ? (this.options.takePostResponseBatch?.(response.id) ?? {
              messages: this.options.takePostResponseMessages?.(response.id) ?? [],
              commit: () => true,
            })
          : { messages: [], commit: () => true };
      // output EPIPE 可能发生在 subscribe handler 在途期间。fail() 已清过
      // 当时的 outbox，但迟到 handler 仍可能新建 request entry；这里先 take 精确释放，
      // terminal 时不再写 response/initial，避免 close 后引用泄漏或继续写坏流。
      if (this.terminal) return;
      this.send(response);
      for (const postResponseMessage of postResponseBatch.messages) {
        this.send(postResponseMessage);
      }
      // 旧 outbox 在生成 logical frame 时已推进 publisher 水位。这里以
      // Writable.write() 未同步抛错作为“进入本 connection-owned queue”的 admission；
      // 后续异步 EPIPE 会终结整个 connection epoch，旧 subscription 不会在新管道复用。
      if (!this.terminal) postResponseBatch.commit();
    }
  }

  private sendError(id: string, code: number, message: string, data?: unknown): void {
    this.send({
      error: {
        code,
        data,
        message,
      },
      id,
    });
  }
}
