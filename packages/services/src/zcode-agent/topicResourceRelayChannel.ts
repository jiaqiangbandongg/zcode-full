import { channelReplyHostRequestSchema } from "@zcode/shared";
import type { IServerChannel, CancellationToken } from "@zcode/rpc";
import {
  zcodeTopicResourceRelayRequestSchema,
  zcodeTopicResourceRelayKeySchema,
} from "@zcode/shared";
import {
  createTopicResourceRelay,
  type TopicResourceRelayDependencies,
} from "./topicResourceRelay.js";

/** 只注册在已鉴权远程连接的反向 server 上，不暴露在 Renderer/手机 service collection。 */
export function createTopicResourceRelayChannel(deps: TopicResourceRelayDependencies) {
  const relay = createTopicResourceRelay(deps);
  const validations = new Set<AbortController>();
  let disposed = false;
  const channel: IServerChannel = {
    async call<T>(
      _context: string,
      command: string,
      value?: unknown,
      token?: CancellationToken,
    ): Promise<T> {
      if (disposed || token?.isCancellationRequested)
        throw new Error("Topic resource connection closed");
      if (command === "reply") {
        if (!deps.reply) throw new Error("Channel reply unavailable");
        return (await deps.reply(channelReplyHostRequestSchema.parse(value))) as T;
      }
      if (command === "validate") {
        const request = zcodeTopicResourceRelayRequestSchema.parse(value);
        if (validations.size >= 2) throw new Error("Topic resource validation busy");
        const controller = new AbortController();
        validations.add(controller);
        const subscription = token?.onCancellationRequested(() => controller.abort());
        const timer = setTimeout(() => controller.abort(), 120_000);
        try {
          await deps.validate(request, controller.signal);
          controller.signal.throwIfAborted();
          return { valid: true } as T;
        } finally {
          clearTimeout(timer);
          subscription?.dispose();
          validations.delete(controller);
        }
      }
      if (!["begin", "chunk", "finish", "cancel"].includes(command))
        throw new Error("Unsupported topic resource operation");
      const request = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const key = zcodeTopicResourceRelayKeySchema.parse({
        requestId: request.requestId,
        taskId: request.taskId,
      });
      const subscription = token?.onCancellationRequested(() => {
        relay.cancel(key);
      });
      try {
        if (command === "begin") return (await relay.begin(value)) as T;
        if (command === "chunk") return (await relay.chunk(value)) as T;
        if (command === "finish") return (await relay.finish(value)) as T;
        return { cancelled: relay.cancel(value) } as T;
      } finally {
        subscription?.dispose();
      }
    },
    listen() {
      throw new Error("Topic resource events are unavailable");
    },
  };
  return {
    channel,
    dispose() {
      disposed = true;
      relay.dispose();
      for (const controller of validations) controller.abort();
      validations.clear();
    },
  };
}
