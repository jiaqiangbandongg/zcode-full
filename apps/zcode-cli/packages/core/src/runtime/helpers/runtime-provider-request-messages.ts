import { buildToolExposure } from "../../tool/search/exposure.js";
import type { ModelToolContract } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ToolRegistry } from "../../tool/registry.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  buildProviderRequestMessages,
  type ProviderRequestMessageProjectionResult,
} from "./provider-request-messages.js";

type RequestRuntime = {
  readonly config: Pick<AgentRuntimeConfig, "midConversationSystem" | "toolSearch">;
};

interface MessageProjectionInput {
  entries: readonly RuntimeMessageEntry[];
  applyCacheControl?: boolean;
  skipCacheWrite?: boolean;
  model: Model;
  loadedToolCallIds?: ReadonlySet<string>;
}

// Bug 根因：辅助请求分别组装历史和 tools 时，曾按模型能力保留引用却发送 tools: []。
// 请求准备必须先用完整作用域目录做一次 ToolSearch 决策，再向投影和发送方提供配套结果。
export function prepareRuntimeProviderRequest(
  runtime: RequestRuntime,
  input: MessageProjectionInput & {
    tools: readonly ModelToolContract[];
    registry?: Pick<ToolRegistry, "get">;
    prompt?: string;
  },
) {
  const exposure = buildToolExposure({
    model: input.model,
    mode: runtime.config.toolSearch?.mode,
    tools: input.tools,
    registry: input.registry,
    entries: input.entries,
  });
  const projection = buildRuntimeProviderRequestMessages(runtime, {
    entries:
      input.prompt === undefined
        ? exposure.entries
        : [...exposure.entries, { message: { role: "user", content: input.prompt } }],
    model: input.model,
    loadedToolCallIds: exposure.loadedToolCallIds,
    applyCacheControl: input.applyCacheControl,
    skipCacheWrite: input.skipCacheWrite,
  });
  return {
    request: {
      messages: projection.messages,
      tools: exposure.tools,
      toolSearchEnabled: exposure.context.mode === "native",
    },
    projection,
    entries: exposure.entries,
    // 记录过滤 Continue 后会重新渲染，需复用本次有效引用，避免遗漏成功提示或重复扫描历史。
    loadedToolCallIds: exposure.loadedToolCallIds,
    toolSearch: exposure.context,
    reason: exposure.reason,
  };
}

// 仅渲染消息，供已准备请求的记录投影和历史估算复用；不重新猜测工具启用状态。
export function buildRuntimeProviderRequestMessages(
  runtime: RequestRuntime,
  input: MessageProjectionInput,
): ProviderRequestMessageProjectionResult {
  const useMidConversationSystem =
    runtime.config.midConversationSystem?.mode === "force" ||
    input.model.properties.supportsMidConversationSystem;
  return buildProviderRequestMessages({
    ...input,
    useMidConversationSystem,
  });
}
