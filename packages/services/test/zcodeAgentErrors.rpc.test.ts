import { ChannelClient, ChannelServer, createQueuePair, ProxyChannel } from "@zcode/rpc";
import { describe, expect, it } from "vitest";
import { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import {
  ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
  ZCodeAgentMcpStatusModeUnsupportedError,
} from "#src/zcode-agent/zcodeAgentErrors.js";

describe("ZCode Agent RPC errors", () => {
  it("preserves the MCP status-only unsupported code across ChannelClient RPC", async () => {
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test");
    const client = new ChannelClient(clientProtocol);
    server.registerChannel(
      IZCodeAgentService.channelName,
      ProxyChannel.fromService({
        async listMcpServerStatuses() {
          throw new ZCodeAgentMcpStatusModeUnsupportedError();
        },
      }),
    );
    const service = ProxyChannel.toService<IZCodeAgentService>(
      client.getChannel(IZCodeAgentService.channelName),
    );

    try {
      await expect(
        service.listMcpServerStatuses({
          mcpServers: [],
          mode: "status",
          workspacePath: "/tmp/workspace",
        }),
      ).rejects.toMatchObject({
        code: ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
        name: "ZCodeAgentMcpStatusModeUnsupportedError",
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });
});
