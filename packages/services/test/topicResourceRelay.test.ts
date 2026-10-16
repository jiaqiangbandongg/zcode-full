import { afterEach, describe, expect, it, vi } from "vitest";
import { createTopicResourceRelay } from "../src/zcode-agent/topicResourceRelay.js";

const request = {
  requestId: "read-a",
  taskId: "task-a",
  inputId: "input-a",
  authorizationId: "auth-a",
  messageId: "message-a",
  resourceIndex: 0,
  workspacePath: "/work",
  workspaceIdentity: "ssh://host/work",
  remoteSessionId: "remote-a",
};
const file = {
  kind: "file" as const,
  filename: "a.txt",
  mimeType: "text/plain",
  dataBase64: "aGVsbG8=",
};
afterEach(() => vi.useRealTimers());

describe("topic resource reverse transfer", () => {
  it("returns bounded chunks only for the original task and rechecks authorization", async () => {
    const validate = vi.fn(async () => undefined);
    const relay = createTopicResourceRelay({ read: async () => file, validate });
    const metadata = await relay.begin(request);
    expect(metadata).toMatchObject({ bytes: 5, totalChunks: 1 });
    await expect(
      relay.chunk({ requestId: request.requestId, taskId: "other", index: 0 }),
    ).rejects.toThrow();
    expect(
      await relay.chunk({ requestId: request.requestId, taskId: request.taskId, index: 0 }),
    ).toEqual({ dataBase64: "aGVsbG8=" });
    await relay.finish({ requestId: request.requestId, taskId: request.taskId });
    expect(validate).toHaveBeenCalledTimes(4);
    await expect(
      relay.chunk({ requestId: request.requestId, taskId: request.taskId, index: 0 }),
    ).rejects.toThrow();
    relay.dispose();
  });

  it("withholds completion and erases bytes when group authorization is revoked", async () => {
    let enabled = true;
    const relay = createTopicResourceRelay({
      read: async () => file,
      validate: async () => {
        if (!enabled) throw new Error("Group disabled");
      },
    });
    await relay.begin(request);
    enabled = false;
    await expect(
      relay.finish({ requestId: request.requestId, taskId: request.taskId }),
    ).rejects.toThrow("Group disabled");
    expect(relay.cancel({ requestId: request.requestId, taskId: request.taskId })).toBe(false);
    relay.dispose();
  });

  it("aborts in-flight reads on disconnect without releasing a late result", async () => {
    let signal!: AbortSignal;
    let release!: (value: typeof file) => void;
    const relay = createTopicResourceRelay({
      validate: async () => undefined,
      read: async (_request, inputSignal) => {
        signal = inputSignal;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const reading = relay.begin(request);
    await vi.waitFor(() => expect(signal).toBeDefined());
    relay.dispose();
    expect(signal.aborted).toBe(true);
    release(file);
    await expect(reading).rejects.toThrow();
  });

  it("rejects overload without queueing and expires retained resources", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => file);
    const relay = createTopicResourceRelay({ read, validate: async () => undefined });
    await relay.begin(request);
    await relay.begin({ ...request, requestId: "read-b" });
    await expect(relay.begin({ ...request, requestId: "read-c" })).rejects.toThrow("busy");
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(relay.cancel({ requestId: request.requestId, taskId: request.taskId })).toBe(false);
    await relay.begin({ ...request, requestId: "read-c" });
    relay.dispose();
  });

  it("does not let a late cancelled read erase a replacement with the same request id", async () => {
    let release!: (value: typeof file) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(file);
    const relay = createTopicResourceRelay({ read, validate: async () => undefined });
    const old = relay.begin(request);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    relay.cancel({ requestId: request.requestId, taskId: request.taskId });
    await relay.begin(request);
    release(file);
    await expect(old).rejects.toThrow();
    expect(
      await relay.chunk({ requestId: request.requestId, taskId: request.taskId, index: 0 }),
    ).toEqual({ dataBase64: "aGVsbG8=" });
    relay.dispose();
  });
});
