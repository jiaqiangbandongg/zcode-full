import type { TraceContext } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods, zcodeProtocolMessageSchema } from "@zcode/shared";
import { createProtocolTopicResourcePort } from "../src/zcode-protocol/topic-resource-port.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const request = {
  taskId: "task-a",
  inputId: "input-a",
  authorizationId: "auth-a",
  messageId: "file-a",
  resourceIndex: 0,
};
describe("topic resource protocol port", () => {
  it("sends a strict channel reply and trace through the existing Host reverse port", async () => {
    const requestClient = vi.fn(async (method, params, _schema, options) => {
      expect(
        zcodeProtocolMessageSchema.parse({ id: "reply-1", method, params, trace: options.trace }),
      ).toMatchObject({
        method: zcodeProtocolMethods.channelReply,
        trace: { traceId: "trace-reply" },
      });
      return { status: "unknown", deliveryId: "reply-delivery" };
    });
    const port = createProtocolTopicResourcePort({
      requestClient,
    } as unknown as ZCodeProtocolAgentServerContext);
    const controller = new AbortController();
    expect(
      await port.reply!(
        {
          taskId: "task-a",
          inputId: "input-a",
          toolCallId: "call-a",
          parts: [{ type: "mention", refId: "m1" }],
        },
        { signal: controller.signal, trace: { traceId: "trace-reply" } as TraceContext },
      ),
    ).toEqual({ status: "unknown", deliveryId: "reply-delivery" });
    controller.abort();
    await expect(
      port.reply!(
        {
          taskId: "task-a",
          inputId: "input-a",
          toolCallId: "call-b",
          parts: [{ type: "text", text: "hello" }],
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(requestClient).toHaveBeenCalledTimes(1);
  });
  it("propagates source identity and cancellation using the same request id", async () => {
    let finish!: (value: unknown) => void;
    const requestClient = vi.fn(
      (method: string, _params?: Record<string, unknown>, _schema?: unknown, _options?: unknown) =>
        method === zcodeProtocolMethods.topicResourceRead
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve({ cancelled: true }),
    );
    const port = createProtocolTopicResourcePort({
      requestClient,
    } as unknown as ZCodeProtocolAgentServerContext);
    const controller = new AbortController();
    const pending = port.read(request, { signal: controller.signal });
    controller.abort();
    const readParams = requestClient.mock.calls[0]![1]!;
    expect(readParams).toMatchObject(request);
    expect(requestClient.mock.calls[1]).toEqual(
      expect.arrayContaining([
        zcodeProtocolMethods.topicResourceCancel,
        { requestId: readParams.requestId, taskId: "task-a" },
      ]),
    );
    finish({ ref: "artifact://a", fileName: "a.txt", mime: "text/plain", bytes: 0 });
    await expect(pending).rejects.toThrow();
  });
  it("maps runtime trace into valid strict wire frames for reads and cancellation", async () => {
    let finish: ((value: unknown) => void) | undefined;
    const frames: unknown[] = [];
    const requestClient = vi.fn(
      (method: string, params: unknown, _schema: unknown, options: { trace?: unknown }) => {
        const frame = { id: "server-1", method, params, trace: options.trace };
        frames.push(frame);
        zcodeProtocolMessageSchema.parse(frame);
        return method === zcodeProtocolMethods.topicResourceRead
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve({ cancelled: true });
      },
    );
    const port = createProtocolTopicResourcePort({
      requestClient,
    } as unknown as ZCodeProtocolAgentServerContext);
    const controller = new AbortController();
    const trace = {
      traceId: "trace-a",
      spanId: "span-a",
      parentSpanId: "parent-a",
      sessionId: "sess_a",
      turnId: "turn-a",
      queryId: "query-a",
      attributes: { source: "bot" },
    } as TraceContext;
    const pending = port.read(request, { signal: controller.signal, trace });
    await Promise.resolve();
    if (finish) {
      controller.abort();
      finish({ ref: "artifact://a", fileName: "a.txt", mime: "text/plain", bytes: 0 });
    }
    await expect(pending).rejects.toThrow();
    expect(frames).toHaveLength(2);
    for (const frame of frames)
      expect(zcodeProtocolMessageSchema.parse(frame)).toMatchObject({
        trace: { traceId: "trace-a", spanId: "span-a", parentId: "parent-a" },
      });
  });
  it("contains synchronous disconnect errors from cancellation notification", async () => {
    let finish!: (value: unknown) => void;
    const requestClient = vi.fn((method: string) => {
      if (method === zcodeProtocolMethods.topicResourceCancel)
        throw new Error("Client already disconnected");
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const controller = new AbortController();
    const listen = vi.spyOn(controller.signal, "addEventListener");
    const port = createProtocolTopicResourcePort({
      requestClient,
    } as unknown as ZCodeProtocolAgentServerContext);
    const pending = port.read(request, { signal: controller.signal });
    const cancel = listen.mock.calls[0]![1] as EventListener;
    // 直接调用实际 listener，以免旧实现的同步异常被 Node 转为全局 uncaughtException。
    controller.signal.removeEventListener("abort", cancel);
    controller.abort();
    expect(() => cancel.call(controller.signal, new Event("abort"))).not.toThrow();
    finish({ ref: "artifact://a", fileName: "a.txt", mime: "text/plain", bytes: 0 });
    await expect(pending).rejects.toThrow();
    expect(requestClient).toHaveBeenCalledTimes(2);
  });
  it("does not turn unsupported hosts into a URL fallback", async () => {
    const requestClient = vi.fn(async () => {
      throw new Error("Method not found");
    });
    const port = createProtocolTopicResourcePort({
      requestClient,
    } as unknown as ZCodeProtocolAgentServerContext);
    await expect(port.read(request, { signal: new AbortController().signal })).rejects.toThrow(
      "Method not found",
    );
    expect(requestClient).toHaveBeenCalledOnce();
  });
});
