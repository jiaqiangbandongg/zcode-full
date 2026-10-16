import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { IChannel } from "@zcode/rpc";
import { readTopicResourceFromRelay } from "../src/zcode-agent/topicResourceRelayClient.js";
import { TOPIC_RESOURCE_RELAY_CHUNK_BYTES } from "@zcode/shared";

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
describe("topic resource reverse transfer client", () => {
  it("assembles bounded chunks and verifies the file before returning it", async () => {
    const data = Buffer.alloc(TOPIC_RESOURCE_RELAY_CHUNK_BYTES + 7, 65);
    const call = vi.fn(async (command: string, value: { index?: number }) => {
      if (command === "begin")
        return {
          fileName: "a.txt",
          mime: "text/plain",
          bytes: data.length,
          totalChunks: 2,
          checksum: `sha256:${createHash("sha256").update(data).digest("hex")}`,
        };
      if (command === "chunk")
        return {
          dataBase64: data
            .subarray(
              value.index! * TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
              (value.index! + 1) * TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
            )
            .toString("base64"),
        };
      return { completed: true };
    });
    const output = await readTopicResourceFromRelay(
      { call } as unknown as IChannel,
      request,
      new AbortController().signal,
    );
    expect(output.dataBase64).toBe(data.toString("base64"));
    expect(call.mock.calls.map(([command]) => command)).toEqual([
      "begin",
      "chunk",
      "chunk",
      "finish",
    ]);
  });
  it("rejects corrupted bytes and cancels instead of finishing the transfer", async () => {
    const call = vi.fn(async (command: string) => {
      if (command === "begin")
        return {
          fileName: "a.txt",
          mime: "text/plain",
          bytes: 1,
          totalChunks: 1,
          checksum: `sha256:${createHash("sha256").update("a").digest("hex")}`,
        };
      return { dataBase64: "Yg==" };
    });
    await expect(
      readTopicResourceFromRelay(
        { call } as unknown as IChannel,
        request,
        new AbortController().signal,
      ),
    ).rejects.toThrow("checksum");
    expect(call.mock.calls.map(([command]) => command)).toEqual(["begin", "chunk", "cancel"]);
  });
});
