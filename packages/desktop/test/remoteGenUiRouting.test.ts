import { describe, expect, it, vi } from "vitest";
import { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@zcode/rpc";
import { IGenUiService, ServiceCollection, type IServiceAccessor } from "@zcode/services";
import { REMOTE_WORKSPACE_RPC_CHANNELS } from "@desktop/host/remoteWorkspaceRpcContract.js";
import { createServerRemoteWorkspaceServiceCollection } from "@desktop/host/remoteWorkspaceServiceCollection.js";
import { resolveWindowHostServiceExposurePolicy } from "@desktop/host/windowHostAttachmentRpcPolicy.js";
import { buildRemoteWorkspaceSessionServicesForRegistration } from "@desktop/renderer/src/remoteWorkspaceSessionServices.js";

const target = {
  workspacePath: "/workspace/project",
  workspaceIdentity: "ssh:example.test:/workspace/project",
  sessionId: "fork-session",
  path: "/root/.zcode/v2/visualizations/parent/view.html",
};

function genUiService(): IGenUiService {
  return {
    readDocument: vi.fn(async (input) => ({ path: input.path, html: "<p>Remote view</p>" })),
    prepareSandbox: vi.fn(),
    getState: vi.fn(async () => null),
    setState: vi.fn(async () => {}),
    listState: vi.fn(async () => []),
    onStateChanged: vi.fn(() => ({ dispose() {} })),
  };
}

function connect(services: ServiceCollection) {
  const [serverProtocol, clientProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "gen-ui-routing", 50);
  const client = new ChannelClient(clientProtocol);
  services.exposeOnChannelServer(server);
  return {
    service: ProxyChannel.toService<IGenUiService>(client.getChannel(IGenUiService.channelName)),
    dispose() {
      client.dispose();
      server.dispose();
    },
  };
}

describe("remote Gen UI routing", () => {
  it.each(["ssh", "wsl", "docker", "server"] as const)(
    "%s forwards document reads through both RPC hops without desktop fallback",
    async (targetKind) => {
      const source = genUiService();
      const desktop = genUiService();
      vi.mocked(desktop.readDocument).mockRejectedValue(
        new Error("Gen UI file is outside the host output directory"),
      );
      const sourceRpc = connect(new ServiceCollection().register(IGenUiService, source));
      const connectionServices = {
        ...Object.fromEntries(REMOTE_WORKSPACE_RPC_CHANNELS.map((key) => [key, {}])),
        genUiService: sourceRpc.service,
      } as unknown as IServiceAccessor;
      const host = createServerRemoteWorkspaceServiceCollection({
        targetKind,
        connectionServices,
        clientConfigService: { getSnapshot: vi.fn(async () => ({ pluginStoreOrder: null })) },
      });
      const rendererRpc = connect(host);
      try {
        const services = buildRemoteWorkspaceSessionServicesForRegistration({
          baseServices: { genUiService: desktop } as IServiceAccessor,
          remoteServices: { genUiService: rendererRpc.service } as IServiceAccessor,
          targetKind,
          sourceServerId: "source-example",
        });
        await expect(services.genUiService!.readDocument(target)).resolves.toEqual({
          path: target.path,
          html: "<p>Remote view</p>",
        });
        expect(source.readDocument).toHaveBeenCalledExactlyOnceWith(target);
        expect(desktop.readDocument).not.toHaveBeenCalled();
        vi.mocked(source.readDocument).mockRejectedValueOnce(new Error("remote file unavailable"));
        await expect(services.genUiService!.readDocument(target)).rejects.toThrow(
          "remote file unavailable",
        );
        expect(desktop.readDocument).not.toHaveBeenCalled();
      } finally {
        rendererRpc.dispose();
        sourceRpc.dispose();
      }
    },
  );

  it("uses the remote reader for legacy SSH service merging", async () => {
    const desktop = genUiService(),
      source = genUiService();
    const rpc = connect(new ServiceCollection().register(IGenUiService, source));
    try {
      const services = buildRemoteWorkspaceSessionServicesForRegistration({
        baseServices: { genUiService: desktop } as IServiceAccessor,
        remoteServices: { genUiService: rpc.service } as IServiceAccessor,
        targetKind: "ssh",
      });
      await services.genUiService!.readDocument(target);
      expect(source.readDocument).toHaveBeenCalledExactlyOnceWith(target);
      expect(desktop.readDocument).not.toHaveBeenCalled();
    } finally {
      rpc.dispose();
    }
  });

  it("keeps Gen UI outside the mobile replayable channel surface", () => {
    expect(
      resolveWindowHostServiceExposurePolicy("web-remote-replayable")?.allowedChannels.has(
        IGenUiService.channelName,
      ),
    ).toBe(false);
  });
});
