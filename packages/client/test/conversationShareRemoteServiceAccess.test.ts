import type { IChannel, IChannelClient } from "@zcode/rpc";
import { IConversationShareService } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";

import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

describe("RemoteServiceAccess conversation share", () => {
  it("creates the conversation share proxy on the descriptor channel", () => {
    const requestedChannels: string[] = [];
    const channel: IChannel = {
      call: vi.fn(),
      listen: vi.fn(),
    };
    const channelClient: IChannelClient = {
      getChannel: <T extends IChannel>(channelName: string) => {
        requestedChannels.push(channelName);
        return channel as T;
      },
    };

    const access = new RemoteServiceAccess(channelClient);

    expect(requestedChannels).toContain(IConversationShareService.channelName);
    expect(access.conversationShareService).toBeTruthy();
  });
});
