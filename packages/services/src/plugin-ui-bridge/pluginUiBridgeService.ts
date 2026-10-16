import type {
  ZCodeMcpReadResourceResult,
  ZCodeMcpUiCallToolResult,
  ZCodeMcpUiCancelCallResult,
  ZCodeMcpUiListResourceTemplatesResult,
  ZCodeMcpUiListResourcesResult,
  ZCodeMcpUiReadResourceResult,
  ZCodePluginsListUiSurfacesResult,
} from "@zcode/shared";
import type {
  McpAppResourceMeta,
  PluginSandboxHandle,
  PluginSandboxRegisterInput,
} from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_HTML_MAX_BYTES,
  MCP_APPS_HTML_MIME_TYPES,
  MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
  normalizeMcpAppResourceMeta,
} from "@zcode/shared/mcp-apps";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  IPluginUiBridgeService,
  PluginUiCallToolParams,
  PluginUiCancelToolCallParams,
  PluginUiListResourcesParams,
  PluginUiPrepareSandboxParams,
  PluginUiReadResourceParams,
  PluginUiResourceSubscriptionParams,
  PluginUiWorkspaceTarget,
} from "./contract.js";

export interface PluginUiBridgeServiceDependencies {
  recycleInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<boolean>;
  validateInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<void>;
  openInstance?: (
    params: PluginUiPrepareSandboxParams,
  ) => Promise<import("@zcode/shared/mcp-apps").McpAppInstance>;
  closeInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<void>;

  readMcpResource?: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    pluginId: string;
    serverName: string;
    uri: string;
    instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  }) => Promise<ZCodeMcpReadResourceResult>;
  callMcpToolForUi?: (
    params: PluginUiCallToolParams,
    options?: { signal?: AbortSignal },
  ) => Promise<ZCodeMcpUiCallToolResult>;
  /** 取消带 callId 的进行中调用。 */
  cancelMcpToolCallForUi?: (
    params: PluginUiCancelToolCallParams,
  ) => Promise<ZCodeMcpUiCancelCallResult>;
  /** 页面发起的 `resources/read`，agent 侧 `mcp/uiReadResource` 做归属与 mimeType 校验。 */
  readMcpResourceForUi?: (
    params: PluginUiReadResourceParams,
  ) => Promise<ZCodeMcpUiReadResourceResult>;
  /** 资源列表 / 模板 / 订阅代理；缺省（web / 远程）时对应方法抛 unavailable。 */
  listMcpResourcesForUi?: (
    params: PluginUiListResourcesParams,
  ) => Promise<ZCodeMcpUiListResourcesResult>;
  listMcpResourceTemplatesForUi?: (
    params: PluginUiListResourcesParams,
  ) => Promise<ZCodeMcpUiListResourceTemplatesResult>;
  subscribeMcpResourceForUi?: (params: PluginUiResourceSubscriptionParams) => Promise<unknown>;
  unsubscribeMcpResourceForUi?: (params: PluginUiResourceSubscriptionParams) => Promise<unknown>;
  registerSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  /** 工作区级 `plugins/listUiSurfaces`。 */
  listPluginUiSurfaces?: (
    params: PluginUiWorkspaceTarget,
  ) => Promise<ZCodePluginsListUiSurfacesResult>;
  /** 由 display.ui 提供的 CSP / prefersBorder 在 prepare 时随 params 传入；这里只做透传。 */
}

export class PluginUiBridgeError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "resource_not_found"
      | "resource_too_large"
      | "unsupported_mime_type"
      | "invalid_server_uri",
    message: string,
  ) {
    super(message);
    this.name = "PluginUiBridgeError";
  }
}

/**
 * `ui://` 资源 URI 的 server 归属由 agent 侧 catalog 校验；这里只负责把 URI 拆成 server 名。
 * 约定：`ui://<plugin-name>/<path>` 对应 namespaced server 由 params.serverName 显式给出，
 * 不从 URI 猜测。
 */
export function createPluginUiBridgeService(
  dependencies: PluginUiBridgeServiceDependencies = {},
): IPluginUiBridgeService {
  // prepare 每个沙箱只有一两次，info 级留生命周期轨迹（读资源 / 登记 / 失败），排 e2e 与用户现场用。
  // 修复：logger 必须在工厂里创建而不是模块顶层——本文件经 @zcode/services 入口也被打进 renderer bundle，
  // 顶层 createServiceLogger 会在 import 时读 process.pid，renderer 里直接 ReferenceError，整个主界面起不来。
  const log = createServiceLogger("plugin-ui-bridge");
  const preparing = new Map<string, Promise<PluginSandboxHandle>>();
  const prepareSandboxOnce = async (
    params: PluginUiPrepareSandboxParams,
    instance: import("@zcode/shared/mcp-apps").McpAppInstance,
  ) => {
    if (
      !dependencies.readMcpResource ||
      !dependencies.registerSandbox ||
      !dependencies.openInstance
    ) {
      throw new PluginUiBridgeError(
        "unavailable",
        "Plugin UI sandbox is unavailable in this runtime",
      );
    }
    const bound = { ...params, instance };
    const startedAt = Date.now();
    log.info("prepareSandbox start", {
      sessionId: params.sessionId,
      pluginId: params.pluginId,
      scopeId: params.scopeId,
      resourceUri: params.resourceUri,
    });
    let result: ZCodeMcpReadResourceResult;
    try {
      result = await dependencies.readMcpResource({ ...bound, uri: params.resourceUri });
    } catch (error) {
      log.warn("prepareSandbox readResource failed", {
        scopeId: params.scopeId,
        resourceUri: params.resourceUri,
        error: error instanceof Error ? error.message : String(error),
      });
      await dependencies.closeInstance?.(bound);
      throw error;
    }
    try {
      const picked = pickHtmlResource(result, params.resourceUri);
      const { html } = picked;
      // 资源级 _meta 是权威：先看 resources/read 选中的 HTML 项，缺省再回退到 resources/list 条目
      // （规范把 csp / prefersBorder 放在列表条目的 _meta 上，官方 SDK 的 registerAppResource 也只写那里）；
      // 工具级声明只在资源两处都没有对应字段时兜底；csp 整体取舍，不逐域并集。
      const meta =
        picked.meta ?? (await readListLevelResourceMeta(dependencies.listMcpResourcesForUi, bound));
      const csp = meta?.csp ?? params.csp;
      const prefersBorder = meta?.prefersBorder ?? params.prefersBorder;
      log.info("prepareSandbox resource ready", {
        scopeId: params.scopeId,
        htmlBytes: Buffer.byteLength(html, "utf8"),
        hasResourceMeta: meta !== null,
        durationMs: Date.now() - startedAt,
      });
      const handle = await dependencies.registerSandbox({
        instance,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ownerWebContentsId: params.ownerWebContentsId,
        sessionId: params.sessionId,
        pluginId: params.pluginId,
        // partition 按 server 身份派生（插件 server 跨工作区共享；普通 MCP server 按工作区隔离）。
        serverName: params.serverName,
        scopeId: params.scopeId,
        html,
        ...(csp ? { csp } : {}),
        // 资源级 `_meta["zcode/csp"]`：unsafe-eval / wasm-unsafe-eval 放宽只认资源自己的声明。
        ...(meta?.cspRelaxations ? { cspRelaxations: meta.cspRelaxations } : {}),
        ...(meta?.permissions ? { permissions: meta.permissions } : {}),
        ...(prefersBorder !== undefined ? { prefersBorder } : {}),
        ...(meta?.heightHint !== undefined ? { heightHint: meta.heightHint } : {}),
        ...(meta?.minFrameHeight !== undefined ? { minFrameHeight: meta.minFrameHeight } : {}),
        ...(meta?.showInline !== undefined ? { showInline: meta.showInline } : {}),
      });
      log.info("prepareSandbox registered", {
        scopeId: params.scopeId,
        sandboxId: handle.sandboxId,
        initId: handle.initId,
        durationMs: Date.now() - startedAt,
      });
      return handle;
    } catch (error) {
      log.warn("prepareSandbox register failed", {
        scopeId: params.scopeId,
        error: error instanceof Error ? error.message : String(error),
      });
      await dependencies.closeInstance?.(bound);
      throw error;
    }
  };

  return {
    async recycleInstance(params) {
      return dependencies.recycleInstance ? dependencies.recycleInstance(params) : false;
    },
    async validateInstance(params) {
      await dependencies.validateInstance?.(params);
    },
    async closeInstance(params) {
      await dependencies.closeInstance?.(params);
    },
    async prepareSandbox(params) {
      if (!dependencies.openInstance) throw unavailable("instance identity");
      const instance = await dependencies.openInstance(params);
      // 合并键来自 Agent 当前连接凭证；断连后的初始化不能复用上一代正在读取的 HTML。
      const key = JSON.stringify([
        instance.runtimeId,
        instance.token,
        instance.generation,
        params.resourceUri,
      ]);
      const existing = preparing.get(key);
      if (existing) return existing;
      const pending = prepareSandboxOnce(params, instance).finally(() => {
        if (preparing.get(key) === pending) preparing.delete(key);
      });
      preparing.set(key, pending);
      return pending;
    },
    async callTool(params, options) {
      if (!dependencies.callMcpToolForUi) {
        throw new PluginUiBridgeError(
          "unavailable",
          "Plugin UI tool calls are unavailable in this runtime",
        );
      }
      return dependencies.callMcpToolForUi(params, options);
    },
    async cancelToolCall(params) {
      // 没有 agent 依赖（web / 远程）时视为无可取消，不报错：取消是 best effort 的收尾动作。
      if (!dependencies.cancelMcpToolCallForUi) return { cancelled: false };
      return dependencies.cancelMcpToolCallForUi(params);
    },
    async readResource(params) {
      if (!dependencies.readMcpResourceForUi) {
        throw new PluginUiBridgeError(
          "unavailable",
          "Plugin UI resource reads are unavailable in this runtime",
        );
      }
      const result = await dependencies.readMcpResourceForUi(params);
      assertUiReadResourceSize(result, params.uri);
      return result;
    },
    async listResources(params) {
      if (!dependencies.listMcpResourcesForUi) throw unavailable("resource listing");
      return dependencies.listMcpResourcesForUi(params);
    },
    async listResourceTemplates(params) {
      if (!dependencies.listMcpResourceTemplatesForUi) throw unavailable("resource listing");
      return dependencies.listMcpResourceTemplatesForUi(params);
    },
    async subscribeResource(params) {
      if (!dependencies.subscribeMcpResourceForUi) throw unavailable("resource subscriptions");
      await dependencies.subscribeMcpResourceForUi(params);
    },
    async unsubscribeResource(params) {
      // 退订是收尾动作：没有依赖时静默成功（与 cancelToolCall 同理）。
      if (!dependencies.unsubscribeMcpResourceForUi) return;
      await dependencies.unsubscribeMcpResourceForUi(params);
    },
    async listSurfaces(params) {
      // web / 远程 workspace 没有本地 agent runtime：没有入口而不是报错，launcher 据此隐藏分组。
      if (!dependencies.listPluginUiSurfaces) return [];
      return (await dependencies.listPluginUiSurfaces(params)).surfaces;
    },
  };
}

function unavailable(feature: string): PluginUiBridgeError {
  return new PluginUiBridgeError(
    "unavailable",
    `Plugin UI ${feature} are unavailable in this runtime`,
  );
}

/**
 * 8 MiB 总量守卫：结果经 MessagePort 结构化克隆进沙箱，
 * agent 侧已按同一常量限流，这里再算一次解码后大小（text 按 UTF-8、blob 按 base64 解码长度）防止旧 agent 漏检。
 */
export function assertUiReadResourceSize(result: ZCodeMcpUiReadResourceResult, uri: string): void {
  let total = 0;
  for (const content of result.contents) {
    if (typeof content.text === "string") total += Buffer.byteLength(content.text, "utf8");
    if (typeof content.blob === "string") total += decodedBase64Length(content.blob);
  }
  if (total > MCP_APPS_UI_READ_RESOURCE_MAX_BYTES) {
    throw new PluginUiBridgeError(
      "resource_too_large",
      `MCP resource ${uri} decodes to ${total} bytes, exceeding the ${MCP_APPS_UI_READ_RESOURCE_MAX_BYTES} byte limit for resources/read`,
    );
  }
}

function decodedBase64Length(value: string): number {
  const trimmed = value.replace(/\s+/g, "");
  if (trimmed.length === 0) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

/** 兼容旧调用：只要 HTML 文本。 */
export function pickHtmlContent(result: ZCodeMcpReadResourceResult, uri: string): string {
  return pickHtmlResource(result, uri).html;
}

const LIST_LEVEL_META_MAX_PAGES = 8;

/**
 * resources/read 的 HTML 项没带 `_meta` 时，翻 resources/list 找同 uri 条目的 `_meta`（最多 8 页）。
 * 列表不可用、翻页失败或找不到都视为"没有声明"，不阻塞沙箱准备。
 */
async function readListLevelResourceMeta(
  list: PluginUiBridgeServiceDependencies["listMcpResourcesForUi"],
  params: PluginUiPrepareSandboxParams & {
    instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  },
): Promise<McpAppResourceMeta | null> {
  if (!list) return null;
  const scope = {
    instance: params.instance,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    sessionId: params.sessionId,
    pluginId: params.pluginId,
    serverName: params.serverName,
  };
  let cursor: string | undefined;
  try {
    for (let page = 0; page < LIST_LEVEL_META_MAX_PAGES; page += 1) {
      const result = await list({ ...scope, ...(cursor ? { cursor } : {}) });
      const entry = result.resources.find((item) => item.uri === params.resourceUri);
      if (entry) return normalizeMcpAppResourceMeta(entry._meta);
      if (!result.nextCursor) return null;
      cursor = result.nextCursor;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 选中实际使用的 HTML 项：遍历 contents，取第一个 mimeType 在 HTML 白名单内的项
 * （同 uri 的优先）；从**该项**的 `_meta` 读资源级 csp / prefersBorder / 尺寸提示。
 * blob、超限一律拒绝，不降级、不截断；没有任何 HTML 项时按第一项的 mimeType 报错。
 */
export function pickHtmlResource(
  result: ZCodeMcpReadResourceResult,
  uri: string,
): { html: string; meta: McpAppResourceMeta | null } {
  if (result.contents.length === 0) {
    throw new PluginUiBridgeError("resource_not_found", `MCP resource has no contents: ${uri}`);
  }
  const isHtml = (mimeType: string | undefined) => {
    const normalized = normalizeMimeType(mimeType);
    return (
      normalized !== null && (MCP_APPS_HTML_MIME_TYPES as readonly string[]).includes(normalized)
    );
  };
  const content =
    result.contents.find((item) => item.uri === uri && isHtml(item.mimeType)) ??
    result.contents.find((item) => isHtml(item.mimeType));
  if (!content) {
    const first = result.contents[0]!;
    throw new PluginUiBridgeError(
      "unsupported_mime_type",
      `MCP resource mimeType is not HTML: ${first.mimeType ?? "(missing)"}`,
    );
  }
  if (typeof content.text !== "string") {
    throw new PluginUiBridgeError(
      "unsupported_mime_type",
      "MCP resource must return HTML as text, blob is not accepted",
    );
  }
  if (Buffer.byteLength(content.text, "utf8") > MCP_APPS_HTML_MAX_BYTES) {
    throw new PluginUiBridgeError(
      "resource_too_large",
      `MCP resource exceeds ${MCP_APPS_HTML_MAX_BYTES} bytes`,
    );
  }
  return { html: content.text, meta: normalizeMcpAppResourceMeta(content._meta) };
}

function normalizeMimeType(value: string | undefined): string | null {
  if (!value) return null;
  // 去掉 charset 等次要参数，但保留 profile=mcp-app 以匹配白名单。
  const parts = value
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && !part.startsWith("charset="));
  return parts.join(";");
}
