import type { ToolRegistry } from "../registry.js";
import type { ChannelReplyTool } from "./contract.js";

/** 只登记既有 ToolEntry；实际发送仍通过公共工具执行链。 */
export function exampleChannelReplyTool(
  registry: Pick<ToolRegistry, "register">,
  entry: ChannelReplyTool,
): void {
  registry.register(entry);
}
