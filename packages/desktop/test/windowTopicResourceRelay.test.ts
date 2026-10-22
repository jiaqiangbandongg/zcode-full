import { describe, expect, it, vi } from "vitest";
import { ServiceCollection, IZCodeAgentService, type IBotsService } from "@zcode/services";
import { createWindowTopicResourceRelay } from "../src/host/windowTopicResourceRelay.js";

const request = {
  requestId: "r",
  taskId: "t",
  inputId: "i",
  authorizationId: "a",
  messageId: "m",
  resourceIndex: 0,
  workspacePath: "/work",
  workspaceIdentity: "ssh://host/work",
  remoteSessionId: "remote",
};
describe("window topic resource authority", () => {
  it("binds channel sends to the physical remote connection", async () => {
    const peer = new ServiceCollection().register(IZCodeAgentService, {} as never);
    const other = new ServiceCollection().register(IZCodeAgentService, {} as never);
    let current = peer;
    const reply = vi.fn(async () => ({
      status: "sent",
      deliveryId: "d",
      providerMessageId: "om_sent",
    }));
    const relay = createWindowTopicResourceRelay({
      getPeerAgentService: () => peer.get(IZCodeAgentService),
      resolveServices: () => current,
      getBots: () =>
        ({
          readTopicResource: vi.fn(),
          validateTopicResource: vi.fn(),
          replyToChannel: reply,
        }) as unknown as IBotsService,
    });
    const value = {
      taskId: "t",
      inputId: "i",
      authorizationId: "a",
      toolCallId: "call",
      parts: [{ type: "mention", refId: "m1" }],
      workspacePath: "/work",
      workspaceIdentity: "ssh://host/work",
      remoteSessionId: "remote",
      trace: { traceId: "trace" },
    };
    expect(await relay.channel.call("host", "reply", value)).toMatchObject({ status: "sent" });
    expect(reply).toHaveBeenCalledWith(value);
    current = other;
    await expect(relay.channel.call("host", "reply", value)).rejects.toThrow("connection");
    expect(reply).toHaveBeenCalledTimes(1);
    relay.dispose();
  });
  it("rejects a request resolved to another remote connection before Bot IO", async () => {
    const read = vi.fn();
    const validate = vi.fn();
    const peer = new ServiceCollection().register(IZCodeAgentService, {} as never);
    const other = new ServiceCollection().register(IZCodeAgentService, {} as never);
    const relay = createWindowTopicResourceRelay({
      getPeerAgentService: () => peer.get(IZCodeAgentService),
      resolveServices: () => other,
      getBots: () =>
        ({ readTopicResource: read, validateTopicResource: validate }) as unknown as IBotsService,
    });
    await expect(relay.channel.call("host", "begin", request)).rejects.toThrow("connection");
    expect(read).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    relay.dispose();
  });
  it("uses the current logical session and rechecks it after download", async () => {
    const peer = new ServiceCollection().register(IZCodeAgentService, {} as never);
    let online = true;
    const resolve = vi.fn(() => {
      if (!online) throw new Error("Disconnected");
      return peer;
    });
    const relay = createWindowTopicResourceRelay({
      getPeerAgentService: () => peer.get(IZCodeAgentService),
      resolveServices: resolve,
      getBots: () =>
        ({
          validateTopicResource: async () => undefined,
          readTopicResource: async () => {
            online = false;
            return { kind: "file", filename: "a.txt", mimeType: "text/plain", dataBase64: "aGk=" };
          },
        }) as unknown as IBotsService,
    });
    await expect(relay.channel.call("host", "begin", request)).rejects.toThrow("Disconnected");
    expect(resolve).toHaveBeenCalledWith({
      kind: "remote",
      remoteSessionId: "remote",
      workspaceIdentity: "ssh://host/work",
      workspacePath: "/work",
    });
    relay.dispose();
  });
});
