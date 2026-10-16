import { METHOD_NOT_FOUND, ProtocolError } from "@modelcontextprotocol/client";
import { EmptyResultSchema } from "@modelcontextprotocol/core";
import { McpUiMessageResultSchema } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpAppsDownloadFileItem,
  PluginSandboxHandle,
  PluginSandboxPlatformPort,
} from "@zcode/shared/mcp-apps";
import { MCP_APPS_SET_WIDGET_STATE_METHOD, concatMcpAppsTextContent } from "@zcode/shared/mcp-apps";
import { z } from "zod";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";

/** 宿主实例注入的交互回调；缺省时对应请求回 -32601（能力声明与回调一一对应）。 */
export interface PluginUiInteractionCallbacks {
  /** sendFollowUpMessage 返回 reject 表示用户取消或无权限。 */
  onSendFollowUpMessage?(
    payload: {
      prompt: string;
      content?: Array<Record<string, unknown>>;
      structuredContent?: unknown;
    },
    context: { consumeUserGesture(): Promise<boolean>; assertCurrent(): void },
  ): Promise<void>;
  onUpdateModelContext?(payload: {
    content: Array<Record<string, unknown>>;
    structuredContent?: unknown;
  }): Promise<void>;
  /** 页面 `ui/set-widget-state { widgetState }`；宿主同步写内存 store 后回包。 */
  onUpdateWidgetState?(widgetState: unknown): Promise<void>;
  /** `ui/download-file`；逐项保存，取消 / 失败回 `{ isError: true }`。 */
  onDownloadFile?(contents: McpAppsDownloadFileItem[]): Promise<{ isError?: boolean }>;
}

/**
 * `ui/message` 的参数：官方 schema 只认 role + content，会剥掉顶层未知键；扩展的 `structuredContent`
 * 要留下来（拼成 ```json 块随消息发出），所以宿主用自己的 loose schema 注册这个方法，而不是 `onmessage`。
 */
const pluginUiMessageParamsSchema = z
  .object({
    role: z.literal("user"),
    content: z.array(z.record(z.string(), z.unknown())).min(1),
    structuredContent: z.unknown().optional(),
  })
  .loose();
const pluginUiSetWidgetStateParamsSchema = z.object({ widgetState: z.unknown() }).loose();

/** 回调抛出的带 `code` 的错误（-32601 / -32000 / -32602）翻译成 JSON-RPC 错误，其余按内部错误处理。 */
function toProtocolError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof ProtocolError) return error;
  if (error instanceof Error && typeof code === "number")
    return new ProtocolError(code, error.message);
  return error;
}
const unsupported = (method: string) =>
  new ProtocolError(METHOD_NOT_FOUND, `${method} is not available for this app`);

/**
 * 会话交互（ui/message、ui/update-model-context、ui/download-file、ZCode 扩展 ui/set-widget-state）接到官方
 * AppBridge：缺省回调回 -32601；ui/message 的手势 token 由 main 在 guest input-event 记录、一次性消费，没有句柄视为无手势。
 */
export function wirePluginUiInteractions(
  bridge: PluginUiHostBridge,
  deps: PluginUiInteractionCallbacks,
  platform: Pick<PluginSandboxPlatformPort, "consumeUserGesture">,
  currentHandle: () => PluginSandboxHandle | null,
): void {
  bridge.setRequestHandler(
    "ui/message",
    { params: pluginUiMessageParamsSchema, result: McpUiMessageResultSchema },
    async (rawParams) => {
      if (!deps.onSendFollowUpMessage) throw unsupported("ui/message");
      const params = rawParams as z.infer<typeof pluginUiMessageParamsSchema>;
      const handle = currentHandle();
      const assertCurrent = () => {
        if (!handle || currentHandle()?.instance.token !== handle.instance.token)
          throw new Error("MCP App instance was closed");
      };
      assertCurrent();
      try {
        await deps.onSendFollowUpMessage(
          {
            prompt: concatMcpAppsTextContent(params.content),
            content: params.content,
            ...(params.structuredContent !== undefined
              ? { structuredContent: params.structuredContent }
              : {}),
          },
          {
            assertCurrent,
            consumeUserGesture: () =>
              handle ? platform.consumeUserGesture(handle.sandboxId) : Promise.resolve(false),
          },
        );
      } catch (error) {
        throw toProtocolError(error);
      }
      return {};
    },
  );
  bridge.onupdatemodelcontext = async (params) => {
    if (!currentHandle()) throw new Error("MCP App instance was closed");
    if (!deps.onUpdateModelContext) throw unsupported("ui/update-model-context");
    try {
      await deps.onUpdateModelContext({
        content: (params.content ?? []) as Array<Record<string, unknown>>,
        ...(params.structuredContent !== undefined
          ? { structuredContent: params.structuredContent }
          : {}),
      });
    } catch (error) {
      throw toProtocolError(error);
    }
    return {};
  };
  bridge.ondownloadfile = async (params) => {
    if (!deps.onDownloadFile) throw unsupported("ui/download-file");
    try {
      return await deps.onDownloadFile(params.contents as McpAppsDownloadFileItem[]);
    } catch (error) {
      throw toProtocolError(error);
    }
  };
  bridge.setRequestHandler(
    MCP_APPS_SET_WIDGET_STATE_METHOD,
    { params: pluginUiSetWidgetStateParamsSchema, result: EmptyResultSchema },
    async (rawParams) => {
      if (!currentHandle()) throw new Error("MCP App instance was closed");
      if (!deps.onUpdateWidgetState) throw unsupported(MCP_APPS_SET_WIDGET_STATE_METHOD);
      const params = rawParams as z.infer<typeof pluginUiSetWidgetStateParamsSchema>;
      await deps.onUpdateWidgetState(params.widgetState);
      return {};
    },
  );
}
