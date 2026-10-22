import type { IBroadcastService } from "#src/broadcast/broadcast.js";
import type { IWindowProjectChangesService } from "#src/window-project-directory/contract.js";

export function createWindowProjectChangesService(
  broadcast: Pick<IBroadcastService, "onMessage">,
): IWindowProjectChangesService {
  return {
    getCapabilities: async () => ({ version: 1 }),
    // 远端 scope 曾消费 Source 的项目广播。这里只转发窗口目录变化，不扩大广播读写权限。
    onDidChange: (listener) =>
      broadcast.onMessage((event) => {
        if (event.channel === "state:projects") listener();
      }),
  };
}
