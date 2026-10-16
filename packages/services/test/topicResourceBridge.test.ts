import { describe, expect, it, vi } from "vitest";
import { createTopicResourceBridge } from "../src/zcode-agent/topicResourceBridge.js";

const request = {
  requestId: "request-a",
  taskId: "task-a",
  inputId: "input-a",
  authorizationId: "auth-a",
  messageId: "file-a",
  resourceIndex: 0,
};
describe("topic resource reverse bridge", () => {
  it("withholds the reference when cancelled during the final authorization check", async () => {
    const bridge = createTopicResourceBridge({
      read: async () => ({
        kind: "file",
        filename: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 0,
        dataBase64: "",
      }),
      upload: async () => ({
        ref: "artifact://a",
        fileName: "a.txt",
        mime: "text/plain",
        bytes: 0,
      }),
      validate: async () => {
        bridge.cancel(request);
      },
    });
    await expect(bridge.read(request)).rejects.toThrow("cancelled");
    bridge.dispose();
  });
  it("withholds the reference when authorization expires during upload", async () => {
    const bridge = createTopicResourceBridge({
      read: async () => ({
        kind: "file",
        filename: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 0,
        dataBase64: "",
      }),
      upload: async () => ({
        ref: "artifact://a",
        fileName: "a.txt",
        mime: "text/plain",
        bytes: 0,
      }),
      validate: async () => {
        throw new Error("Group disabled");
      },
    });
    await expect(bridge.read(request)).rejects.toThrow("Group disabled");
    bridge.dispose();
  });
  it("uploads only after an authorized download", async () => {
    const attachment = {
      kind: "file" as const,
      filename: "a.txt",
      mimeType: "text/plain",
      dataBase64: "aGk=",
      sizeBytes: 2,
    };
    const read = vi.fn(async () => attachment);
    const upload = vi.fn(async () => ({
      ref: "artifact://a",
      fileName: "a.txt",
      mime: "text/plain",
      bytes: 2,
    }));
    const bridge = createTopicResourceBridge({ read, upload, validate: async () => undefined });
    expect(await bridge.read(request)).toMatchObject({ ref: "artifact://a" });
    expect(upload).toHaveBeenCalledWith(request, attachment, expect.any(AbortSignal), undefined);
    bridge.dispose();
  });
  it("rejects scope injection before any download", async () => {
    const read = vi.fn();
    const upload = vi.fn();
    const bridge = createTopicResourceBridge({ read, upload, validate: async () => undefined });
    await expect(bridge.read({ ...request, workspacePath: "/other" })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    bridge.dispose();
  });
  it("cancels the matching request without uploading downloaded bytes", async () => {
    let release!: (value: {
      kind: "file";
      filename: string;
      mimeType: string;
      sizeBytes: number;
      dataBase64: string;
    }) => void;
    const upload = vi.fn();
    const bridge = createTopicResourceBridge({
      validate: async () => undefined,
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      upload,
    });
    const result = bridge.read(request);
    expect(bridge.cancel({ ...request, taskId: "other" })).toBe(false);
    expect(bridge.cancel(request)).toBe(true);
    release({
      kind: "file",
      filename: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 0,
      dataBase64: "",
    });
    await expect(result).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
    bridge.dispose();
  });
});
