import { useEffect, useState } from "react";
import {
  parseRemoteWorkspaceIdentity,
  buildRemoteWorkspaceIdentity,
  remoteTargetSchema,
  type IServiceAccessor,
} from "@/workspace-config-catalog/contract.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import {
  ensureSourceSettingsServices,
  useSourceSettingsServices,
} from "@/store/sourceSettingsServiceStore.js";
import { logger } from "@/logger.js";

/** 配置专用解析；不改变 conversation 的 workspace attachment / replay 边界。 */
export function useConfigWorkspaceServicesResolution(
  ...args: Parameters<typeof useWorkspaceServicesResolution>
) {
  const workspace = useWorkspaceServicesResolution(...args);
  const parsed = args[2] && parseRemoteWorkspaceIdentity(args[2]);
  const sourceId = parsed && parsed.kind === "server" ? parsed.sourceServerId : undefined;
  const platform = useOptionalPlatform();
  const sourceServices = useSourceSettingsServices(sourceId);
  const canAttach = Boolean(platform?.requestSourceSettingsAttachment);
  const [binding, setBinding] = useState<{
    services: IServiceAccessor;
    workspaceKey: string;
  } | null>(null);
  const workspacePath = args[0];
  const workspaceKey = args[2]?.trim() || workspacePath || "";
  const target = remoteTargetSchema.safeParse(args[3]);
  const legacyRouteHint =
    target.success && workspacePath
      ? buildRemoteWorkspaceIdentity(workspacePath, target.data)
      : undefined;
  useEffect(() => {
    if (workspace.rpcReady || !canAttach || !sourceServices || !workspacePath) return;
    let current = true;
    // 原因：无 tab 的 Source 配置没有经历 workspace attach，直接写会绕过旧 canonical key。
    // alias admission 完成后才开放该目录的配置 RPC，迟到结果只属于原 attachment/目标。
    void sourceServices.sourceServerWorkspaceService
      .resolveWorkspace({ workspacePath, legacyRouteHint })
      .then(
        () => {
          if (current) setBinding({ services: sourceServices, workspaceKey });
        },
        (error) => {
          if (current) logger.error("[workspace-config-catalog] 绑定配置目录身份失败", error);
        },
      );
    return () => {
      current = false;
    };
  }, [workspace.rpcReady, canAttach, sourceServices, workspacePath, workspaceKey, legacyRouteHint]);
  useEffect(() => {
    if (workspace.rpcReady || !sourceId || !platform?.requestSourceSettingsAttachment) return;
    void ensureSourceSettingsServices(sourceId, platform.requestSourceSettingsAttachment).catch(
      (error) => {
        logger.error("[workspace-config-catalog] 请求远端配置 attachment 失败", error);
      },
    );
  }, [workspace.rpcReady, sourceId, platform]);
  return !workspace.rpcReady &&
    canAttach &&
    sourceServices &&
    binding?.services === sourceServices &&
    binding.workspaceKey === workspaceKey
    ? {
        ...workspace,
        services: sourceServices,
        connectionKind: "remote-ready" as const,
        rpcReady: true,
      }
    : workspace;
}

export function useConfigWorkspaceServices(
  ...args: Parameters<typeof useWorkspaceServicesResolution>
) {
  return useConfigWorkspaceServicesResolution(...args).services;
}
