// 设备导航验证用桌面 RPC 替身；复用真实帧协议，不模拟 UI 或修改产品模块。
import { createAcknowledgedWebRemoteControlRelayProtocol } from "@zcode/client";
import * as contracts from "../../../../../services/src/index.ts";
import { ChannelServer, Event } from "../../../../../rpc/src/index.ts";

export function createDeviceSwitchDesktopBridge(
  socket,
  bridge,
  { locale, theme, responses = {}, events = {} },
) {
  const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
    bridgeSessionId: bridge.bridgeSessionId,
    bridgeGeneration: bridge.bridgeGeneration,
    sendFrame: (payload) => {
      socket.send(JSON.stringify({ type: "data", payload }));
      return true;
    },
  });
  const server = new ChannelServer(adapter.protocol, "device-switch-e2e");
  const replies = {
    [`${contracts.ISettingService.channelName}:get`]: {
      locale,
      theme,
      recentProjects: [],
      onboardingOccupation: "other",
    },
    [`${contracts.IOAuthService.channelName}:getProviders`]: [],
    [`${contracts.IOAuthService.channelName}:getActiveProvider`]: null,
    [`${contracts.IOAuthService.channelName}:restoreCachedSession`]: null,
    [`${contracts.IOAuthService.channelName}:restoreSession`]: null,
    [`${contracts.IOAuthService.channelName}:restoreCachedSessionState`]: { status: "signed-out" },
  };
  for (const value of Object.values(contracts)) {
    if (!value || typeof value !== "object" || typeof value.channelName !== "string") continue;
    const channel = value.channelName;
    server.registerChannel(channel, {
      listen: (_ctx, event) => events[`${channel}:${event}`] ?? Event.None,
      call: async (_ctx, command, args) => {
        const key = `${channel}:${command}`;
        if (Object.hasOwn(responses, key)) {
          const response = responses[key];
          return typeof response === "function" ? response(...(args ?? [])) : response;
        }
        if (Object.hasOwn(replies, key)) return replies[key];
        if (["initialize", "initializeWorkspace"].includes(command))
          return { available: false, workspaceKey: bridge.workspaceKey };
        if (
          [
            "listTasks",
            "listPinnedTaskIds",
            "listPinnedTasks",
            "listArchivedTasks",
            "list",
            "getProviders",
            "getMcpServers",
            "getCustomAgents",
            "getCommands",
            "getSkills",
            "getBuiltinCommands",
          ].includes(command)
        )
          return [];
        if (command === "listTaskList") return { items: [], total: 0, hasMore: false };
        // 项目侧栏（手机 home 与宽屏共用）读取远端项目目录；本用例只验证设备切换，返回空目录。
        if (command === "readDirectory") return { hosts: [], entries: [] };
        if (command === "readTree") return { projects: [], tasks: [] };
        if (
          [
            "getTaskMeta",
            "getTaskSnapshot",
            "load",
            "getActiveProvider",
            "getSelection",
            "shouldOnboard",
          ].includes(command)
        )
          return null;
        if (command === "getView" || command === "refresh") return { revision: 0, providers: [] };
        if (command === "getWorkspaceSummary")
          return {
            workspacePath: bridge.workspacePath,
            isRepository: false,
            isGitAvailable: false,
            autoRefreshWatchPaths: [],
          };
        if (command === "getWorkspacePath") return bridge.workspacePath;
        if (command === "getDeviceId") return "e2e-desktop";
        if (command === "ensureDefaultProject")
          return { path: bridge.workspacePath, created: false };
        if (
          [
            "update",
            "send",
            "track",
            "report",
            "releaseWorkspacePreparation",
            "watch",
            "disposeAll",
          ].includes(command)
        )
          return undefined;
        // 非导航相关初始化仍显式拒绝，避免把缺少桌面响应伪装为测试成功。
        throw new Error(`Device switch fixture does not implement ${key}`);
      },
    });
  }
  return {
    acceptPayload: (payload) => adapter.acceptPayload(payload),
    dispose: () => {
      server.dispose();
      adapter.dispose();
    },
  };
}
