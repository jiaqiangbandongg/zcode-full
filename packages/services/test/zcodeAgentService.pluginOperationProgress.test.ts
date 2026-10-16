import { describe, expect, it, vi } from "vitest";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodePluginOperationProgressNotification,
} from "@zcode/shared";

describe("zcodeAgentService Plugin operation progress", () => {
  it("projects a validated Agent progress notification by operationId", async () => {
    let notificationListener:
      | ((notification: { method: string; params?: unknown }) => void)
      | null = null;
    const request = vi.fn(async (method: string) => {
      if (method !== zcodeProtocolMethods.pluginsResolveSuggestedReference) {
        throw new Error(`Unexpected request method: ${method}`);
      }
      notificationListener?.({
        method: zcodeProtocolNotifications.pluginOperationProgress,
        params: { operationId: "suggested-progress", state: "refreshing" },
      });
      return {
        stableId: "document-skills@zcode-plugins-official",
        status: "missing",
        marketplace: "zcode-plugins-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        diagnostics: [],
      };
    });

    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class {
        onRuntimeLifecycle() {
          return { dispose() {} };
        }
        onRuntimeRestarted() {
          return { dispose() {} };
        }
        async getClient() {
          return {
            request,
            transportKind: "stdio",
            onNotification: (
              listener: (notification: { method: string; params?: unknown }) => void,
            ) => {
              notificationListener = listener;
              return { dispose() {} };
            },
            onRequest: () => ({ dispose() {} }),
            onClose: () => ({ dispose() {} }),
          };
        }
        disposeAll() {}
        async disposeAllAndWait() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService();
    const received: ZCodePluginOperationProgressNotification[] = [];
    const subscription = service.onDynamicPluginOperationProgress("suggested-progress")((event) =>
      received.push(event),
    );

    try {
      await service.resolveSuggestedPluginReference({
        workspacePath: "/workspace",
        stableId: "document-skills@zcode-plugins-official",
        operationId: "suggested-progress",
        clientMode: "desktop-continuous",
        deliveryKind: "desktop-continuous",
      });

      expect(received).toEqual([{ operationId: "suggested-progress", state: "refreshing" }]);

      notificationListener?.({
        method: zcodeProtocolNotifications.pluginOperationProgress,
        params: {
          operationId: "suggested-progress",
          state: "refreshing",
          unexpected: true,
        },
      });
      expect(received).toHaveLength(1);
    } finally {
      subscription.dispose();
      await service.disposeAllAndWait();
    }
  });
});
