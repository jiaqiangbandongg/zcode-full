import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { logger } from "@/logger.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import type { IZCodeTaskService } from "@zcode/services";

interface WorkspaceProviderConfigFileState {
  path: string | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

const INITIAL_STATE: WorkspaceProviderConfigFileState = {
  path: null,
  exists: false,
  loading: true,
  error: null,
};

type WorkspaceProviderConfigServiceScope = "workspace" | "base";

export function resolveWorkspaceProviderConfigZCodeService(params: {
  configuredServiceScope: WorkspaceProviderConfigServiceScope;
  workspaceZCodeService: IZCodeTaskService;
  baseZCodeService: IZCodeTaskService | null;
  remoteSessionId: string | null;
}): IZCodeTaskService | null {
  if (params.configuredServiceScope === "workspace") {
    return params.workspaceZCodeService;
  }

  if (params.baseZCodeService) {
    return params.baseZCodeService;
  }

  // Bugfix: 远程 workspace 下如果误回退到 workspaceZCodeService，
  // “前往配置”会读到远端绝对路径（如 /root/...），本机无法正确打开。
  // 这里在远程会话里严格要求 baseZCodeService，就绪前先等待，不再冒险走错误 fallback。
  if (params.remoteSessionId) {
    return null;
  }

  return params.workspaceZCodeService;
}

/**
 * 读取当前 workspace + provider 的主配置文件路径。
 *
 * 统一通过 zcodeTaskService 获取路径规则，避免 UI 层拼接 provider 配置路径。
 */
export function useWorkspaceProviderConfigFile(
  workspacePath: string,
  provider: ZCodeProvider,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string,
  options?: {
    serviceScope?: "workspace" | "base";
    enabled?: boolean;
  },
) {
  const workspaceZCodeService = useZCodeTaskService(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const configuredServiceScope = options?.serviceScope ?? "workspace";
  const enabled = options?.enabled ?? true;
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const baseZCodeService = useRemoteWorkspaceSessionStore(
    (state) => state.baseServices?.zcodeTaskService ?? null,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId,
  });
  const zcodeTaskService = resolveWorkspaceProviderConfigZCodeService({
    configuredServiceScope,
    workspaceZCodeService,
    baseZCodeService,
    remoteSessionId,
  });
  const zcodeServiceScope =
    configuredServiceScope === "base"
      ? "base"
      : remoteSessionId && workspaceZCodeService !== baseZCodeService
        ? "remote"
        : "base";
  const [state, setState] =
    useState<WorkspaceProviderConfigFileState>(INITIAL_STATE);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestVersionRef = useRef(0);

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    let disposed = false;

    if (!workspacePath || !enabled || !workspaceRpcEnabled) {
      requestVersionRef.current += 1;
      // Bugfix: 恢复断连远端 workspace 时，provider 配置路径读取不能抢在 remote session
      // 绑定前访问断连代理，否则会把 ZCODE_REMOTE_WORKSPACE_DISCONNECTED 记录成配置读取失败。
      setState({
        path: null,
        exists: false,
        loading: false,
        error: null,
      });
      return () => {
        disposed = true;
      };
    }

    if (!zcodeTaskService) {
      requestVersionRef.current += 1;
      setState({
        path: null,
        exists: false,
        loading: true,
        error: null,
      });
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    // Bugfix: provider 切换时如果保留旧 path，用户会在新请求返回前误点到上一个 provider 的配置文件。
    // 这里在发起请求时立即清空 path/exists，配合 requestVersion 仅接受最新响应，避免旧结果回写。
    setState({
      path: null,
      exists: false,
      loading: true,
      error: null,
    });

    logger.info(
      `[useWorkspaceProviderConfigFile] 开始读取 provider 配置路径 workspace=${workspacePath} provider=${provider} scope=${zcodeServiceScope} session=${remoteSessionId ?? "none"}`,
    );

    void zcodeTaskService
      .getWorkspaceProviderConfigFile({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        provider,
      })
      .then((result) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        logger.info(
          `[useWorkspaceProviderConfigFile] 读取 provider 配置路径成功 workspace=${workspacePath} provider=${provider} scope=${zcodeServiceScope} session=${remoteSessionId ?? "none"} exists=${result.exists} path=${result.path}`,
        );

        setState({
          path: result.path,
          exists: result.exists,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useWorkspaceProviderConfigFile] 读取 provider 配置路径失败", {
          workspacePath,
          provider,
          scope: zcodeServiceScope,
          remoteSessionId,
          error: message,
        });
        setState({
          path: null,
          exists: false,
          loading: false,
          error: message,
        });
      });

    return () => {
      disposed = true;
    };
  }, [
    zcodeTaskService,
    zcodeServiceScope,
    enabled,
    provider,
    refreshVersion,
    remoteSessionId,
    workspaceIdentity,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  // Bugfix: provider 配置状态会继续作为 Shell/Header/Menu props 透传。
  // 字段未变时复用返回对象，避免父级无关重渲让下游 memo 组件误判配置状态变化。
  return useMemo(
    () => ({
      ...state,
      refresh,
    }),
    [refresh, state],
  );
}
