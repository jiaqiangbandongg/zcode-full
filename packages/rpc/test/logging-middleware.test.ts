import { describe, expect, it, vi } from "vitest";
import { Event } from "../src/foundation.js";
import { LoggingChannelServer } from "../src/logging-middleware.js";
import type { IChannelServer, IServerChannel } from "../src/channels.js";

describe("logging middleware", () => {
  it("logs media preview prepare success using the channel and command names", async () => {
    let registeredChannel: IServerChannel<string> | undefined;
    const innerServer: IChannelServer<string> = {
      registerChannel(_channelName, channel) {
        registeredChannel = channel;
      },
    };
    const logs: string[] = [];
    const server = new LoggingChannelServer(innerServer, (message) => {
      logs.push(message);
    });

    server.registerChannel("media-preview", {
      async call() {
        return { kind: "local-url" };
      },
      listen: vi.fn(),
    });

    await registeredChannel?.call("ctx", "prepare", {});

    expect(logs.some((log) => log.startsWith("[rpc:call] media-preview.prepare OK "))).toBe(true);
  });

  it("logs listen failures without reporting a successful subscription", () => {
    let registeredChannel: IServerChannel<string> | undefined;
    const innerServer: IChannelServer<string> = {
      registerChannel(_channelName, channel) {
        registeredChannel = channel;
      },
    };
    const logs: string[] = [];
    const server = new LoggingChannelServer(innerServer, (message) => {
      logs.push(message);
    });

    server.registerChannel("events", {
      call: vi.fn(),
      listen() {
        throw new Error("listen failed");
      },
    });

    expect(registeredChannel).toBeDefined();
    expect(() => registeredChannel?.listen("ctx", "onData")).toThrow("listen failed");
    expect(logs).toContain('[rpc:register] channel "events"');
    expect(logs).toContain("[rpc:listen] events.onData FAIL");
    expect(logs).not.toContain("[rpc:listen] events.onData subscribed");
  });

  it("logs successful listen subscriptions after the inner channel returns", () => {
    let registeredChannel: IServerChannel<string> | undefined;
    const innerServer: IChannelServer<string> = {
      registerChannel(_channelName, channel) {
        registeredChannel = channel;
      },
    };
    const logs: string[] = [];
    const server = new LoggingChannelServer(innerServer, (message) => {
      logs.push(message);
    });

    server.registerChannel("events", {
      call: vi.fn(),
      listen() {
        return Event.None;
      },
    });

    registeredChannel?.listen("ctx", "onData");

    expect(logs).toContain("[rpc:listen] events.onData subscribed");
    expect(logs).not.toContain("[rpc:listen] events.onData FAIL");
  });
});
