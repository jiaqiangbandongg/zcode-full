import type { ZCodePluginUiSurface } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { McpToolUiCsp, PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";

/** 与 zcodeAgentService 其余方法一致的 workspace 定位；身份用 workspaceIdentity，路径用 workspacePath。 */
export interface PluginUiWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** UI 发起的插件 MCP 请求共用的归属范围：同一 session、同一插件、同一 namespaced server。 */
export interface PluginUiPluginScope extends PluginUiWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  /** display.ui / 清单 surface 所属的 namespaced server（`plugin:<name>:<server>`）；归属由 agent 侧 catalog 校验。 */
  serverName: string;
}

export interface PluginUiPrepareSandboxParams extends Omit<PluginUiPluginScope, "instance"> {
  /** 沙箱作用域 id（`buildPluginSandboxScopeId`）：工具卡片 `tool:<toolCallId>`，面板 `surface:<surfaceId>`。 */
  scopeId: string;
  resourceUri: string;
  /** 发起请求的宿主窗口 webContents id，main 用它校验 webview attach 归属。 */
  ownerWebContentsId: number;
  /**
   * 来自 display.ui 的工具级声明。起只是兜底：`ui://` 资源项自己的 `_meta`（csp / prefersBorder /
   * 尺寸提示）才是权威，桥读资源时解析并优先使用；产品决策为完全信任插件声明。
   */
  csp?: McpToolUiCsp;
  prefersBorder?: boolean;
}

export interface PluginUiCallToolParams extends PluginUiPluginScope {
  toolName: string;
  arguments?: Record<string, unknown>;
  /** 宿主生成的调用 id；卸载卡片时经 cancelToolCall 取消到 agent 的 MCP client。 */
  callId: string;
}
export interface PluginUiCancelToolCallParams extends PluginUiPluginScope {
  callId: string;
}

export interface PluginUiCallToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** 页面发起的 `resources/read`；结果形状与 MCP `resources/read` 一致，页面可直接消费。 */
export interface PluginUiReadResourceParams extends PluginUiPluginScope {
  uri: string;
}
export interface PluginUiResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  /** base64。 */
  blob?: string;
}
export interface PluginUiReadResourceResult {
  contents: PluginUiResourceContent[];
}

/** 页面发起的 resources/list、resources/templates/list；结果与 MCP 同形，游标透传。 */
export interface PluginUiListResourcesParams extends PluginUiPluginScope {
  cursor?: string;
}
export interface PluginUiResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
export interface PluginUiListResourcesResult {
  resources: PluginUiResourceDescriptor[];
  nextCursor?: string;
}
export interface PluginUiListResourceTemplatesResult {
  resourceTemplates: Array<Omit<PluginUiResourceDescriptor, "uri"> & { uriTemplate: string }>;
  nextCursor?: string;
}
/**
 * 订阅 / 退订。订阅者身份 = session + 沙箱作用域 + 实例代际（initId），
 * agent 侧按 (server, uri) 引用计数；dispose 只退订本代际。server 不支持订阅时 agent 回 -32001。
 */
export interface PluginUiResourceSubscriptionParams extends PluginUiPluginScope {
  scopeId: string;
  generation: number;
  uri: string;
}

/** 工作区级面板入口（清单 `ui.surfaces[]`），来自 agent `plugins/listUiSurfaces`。 */
export type PluginUiSurfaceEntry = ZCodePluginUiSurface;

/**
 * 插件 UI 桥。UI 只依赖这个描述符，不直接调用 zcodeAgentService（M5 ③-3 平台能力面收敛）。
 * `prepareSandbox` 以 (ownerWebContentsId, workspaceKey, sessionId, pluginId, scopeId) 幂等：重复调用返回同一
 * sandboxId 与递增 initId；同键并发调用只合并资源读取、登记各自进行（H15-a，每个调用方拿自己的 initId），
 * 顺序调用仍重新读取以拿到最新 HTML。
 * 句柄的 `resourceMeta` 带资源级 prefersBorder / heightHint / minFrameHeight（H02）。
 */
export interface IPluginUiBridgeService {
  validateInstance(params: PluginUiPluginScope): Promise<void>;
  recycleInstance(params: PluginUiPluginScope): Promise<boolean>;
  closeInstance(params: PluginUiPluginScope): Promise<void>;
  prepareSandbox(params: PluginUiPrepareSandboxParams): Promise<PluginSandboxHandle>;
  callTool(
    params: PluginUiCallToolParams,
    options?: { signal?: AbortSignal },
  ): Promise<PluginUiCallToolResult>;
  /**
   * 取消带 callId 的进行中调用。renderer → host 的 RPC 传不了 AbortSignal，
   * 所以取消是一条显式请求；agent 侧 abort 到 MCP client。返回 false 表示已完成或未登记。
   */
  cancelToolCall(params: PluginUiCancelToolCallParams): Promise<{ cancelled: boolean }>;
  readResource(params: PluginUiReadResourceParams): Promise<PluginUiReadResourceResult>;
  /** 资源列表 / 模板 / 订阅，同 readResource 一样限同插件 server，归属由 agent 校验。 */
  listResources(params: PluginUiListResourcesParams): Promise<PluginUiListResourcesResult>;
  listResourceTemplates(
    params: PluginUiListResourcesParams,
  ): Promise<PluginUiListResourceTemplatesResult>;
  subscribeResource(params: PluginUiResourceSubscriptionParams): Promise<void>;
  unsubscribeResource(params: PluginUiResourceSubscriptionParams): Promise<void>;
  /** 已启用插件的面板入口；插件启停后由 UI 重新拉取（不缓存）。 */
  listSurfaces(params: PluginUiWorkspaceTarget): Promise<PluginUiSurfaceEntry[]>;
}

export const IPluginUiBridgeService = createServiceDescriptor<IPluginUiBridgeService>(
  ServiceChannels.PluginUiBridge,
);
