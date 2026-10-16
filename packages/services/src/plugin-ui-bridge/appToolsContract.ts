import { ServiceChannels } from "@zcode/shared";
import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";
import type { PluginUiPluginScope } from "./contract.js";

/**
 * App-Provided Tools 的 renderer → agent 通道。页面实例身份 = 会话 + 沙箱作用域 + 代际（与资源订阅同一三元组）。
 * 登记按实例整体替换；模型调用经实例信箱（`pluginUi.appToolCall` live 增量）到达渲染端，认领 / 回传按 callId 幂等。
 * 登记表、暴露集合与待执行调用由 agent 唯一持有，本服务不保存状态。
 */
export interface PluginUiAppToolInstanceParams extends PluginUiPluginScope {
  scopeId: string;
  generation: number;
}
export interface PluginUiRegisterAppToolsParams extends PluginUiAppToolInstanceParams {
  tools: McpAppsAppToolDescriptor[];
}
export interface PluginUiRegisterAppToolsResult {
  tools: Array<{ name: string; modelName: string }>;
}
export interface PluginUiAppToolCallParams extends PluginUiAppToolInstanceParams {
  callId: string;
}
export interface PluginUiResolveAppToolCallParams extends PluginUiAppToolCallParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface PluginUiAppToolAcceptedResult {
  accepted: boolean;
}

export interface IPluginUiAppToolsService {
  /** 页面 `tools/list` 结果整体替换本实例的登记；返回实际暴露给模型的名字。依赖缺失（web / 远程）抛 unavailable。 */
  registerAppTools(params: PluginUiRegisterAppToolsParams): Promise<PluginUiRegisterAppToolsResult>;
  /** 实例销毁时注销；无 agent 或会话已关闭时回 `{ removed: 0 }`。 */
  unregisterAppTools(params: PluginUiAppToolInstanceParams): Promise<{ removed: number }>;
  /** 认领信箱里的待执行调用；只有第一次认领成功，之后才向页面发 tools/call。 */
  claimAppToolCall(params: PluginUiAppToolCallParams): Promise<PluginUiAppToolAcceptedResult>;
  /** 回传页面结果或错误；未认领 / 已结束的调用回 `{ accepted: false }`。 */
  resolveAppToolCall(
    params: PluginUiResolveAppToolCallParams,
  ): Promise<PluginUiAppToolAcceptedResult>;
}

export const IPluginUiAppToolsService = createServiceDescriptor<IPluginUiAppToolsService>(
  ServiceChannels.PluginUiAppTools,
);
