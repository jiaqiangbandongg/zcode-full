import type { ToolEntry } from "../types.js";
export { channelReplyPartsSchema, channelReplyResultSchema } from "@zcode/shared";

/** 复用原工具入口；执行输入绑定、发送、取消和错误继续由 handler 与 Host 端口负责。 */
export type ChannelReplyTool = ToolEntry;
