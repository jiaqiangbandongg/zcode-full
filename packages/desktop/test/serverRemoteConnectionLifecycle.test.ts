import { once } from "node:events";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "@zcode/server";
import { ISystemService, ServiceCollection } from "@zcode/services";
import {
  connectServerRemote,
  connectServerRemoteOverDuplex,
  type ServerRemoteConnection,
} from "@desktop/host/serverRemoteConnection.js";
import { ProviderProvisioningEnvironmentCoordinator } from "@desktop/main/providerProvisioningEnvironmentCoordinator.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe.each(["websocket", "duplex"] as const)("%s RPC connection lifecycle", (transport) => {
  it.each(["dispose", "peer-close"] as const)(
    "%s rejects pending RPC and releases the Environment lane for a new connection",
    async (termination) => {
      const entered = Promise.withResolvers<void>();
      const lateResponse = Promise.withResolvers<void>();
      let holdNextRequest = false;
      const info = vi.fn(async () => {
        if (holdNextRequest) {
          holdNextRequest = false;
          entered.resolve();
          await lateResponse.promise;
        }
        return { homedir: "/home/dev", platform: "linux" };
      });
      const server = createHttpServer(
        new ServiceCollection().register(ISystemService, {
          info,
          listIntegratedTerminalShells: async () => [],
          probeIntranet: async () => {
            throw new Error("unused");
          },
        }),
        0,
        { serverId: "rpc-lifecycle", authRequired: true, authToken: "test-ingress" },
      );
      const peerSockets: Duplex[] = [];
      server.on("upgrade", (_request, socket) => peerSockets.push(socket));
      const connections: ServerRemoteConnection[] = [];
      cleanups.push(async () => {
        lateResponse.resolve();
        for (const connection of connections) connection.dispose();
        for (const socket of peerSockets) socket.destroy();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      });
      if (!server.listening) await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TCP address unavailable");
      const connect = async () => {
        const connection =
          transport === "websocket"
            ? await connectServerRemote({
                kind: "server",
                url: `http://127.0.0.1:${address.port}`,
                token: "test-ingress",
              })
            : await connectServerRemoteOverDuplex({
                ingressToken: "test-ingress",
                createConnection: async () => {
                  const socket = createConnection(address.port, "127.0.0.1");
                  await once(socket, "connect");
                  return socket;
                },
              });
        connections.push(connection);
        return connection;
      };

      const coordinator = new ProviderProvisioningEnvironmentCoordinator();
      const firstConnection = await connect();
      const oldRequestRejected = vi.fn();
      const first = coordinator.register("source-environment", "old-session", async () => {
        // 用真实 RPC 控制同步完成时刻，不伪造 coordinator 或连接关闭行为。
        try {
          await firstConnection.services.systemService.info();
        } catch (error) {
          oldRequestRejected(error);
          throw error;
        }
      });
      await first.initialSync;
      holdNextRequest = true;
      const save = coordinator.requestAll("personal-config");
      await entered.promise;
      first.dispose();
      if (termination === "dispose") firstConnection.dispose();
      else peerSockets[0]!.destroy();

      await vi.waitFor(() => {
        expect(oldRequestRejected).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ name: "ConnectionClosed" }),
        );
      });
      await save;
      firstConnection.dispose();
      firstConnection.dispose();
      await expect(firstConnection.services.systemService.info()).rejects.toThrow(
        "ChannelClient is disposed",
      );

      // 旧结果尚未释放时，新一代必须可同步；不能靠旧响应或延迟清空 lane。
      const secondConnection = await connect();
      const syncLatest = vi.fn(async () => {
        await secondConnection.services.systemService.info();
      });
      const second = coordinator.register("source-environment", "new-session", syncLatest);
      await second.initialSync;
      expect(syncLatest).toHaveBeenCalledOnce();
      lateResponse.resolve();
      await expect(secondConnection.services.systemService.info()).resolves.toEqual({
        homedir: "/home/dev",
        platform: "linux",
      });
      expect(oldRequestRejected).toHaveBeenCalledOnce();
      second.dispose();
    },
  );
});
