import type { RemoteConnectionFlowOptions } from "@/remote-connection-flow/contract.js";
/** 项目向导在设备连通后接管选目录；保存成功前不会准备会话。 */
export function projectConnectionOptions(
  ports: Pick<RemoteConnectionFlowOptions, "onConnect" | "onCancelSession" | "onSelectProject">,
  chooseAndSaveProject: (connectionId: string) => Promise<void>,
): RemoteConnectionFlowOptions {
  return { ...ports, onConnectionReady: chooseAndSaveProject };
}
