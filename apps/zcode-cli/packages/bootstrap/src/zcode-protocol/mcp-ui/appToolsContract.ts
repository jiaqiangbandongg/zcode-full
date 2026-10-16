import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@zcode/shared/mcp-apps";
import type { McpUiPluginScope } from "./resourceContract.js";

/**
 * App-Provided Tools 的 renderer → agent 参数形状（与 `@zcode/shared` 的 `zcodeMcpUi*AppTool*` schema 同构）。
 * 实例身份 = 沙箱作用域 + 代际，与资源订阅同一三元组；信箱投递也按它寻址。
 */
export interface McpUiAppToolInstance {
  scopeId: string;
  generation: number;
}
export interface McpUiRegisterAppToolsParams extends McpUiPluginScope, McpUiAppToolInstance {
  tools: McpAppsAppToolDescriptor[];
}
export interface McpUiRegisterAppToolsResult {
  tools: Array<{ name: string; modelName: string }>;
}
export interface McpUiUnregisterAppToolsParams extends McpUiPluginScope, McpUiAppToolInstance {}
export interface McpUiUnregisterAppToolsResult {
  removed: number;
}
export interface McpUiAppToolCallParams extends McpUiPluginScope, McpUiAppToolInstance {
  callId: string;
}
export interface McpUiResolveAppToolCallParams extends McpUiAppToolCallParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface McpUiAppToolAcceptedResult {
  accepted: boolean;
}
