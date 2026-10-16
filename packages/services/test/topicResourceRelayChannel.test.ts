import { ChannelClient, ChannelServer, createQueuePair } from "@zcode/rpc";
import { TOPIC_RESOURCE_RELAY_CHANNEL } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { createTopicResourceRelayChannel } from "../src/zcode-agent/topicResourceRelayChannel.js";
import { readTopicResourceFromRelay } from "../src/zcode-agent/topicResourceRelayClient.js";

describe("private topic resource reverse RPC", () => {
  it("transfers through a private channel while enforcing the owning workspace", async () => {
    const [hostProtocol, remoteProtocol] = createQueuePair();
    const host = new ChannelServer(hostProtocol, "host");
    const remote = new ChannelClient(remoteProtocol);
    const bridge = createTopicResourceRelayChannel({
      validate: async (request) => {
        if (request.workspaceIdentity !== "ssh://owner/work") throw new Error("Foreign workspace");
      },
      read: async () => ({
        kind: "file",
        filename: "a.txt",
        mimeType: "text/plain",
        dataBase64: "aGk=",
      }),
    });
    host.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, bridge.channel);
    const channel = remote.getChannel(TOPIC_RESOURCE_RELAY_CHANNEL);
    const request = {
      requestId: "request",
      taskId: "task",
      inputId: "input",
      authorizationId: "auth",
      messageId: "message",
      resourceIndex: 0,
      workspacePath: "/work",
      workspaceIdentity: "ssh://owner/work",
      remoteSessionId: "remote",
    };
    try {
      expect(
        await readTopicResourceFromRelay(channel, request, new AbortController().signal),
      ).toMatchObject({ dataBase64: "aGk=" });
      await expect(
        channel.call("validate", { ...request, workspaceIdentity: "ssh://other/work" }),
      ).rejects.toThrow("Foreign workspace");
      await expect(channel.call("arbitrary-method", request)).rejects.toThrow();
    } finally {
      bridge.dispose();
      host.dispose();
      remote.dispose();
    }
  });
});
