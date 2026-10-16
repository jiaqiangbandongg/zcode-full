import { describe, expect, it, vi } from "vitest";
import type { BotContextState, BotsStateFile } from "@zcode/shared";
import { readAuthorizedTopicResource } from "../src/bots/topicResource.js";
import {
  feishuConfig,
  createBotsService,
  createCredentialService,
  createLegacyTaskService,
  createMemoryRepo,
} from "./botsService.fixtures.js";

function setup() {
  const group = {
    chatId: "chat-a",
    name: "Test",
    ownerId: "ou_user",
    enabled: true,
    authorizationId: "auth-a",
    taskIds: ["task-a"],
    currentOptions: {},
  };
  const topic: BotContextState = {
    botId: "feishu-1",
    workspacePath: "/workspace",
    workspaceIdentity: "remote:ssh:a",
    mode: "task",
    activeTaskId: "task-a",
    updatedAt: 1,
    group: {
      ...group,
      threadId: "thread-a",
      inputs: {
        "input-a": {
          taskId: "task-a",
          admission: "accepted",
          source: {
            provider: "feishu",
            botId: "feishu-1",
            chatId: "chat-a",
            threadId: "thread-a",
            messageId: "mention-a",
            senderId: "member",
            senderName: "Member",
            authorizationId: "auth-a",
            topicContext: {
              checkpoint: "mention-a",
              hasGap: false,
              messages: [
                {
                  id: "file-a",
                  chatId: "chat-a",
                  threadId: "thread-a",
                  senderId: "member",
                  senderType: "user",
                  text: "[file: example.txt]",
                  kind: "file",
                  createdAt: 1,
                },
              ],
            },
          },
        },
      },
    },
  };
  const parent: BotContextState = { ...topic, group: { ...group, historyEnabled: true } };
  const state: BotsStateFile = { version: 2, bots: { parent, topic } };
  const config = structuredClone(feishuConfig);
  const native = {
    messageId: "file-a",
    chatId: "chat-a",
    threadId: "thread-a",
    deleted: false,
    attachments: [{ kind: "file" as const, filename: "example.txt", providerFileId: "key-a" }],
  };
  const deps = {
    readState: async () => state,
    readConfig: async () => config,
    readMessage: vi.fn(async () => native),
    download: vi.fn(async () => ({
      attachment: native.attachments[0]!,
      data: new Uint8Array([1, 2]),
    })),
  };
  const request = {
    taskId: "task-a",
    inputId: "input-a",
    messageId: "file-a",
    authorizationId: "auth-a",
    workspacePath: "/workspace",
    workspaceIdentity: "remote:ssh:a",
  };
  return { topic, parent, config, state, native, deps, request };
}

describe("task-scoped topic resource retrieval", () => {
  it("allows an admitted app-authored resource with the same task authorization", async () => {
    const { topic, request, deps } = setup();
    topic.group!.inputs!["input-a"]!.source.topicContext!.messages[0]!.senderType = "app";
    expect((await readAuthorizedTopicResource(request, deps)).data).toEqual(new Uint8Array([1, 2]));
  });

  it("exposes the authorized download through the service as a transport-ready attachment", async () => {
    const { config, state, request } = setup();
    config.bots[0]!.feishuAppId = "resource-service-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("tenant_access_token"))
          return Response.json({ code: 0, tenant_access_token: "test-token", expire: 3600 });
        if (url.includes("/resources/")) return new Response(new Uint8Array([1, 2]));
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "file-a",
                chat_id: "chat-a",
                thread_id: "thread-a",
                msg_type: "file",
                body: { content: JSON.stringify({ file_key: "key-a", file_name: "example.txt" }) },
              },
            ],
          },
        });
      }),
    );
    const service = createBotsService({
      repo: createMemoryRepo(config, state),
      credentialService: createCredentialService({ "feishu-secret": "secret" }),
      zcodeTaskService: createLegacyTaskService(),
      runStartupBackgroundTasks: false,
    });
    try {
      expect(await service.readTopicResource!(request)).toEqual({
        kind: "file",
        filename: "example.txt",
        mimeType: "application/octet-stream",
        sizeBytes: 2,
        dataBase64: "AQI=",
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });
  it("downloads only an archived resource in the invoking task's topic", async () => {
    const { deps, request } = setup();
    expect((await readAuthorizedTopicResource(request, deps)).data).toEqual(new Uint8Array([1, 2]));
    expect(deps.download).toHaveBeenCalledOnce();
  });

  it.each([
    "task",
    "input",
    "archive",
    "workspace",
    "authorization",
    "input-authorization",
    "legacy-authorization",
    "disabled",
    "history",
    "owner",
  ])("rejects invalid %s before native I/O", async (reason) => {
    const { request, deps, parent, config, topic } = setup();
    if (reason === "task") request.taskId = "other";
    if (reason === "input") request.inputId = "other";
    if (reason === "archive") request.messageId = "unread";
    if (reason === "workspace") request.workspaceIdentity = "remote:ssh:b";
    if (reason === "authorization") request.authorizationId = "old";
    if (reason === "input-authorization")
      topic.group!.inputs!["input-a"]!.source.authorizationId = "old";
    if (reason === "legacy-authorization")
      delete topic.group!.inputs!["input-a"]!.source.authorizationId;
    if (reason === "disabled") parent.group!.enabled = false;
    if (reason === "history") parent.group!.historyEnabled = false;
    if (reason === "owner") config.bots[0]!.providerUserId = "other";
    await expect(readAuthorizedTopicResource(request, deps)).rejects.toThrow();
    expect(deps.readMessage).not.toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
  });

  it.each(["chatId", "threadId", "messageId", "deleted"] as const)(
    "rejects native %s mismatch before download",
    async (field) => {
      const { request, deps, native } = setup();
      if (field === "deleted") native.deleted = true;
      else native[field] = "other";
      await expect(readAuthorizedTopicResource(request, deps)).rejects.toThrow();
      expect(deps.download).not.toHaveBeenCalled();
    },
  );

  it("does not expose downloaded bytes after authorization changes", async () => {
    const { request, deps, parent } = setup();
    deps.download.mockImplementationOnce(async () => {
      parent.group!.authorizationId = "new";
      return {
        attachment: { kind: "file", filename: "example.txt", providerFileId: "key-a" },
        data: new Uint8Array([1]),
      };
    });
    await expect(readAuthorizedTopicResource(request, deps)).rejects.toThrow();
  });

  it("rechecks authorization after metadata lookup before fetching any bytes", async () => {
    const { request, deps, parent, native } = setup();
    deps.readMessage.mockImplementationOnce(async () => {
      parent.group!.enabled = false;
      return native;
    });
    await expect(readAuthorizedTopicResource(request, deps)).rejects.toThrow();
    expect(deps.download).not.toHaveBeenCalled();
  });

  it.each([-1, 1, 0.5])(
    "rejects invalid resource index %s before download",
    async (resourceIndex) => {
      const { request, deps } = setup();
      await expect(
        readAuthorizedTopicResource({ ...request, resourceIndex }, deps),
      ).rejects.toThrow();
      expect(deps.download).not.toHaveBeenCalled();
    },
  );

  it("propagates download failure without returning a partial resource", async () => {
    const { request, deps } = setup();
    deps.download.mockRejectedValueOnce(new Error("native download failed"));
    await expect(readAuthorizedTopicResource(request, deps)).rejects.toThrow(
      "native download failed",
    );
  });

  it("rejects cancelled requests before I/O", async () => {
    const { request, deps } = setup();
    await expect(
      readAuthorizedTopicResource({ ...request, signal: AbortSignal.abort() }, deps),
    ).rejects.toThrow();
    expect(deps.readMessage).not.toHaveBeenCalled();
  });
});
