import type { DynamicWorkflowMode, RemoteTarget } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";

/**
 * 把动态工作流的用户选择推给远程 Host（docs/dynamic-workflow/launch.md「The user's choice」）。
 *
 * desktop-attached remote Host（SSH / WSL / Docker）读不到桌面的设置文件，选择只能由 desktop 推送：
 * 建远程 workspace services 时推一次，本机 Host 收到选择变化信号后再推给本窗口所有在线连接。
 * standalone server 有自己的设置权威，不推。单个连接失败（旧版本不认识该方法、连接已断）只上报，
 * 不影响其它连接，也不阻断远程连接建立。
 */
export async function pushDynamicWorkflowUserModeToRemoteHosts(
  connections: ReadonlyArray<{
    target: RemoteTarget;
    zcodeAgentService: Pick<IZCodeAgentService, "syncDynamicWorkflowUserMode">;
  }>,
  mode: DynamicWorkflowMode | undefined,
  onError: (error: unknown) => void,
): Promise<void> {
  await Promise.all(
    connections
      .filter((connection) => connection.target.kind !== "server")
      .map(async (connection) => {
        try {
          await connection.zcodeAgentService.syncDynamicWorkflowUserMode(mode ? { mode } : {});
        } catch (error) {
          onError(error);
        }
      }),
  );
}
