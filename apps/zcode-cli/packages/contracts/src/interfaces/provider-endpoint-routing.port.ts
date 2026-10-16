import type { TraceContext } from "../tracing/tracer.js";

export interface ProviderEndpointRoutingDecision {
  routed: boolean;
  url: string;
}

export interface ProviderEndpointRoutingResolveOptions {
  apiKeyId?: string;
  signal?: AbortSignal;
  trace?: TraceContext;
}

/**
 * 模型 provider transport 的动态 endpoint 决策边界。
 *
 * 实现可以按需刷新远端配置，但不得修改或持久化 provider baseURL。
 */
export interface ProviderEndpointRoutingPort {
  resolve(
    requestUrl: string,
    options?: ProviderEndpointRoutingResolveOptions,
  ): Promise<ProviderEndpointRoutingDecision>;
}
