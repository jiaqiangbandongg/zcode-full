import { describe, expect, it, vi } from "vitest";
import type { IChannel, IChannelClient } from "@zcode/rpc";
import { IMediaPreviewService, IClientConfigService } from "@zcode/services";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

describe("RemoteServiceAccess", () => {
  it("公开配置经独立频道 RPC 读取", async () => {
    const call = vi.fn(async () => ({ pluginStoreOrder: null }));
    const requested: string[] = [];
    const services = new RemoteServiceAccess({
      getChannel: (name) => {
        requested.push(name);
        return { call, listen: vi.fn() } as IChannel;
      },
    });
    expect(await services.clientConfigService.getSnapshot({ forceRefresh: true })).toEqual({
      pluginStoreOrder: null,
    });
    expect(requested).toContain("client-config");
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual(["getSnapshot", [{ forceRefresh: true }]]);
  });
  it("creates the media preview proxy for every remote service connection", () => {
    const channelNames: string[] = [];
    const channel: IChannel = {
      call: vi.fn(),
      listen: vi.fn(),
    };
    const channelClient: IChannelClient = {
      getChannel: (channelName) => {
        channelNames.push(channelName);
        return channel;
      },
    };

    const services = new RemoteServiceAccess(channelClient);

    expect(channelNames).toContain(IMediaPreviewService.channelName);
    expect(services.mediaPreviewService).toBeDefined();
    expect(channelNames).toContain(IClientConfigService.channelName);
    expect(services.clientConfigService).toBeDefined();
  });
});
