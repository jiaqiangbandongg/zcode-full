import { ServiceChannels } from "@zcode/shared";
import type { McpAppsSamplingResult } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";
import type { PluginUiPluginScope } from "./contract.js";

export interface PluginUiSamplingParams extends PluginUiPluginScope {
  operationId: string;
  request: import("@zcode/shared/mcp-apps").McpAppsSamplingParams;
}
export interface PluginUiCancelSamplingParams extends PluginUiPluginScope {
  operationId: string;
}

/** 无状态透传；Agent 持有实例凭证、并发限额和唯一调用终态。 */
export interface IPluginUiSamplingService {
  sample(params: PluginUiSamplingParams): Promise<McpAppsSamplingResult>;
  cancelSampling(params: PluginUiCancelSamplingParams): Promise<{ cancelled: boolean }>;
}
export const IPluginUiSamplingService = createServiceDescriptor<IPluginUiSamplingService>(
  ServiceChannels.PluginUiSampling,
);
