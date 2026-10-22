import { describe, expect, it, vi } from "vitest";
import { ServiceCollection } from "../src/collection.js";
import { ISettingService } from "../src/setting/setting.js";
import { ISourceServerManagementService } from "../src/source-server-management/sourceServerManagement.js";
import { ITerminalService } from "../src/terminal/terminal.js";

describe("ServiceCollection exposure", () => {
  it("only exposes channels included by an explicit allowlist policy", () => {
    const registerChannel = vi.fn();
    const services = new ServiceCollection()
      .register(ISettingService, {} as never)
      .register(ITerminalService, {} as never)
      .register(ISourceServerManagementService, {} as never);

    services.exposeOnChannelServer({ registerChannel } as never, new Map(), {
      allowedChannels: new Set([ISettingService.channelName]),
    });

    expect(registerChannel.mock.calls.map(([name]) => name)).toEqual([ISettingService.channelName]);
  });
});
