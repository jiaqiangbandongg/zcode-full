import type { IServiceAccessor } from "@zcode/services";
import { isRemoteWorkspaceIdentity, type IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import { buildPluginUiSurfaceKey } from "@/plugin-ui/contract.js";
import { resolvePluginUiLogicalScope } from "@/plugin-ui/domain/pluginUiLogicalScope.js";
import { buildPluginUiToolResult } from "@/plugin-ui/domain/pluginUiToolFeed.js";
import { createPage } from "@/plugin-ui/adapters/pluginUiManagedPage.js";
import { acquirePluginUiPage } from "@/plugin-ui/adapters/pluginUiPageRegistry.js";
import type { UsePluginUiHostInput } from "@/plugin-ui/adapters/pluginUiHostTypes.js";

/** 窗口订阅真实工具结果；会话组件卸载不会撤掉创建入口。 */
export function attachPluginUiToolResults(
  services: IServiceAccessor,
  platform: IPlatformService,
  settings: () => Pick<UsePluginUiHostInput, "theme" | "locale">,
): () => void {
  if (!platform.pluginSandbox || !services.pluginUiBridgeService) return () => {};
  let disposed = false;
  const subscription = services.zcodeAgentService.onDynamicPluginUiToolResult()((result) => {
    if (disposed || isRemoteWorkspaceIdentity(result.workspaceIdentity ?? "")) return;
    const presentation = { ...result.ui, serverName: result.serverName };
    const scope = {
      workspacePath: result.workspacePath,
      workspaceIdentity: result.workspaceIdentity,
      sessionId: result.sessionId,
      scope: resolvePluginUiLogicalScope(presentation, {
        kind: "toolCall",
        toolCallId: result.toolCallId,
      }),
    };
    const input: UsePluginUiHostInput = {
      ...settings(),
      presentation,
      scope,
      displayMode: "inline",
      width: 0,
      hostVersion: "zcode",
      toolCallId: result.toolCallId,
      toolInput: result.input,
      toolResult: buildPluginUiToolResult(
        { status: "completed", input: result.input },
        presentation,
      ),
    };
    const key = buildPluginUiSurfaceKey({ ...scope, ...presentation }, scope.scope);
    // 原因：React 工具行未挂载时没有 effect。与前台共用准入，不能另建后台 guest；
    // 后续结果只投喂工具数据，不能覆盖已有侧栏的尺寸、展示模式与交互回调。
    void acquirePluginUiPage(key, () => createPage(key, input, platform, services)).then(
      (page) => {
        if (!disposed) page.updateToolFeed(input);
      },
      (error) =>
        logger.warn("[plugin-ui] background admission failed", {
          sessionId: result.sessionId,
          pluginId: presentation.pluginId,
          error: String(error),
        }),
    );
  });
  return () => {
    disposed = true;
    subscription.dispose();
  };
}
