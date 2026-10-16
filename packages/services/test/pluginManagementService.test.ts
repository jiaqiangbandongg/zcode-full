import { describe, expect, it, vi } from "vitest";
import { createPluginManagementService } from "../src/plugins/pluginManagementService.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

describe("pluginManagementService suggested prompt operations", () => {
  it("forwards trusted resolution and cancellation to the selected Agent service", async () => {
    const progressEvent = vi.fn();
    const onDynamicPluginOperationProgress = vi.fn(() => progressEvent);
    const resolveSuggestedPluginReference = vi.fn(async () => ({
      stableId: "document-skills@zcode-plugins-official",
      status: "missing" as const,
      marketplace: "zcode-plugins-official",
      pluginName: "document-skills",
      sourceTrust: "official" as const,
      diagnostics: [],
    }));
    const cancelPluginOperation = vi.fn(async ({ operationId }: { operationId: string }) => ({
      operationId,
      cancelled: true,
    }));
    const service = createPluginManagementService({
      zcodeAgentService: {
        resolveSuggestedPluginReference,
        cancelPluginOperation,
        onDynamicPluginOperationProgress,
      } as unknown as IZCodeAgentService,
    });

    expect(service.onDynamicPluginOperationProgress("suggested-1")).toBe(progressEvent);

    await expect(
      service.resolveSuggestedPluginReference({
        workspacePath: "/remote/workspace",
        workspaceIdentity: "ssh://host/remote/workspace",
        remoteSessionId: "remote-session-1",
        stableId: "document-skills@zcode-plugins-official",
        operationId: "suggested-1",
        clientMode: "web-remote-replayable",
        deliveryKind: "web-remote-replayable",
      }),
    ).resolves.toMatchObject({ status: "missing" });
    await expect(
      service.cancelPluginOperation({ operationId: "suggested-1" }),
    ).resolves.toEqual({ operationId: "suggested-1", cancelled: true });

    expect(resolveSuggestedPluginReference).toHaveBeenCalledWith({
      workspacePath: "/remote/workspace",
      workspaceIdentity: "ssh://host/remote/workspace",
      remoteSessionId: "remote-session-1",
      stableId: "document-skills@zcode-plugins-official",
      operationId: "suggested-1",
      clientMode: "web-remote-replayable",
      deliveryKind: "web-remote-replayable",
    });
    expect(cancelPluginOperation).toHaveBeenCalledWith({ operationId: "suggested-1" });
    expect(onDynamicPluginOperationProgress).toHaveBeenCalledWith("suggested-1");
  });
});
