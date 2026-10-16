import type { TraceContext } from "../tracing/tracer.js";

/** 仅用于当前任务已经接收的话题附件，身份由可信输入解析，不能由模型指定。 */
export interface TopicResourcePort {
  /** 同一可信 Host 渠道的显式发送能力；缺省不允许 CLI 自行寻找其他机器人凭据。 */
  reply?(
    request: import("@zcode/shared").ChannelReplyRequest,
    context: { signal: AbortSignal; trace?: TraceContext },
  ): Promise<import("@zcode/shared").ChannelReplyResult>;
  read(
    request: {
      taskId: string;
      inputId: string;
      authorizationId: string;
      messageId: string;
      resourceIndex: number;
    },
    context: { signal: AbortSignal; trace?: TraceContext },
  ): Promise<{ ref: string; fileName: string; mime: string; bytes: number }>;
}
