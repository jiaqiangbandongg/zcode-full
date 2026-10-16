import type { IServerChannel } from "@zcode/rpc";
import { describe, expect, it, vi } from "vitest";
import { ServiceCollection } from "../src/collection.js";
import { createServiceDescriptor } from "../src/descriptors.js";

describe("ServiceCollection connection override", () => {
  it("单个 ChannelServer 可覆盖 service，不修改共享 collection", async () => {
    const descriptor = createServiceDescriptor<{ read(): string }>("scoped-test");
    const collection = new ServiceCollection().register(descriptor, {
      read: () => "base",
    });
    const channels = new Map<string, IServerChannel<unknown>>();
    const server = {
      registerChannel: vi.fn(
        (name: string, channel: IServerChannel<unknown>) => {
          channels.set(name, channel);
        },
      ),
    };

    collection.exposeOnChannelServer(
      server as never,
      new Map([[descriptor.channelName, { read: () => "connection-a" }]]),
    );
    expect(
      await channels.get(descriptor.channelName)?.call({}, "read", []),
    ).toBe("connection-a");
    expect(collection.get(descriptor).read()).toBe("base");
  });
});
