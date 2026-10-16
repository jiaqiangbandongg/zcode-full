import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConfig, BotOutboundMessage } from "@zcode/shared";

const sdkLoaded = vi.hoisted(() => vi.fn());
vi.mock("@larksuiteoapi/node-sdk", () => {
  sdkLoaded();
  return {};
});
import { TopicHistoryPermissionError } from "../src/bots/topicHistory.js";
import {
  countFeishuCardTaggedElements,
  createFeishuBotProvider,
  createFeishuWebSocketEventHandlers,
  splitFeishuStreamingCardStates,
} from "../src/bots/providers/feishuProvider.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // 卡片与 HTTP 路径不应为未启用的长连接加载整份 SDK。
  expect(sdkLoaded).not.toHaveBeenCalled();
});

function createFeishuBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: "feishu-1",
    name: "Feishu",
    provider: "feishu" as const,
    enabled: true,
    credentialRef: "app-secret",
    feishuAppId: "cli_xxx",
    allowedWorkspaces: ["*"],
    allowedCommands: {
      status: true,
      new: true,
      workspace: true,
      model: true,
      thoughtLevel: true,
      sandboxMode: true,
      approvalPolicy: true,
      reply: true,
    },
    currentOptions: {},
    replyMode: "assistant_changes" as const,
    ...overrides,
  };
}

function parseFeishuCardContent(content: string | undefined): Record<string, unknown> {
  return JSON.parse(String(content)) as Record<string, unknown>;
}

describe("feishu bot provider", () => {
  it("sends ordered native body mentions, escapes typed markup and deduplicates the header", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("tenant_access_token"))
          return Response.json({ code: 0, tenant_access_token: "native-parts", expire: 3600 });
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ code: 0, data: { message_id: "om_native" } });
      }),
    );
    const provider = createFeishuBotProvider({ loadCredential: async () => "secret" });
    const parts = [
      { type: "text" as const, text: "请 " },
      {
        type: "channelMention" as const,
        refId: "m1",
        name: "Ryan Bot",
        channel: "feishu" as const,
        targetId: "ou_ryan",
        idType: "open_id" as const,
        entityType: "unknown" as const,
      },
      { type: "text" as const, text: " 确认 <at id=all></at>" },
    ];
    const message: BotOutboundMessage = {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "oc_group",
      replyToMessageId: "om_input",
      threadId: "omt_topic",
      text: "请 @Ryan Bot 确认 <at id=all></at>",
      contentParts: parts,
      mentionedUserIds: ["ou_ryan"],
      deliveryId: "native-delivery",
    };
    expect(await provider.send(createFeishuBot({ feishuAppId: "native-parts" }), message)).toEqual({
      providerMessageId: "om_native",
    });
    const card = JSON.parse(String(requests[0]?.content));
    expect(card.body.elements).toEqual([
      { tag: "markdown", content: "请 <at id=ou_ryan></at> 确认 &lt;at id=all&gt;&lt;/at&gt;" },
    ]);
    expect(requests[0]?.reply_in_thread).toBe(true);
    await expect(
      provider.send(createFeishuBot(), { ...message, text: "different" }),
    ).rejects.toThrow("Invalid native");
    expect(requests).toHaveLength(1);
  });

  it.each([false, true])(
    "quotes group replies and mentions only the first text segment (selection=%s)",
    async (selection) => {
      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.includes("tenant_access_token"))
            return Response.json({ code: 0, tenant_access_token: "mention-token", expire: 3600 });
          requests.push({ url, body: JSON.parse(String(init?.body)) });
          return Response.json({ code: 0, data: { message_id: "om_result" } });
        }),
      );
      const provider = createFeishuBotProvider({ loadCredential: async () => "secret" });
      await provider.send(createFeishuBot({ feishuAppId: `mentions-${selection}` }), {
        botId: "feishu-1",
        provider: "feishu",
        providerUserId: "oc_group",
        text: selection ? "请选择" : "回答内容\n".repeat(6000),
        replyToMessageId: "om_question",
        mentionedUserIds: ["ou_alice", "ou_bob", "ou_alice"],
        ...(selection
          ? { selection: { action: "model.set" as const, title: "请选择", options: [] } }
          : {}),
      });
      expect(requests.length).toBeGreaterThan(selection ? 0 : 1);
      for (const [index, request] of requests.entries()) {
        expect(request.url).toContain("/om_question/reply");
        const card = JSON.parse(String(request.body.content));
        const mentions = JSON.stringify(card).match(/<at id=/g) ?? [];
        expect(mentions).toHaveLength(index === 0 ? 2 : 0);
        if (index === 0)
          expect(card.body.elements[0].content).toBe("<at id=ou_alice></at> <at id=ou_bob></at>");
      }
    },
  );

  it.each([false, true])(
    "bounds recalled-message fallback and keeps mentions for direct cards (topic=%s)",
    async (topic) => {
      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.includes("tenant_access_token"))
            return Response.json({ code: 0, tenant_access_token: "fallback-token", expire: 3600 });
          requests.push({ url, body: JSON.parse(String(init?.body)) });
          return Response.json(
            url.endsWith("/reply")
              ? { code: 230011, msg: "recalled" }
              : { code: 0, data: { message_id: "om_result" } },
          );
        }),
      );
      const provider = createFeishuBotProvider({ loadCredential: async () => "secret" });
      const message: BotOutboundMessage = {
        botId: "feishu-1",
        provider: "feishu",
        providerUserId: "oc_group",
        text: "answer",
        replyToMessageId: "om_question",
        mentionedUserIds: ["ou_alice"],
        ...(topic ? { threadId: "omt_topic", rootMessageId: "om_root" } : {}),
      };
      const operation = provider.createTransientInteractionCard!(
        createFeishuBot({ feishuAppId: `recalled-mention-${topic}` }),
        message,
      );
      if (topic) await expect(operation).rejects.toMatchObject({ deliveryReplyUnavailable: true });
      else await expect(operation).resolves.toMatchObject({ providerMessageId: "om_result" });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url).toContain("/om_question/reply");
      expect(requests[1]?.url).toContain(topic ? "/om_root/reply" : "receive_id_type=chat_id");
      for (const request of requests)
        expect(JSON.parse(String(request.body.content)).body.elements[0].content).toBe(
          "<at id=ou_alice></at>",
        );
    },
  );

  it("never renders group mentions in private cards or accepts all/markup as a user ID", async () => {
    const cards: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("tenant_access_token"))
          return Response.json({ code: 0, tenant_access_token: "private-token", expire: 3600 });
        cards.push(JSON.parse(String(init?.body)).content);
        return Response.json({ code: 0, data: { message_id: "om_result" } });
      }),
    );
    const provider = createFeishuBotProvider({ loadCredential: async () => "secret" });
    for (const providerUserId of ["ou_private", "oc_group"]) {
      await provider.send(createFeishuBot({ feishuAppId: "private-mentions" }), {
        botId: "feishu-1",
        provider: "feishu",
        providerUserId,
        text: "answer",
        mentionedUserIds:
          providerUserId === "ou_private" ? ["ou_alice"] : ["all", "ou_bad><at id=all"],
      });
    }
    expect(cards).toHaveLength(2);
    expect(cards.join("")).not.toContain("<at");
  });

  it("does not load the WebSocket SDK when constructing a provider", () => {
    createFeishuBotProvider({ loadCredential: vi.fn(async () => null) });
    expect(sdkLoaded).not.toHaveBeenCalled();
  });
  it.each(["feishu", "lark"] as const)(
    "refreshes %s tokens using their remaining lifetime",
    async (providerName) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-08T04:00:00Z"));
      let issued = 0;
      const authorizations: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.includes("tenant_access_token")) {
            issued += 1;
            return Response.json({ code: 0, tenant_access_token: `token-${issued}`, expire: 120 });
          }
          authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
          return Response.json({ code: 0, data: { name: "Test group", chat_mode: "group" } });
        }),
      );
      const provider = createFeishuBotProvider({ loadCredential: async () => "secret" });
      const bot = createFeishuBot({
        provider: providerName,
        feishuAppId: `expiry-${providerName}`,
      });
      await provider.getGroupInfo!(bot, "oc_test");
      vi.setSystemTime(new Date("2026-09-08T04:00:30Z"));
      await provider.getGroupInfo!(bot, "oc_test");
      vi.setSystemTime(new Date("2026-09-08T04:01:01Z"));
      await provider.getGroupInfo!(bot, "oc_test");
      expect(issued).toBe(2);
      expect(authorizations).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2"]);
    },
  );

  it("preserves a mention-only group message for contextual handling", () => {
    const provider = createFeishuBotProvider({ loadCredential: async () => "secret" });
    const result = provider.parseCallback({
      botId: "feishu-1",
      zcodeBotOpenId: "ou_bot",
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
        message: {
          message_id: "om_empty",
          chat_id: "oc_a",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1" }),
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
        },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("@ou_bot");
    expect(result[0]?.commandText).toBe("");
  });

  it.each(
    ["bot", "app"].flatMap((senderType) => ["text", "file"].map((kind) => ({ senderType, kind }))),
  )(
    "preserves main-chat bot parent references ($senderType/$kind) and excludes self",
    async ({ senderType, kind }) => {
      const fetchMock = vi.fn(async (url: string) =>
        Response.json(
          url.includes("tenant_access_token")
            ? { code: 0, tenant_access_token: "token", expire: 7200 }
            : url.includes("bot/v3/info")
              ? { code: 0, bot: { open_id: "ou_bot" } }
              : {
                  code: 0,
                  data: {
                    items: [
                      {
                        message_id: "om_parent",
                        chat_id: "oc_a",
                        msg_type: kind,
                        body: {
                          content: JSON.stringify(
                            kind === "text"
                              ? { text: "quoted context" }
                              : { file_key: "file_parent", file_name: "context.txt" },
                          ),
                        },
                      },
                    ],
                  },
                },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const provider = createFeishuBotProvider({ loadCredential: async () => "secret" });
      const bot = createFeishuBot({ feishuAppId: `main-reference-${senderType}-${kind}` });
      const event = {
        sender: { sender_type: senderType, sender_id: { open_id: "ou_other_bot" } },
        message: {
          message_id: "om_input",
          parent_id: "om_parent",
          chat_id: "oc_a",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_bot review" }),
          mentions: [{ key: "@_bot", id: { open_id: "ou_bot" } }],
        },
      };
      const prepared = await provider.prepareCallbackPayload!(bot, { botId: bot.id, event });
      const input = provider.parseCallback(prepared)[0];
      if (kind === "text")
        expect(input?.referencedMessage).toMatchObject({
          messageId: "om_parent",
          text: "quoted context",
        });
      else
        expect(input?.attachments).toEqual([
          expect.objectContaining({
            providerFileId: "file_parent",
            providerMetadata: { resourceMessageId: "om_parent" },
          }),
        ]);
      fetchMock.mockClear();
      event.sender.sender_id.open_id = "ou_bot";
      const self = await provider.prepareCallbackPayload!(bot, { botId: bot.id, event });
      expect(provider.parseCallback(self)).toEqual([]);
      expect(fetchMock.mock.calls.some(([url]) => url.includes("/messages/om_parent"))).toBe(false);
    },
  );

  it.each(["text", "post", "interactive"])(
    "preserves quoted %s as data rather than a control command",
    async (kind) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("tenant_access_token")
              ? { code: 0, tenant_access_token: "quoted-token", expire: 3600 }
              : url.includes("bot/v3/info")
                ? { code: 0, bot: { open_id: "ou_bot" } }
                : {
                    code: 0,
                    data: {
                      items: [
                        {
                          message_id: "om_quote",
                          chat_id: "oc_a",
                          msg_type: kind,
                          ...(kind === "interactive"
                            ? {
                                sender: { id: "quoted-interactive", sender_type: "app" },
                                create_time: "1788921173004",
                              }
                            : {}),
                          body: {
                            content: JSON.stringify(
                              kind === "text"
                                ? { text: "/stop" }
                                : kind === "post"
                                  ? {
                                      zh_cn: {
                                        content: [
                                          [
                                            { tag: "text", text: "/stop" },
                                            { tag: "img", image_key: "img_reference" },
                                          ],
                                        ],
                                      },
                                    }
                                  : !url.includes("card_msg_content_type=user_card_content")
                                    ? {
                                        elements: [
                                          [
                                            {
                                              tag: "text",
                                              text: "请升级至最新版本客户端，以查看内容",
                                            },
                                          ],
                                        ],
                                      }
                                    : {
                                        schema: "2.0",
                                        body: {
                                          elements: [
                                            { tag: "markdown", content: "/stop" },
                                            {
                                              tag: "button",
                                              value: { secretControl: "DO_NOT_INCLUDE" },
                                            },
                                          ],
                                        },
                                      },
                            ),
                          },
                        },
                      ],
                    },
                  },
          ),
        ),
      );
      const provider = createFeishuBotProvider({ loadCredential: async () => "secret" });
      const payload = await provider.prepareCallbackPayload!(
        createFeishuBot({ feishuAppId: `quoted-${kind}` }),
        {
          botId: "feishu-1",
          event: {
            sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
            message: {
              message_id: "om_input",
              parent_id: "om_quote",
              chat_id: "oc_a",
              chat_type: "group",
              message_type: "text",
              content: JSON.stringify({ text: "@_user_1" }),
              mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
            },
          },
        },
      );
      expect(provider.parseCallback(payload)[0]).toMatchObject({
        text: "@ou_bot",
        commandText: "",
        referencedMessage: { messageId: "om_quote", text: "/stop" },
      });
      if (kind === "interactive")
        expect(provider.parseCallback(payload)[0]?.referencedMessage).toMatchObject({
          senderName: "Feishu",
          senderId: "quoted-interactive",
          sentAt: "2026-09-09T02:32:53.004Z",
        });
      if (kind === "post")
        expect(provider.parseCallback(payload)[0]?.attachments).toEqual([
          expect.objectContaining({
            providerFileId: "img_reference",
            providerMetadata: { resourceMessageId: "om_quote" },
          }),
        ]);
    },
  );

  it("bounds native card scope verification before the provider callback deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("tenant_access_token"))
          return Response.json({ code: 0, tenant_access_token: "card-deadline", expire: 3600 });
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Card scope timeout")), {
            once: true,
          });
        });
      }),
    );
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    await expect(
      adapter.prepareCallbackPayload!(createFeishuBot({ feishuAppId: "card-deadline" }), {
        event: {
          context: { open_chat_id: "oc_chat", open_message_id: "om_card" },
          action: {
            value: {
              groupCard: {
                chatId: "oc_chat",
                threadId: "omt_topic",
                taskId: "task",
                authorizationId: "auth",
              },
            },
          },
        },
      }),
    ).rejects.toThrow(/timeout/);
  }, 2500);

  it("rejects a card whose native topic differs from its embedded authority", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("tenant_access_token")
          ? Response.json({ code: 0, tenant_access_token: "card-topic", expire: 3600 })
          : Response.json({
              code: 0,
              data: {
                items: [{ message_id: "om_card", chat_id: "oc_chat", thread_id: "omt_actual" }],
              },
            }),
      ),
    );
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    await expect(
      adapter.prepareCallbackPayload!(createFeishuBot({ feishuAppId: "card-topic" }), {
        event: {
          context: { open_chat_id: "oc_chat", open_message_id: "om_card" },
          action: {
            value: {
              groupCard: {
                chatId: "oc_chat",
                threadId: "omt_forged",
                taskId: "task",
                authorizationId: "auth",
              },
            },
          },
        },
      }),
    ).rejects.toThrow(/scope/);
  });
  it("resolves a dedicated-topic root from native message metadata and rejects cross-chat data", async () => {
    let chatId = "oc_topic";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("tenant_access_token")
          ? Response.json({ code: 0, tenant_access_token: "resolve-topic", expire: 3600 })
          : Response.json({
              code: 0,
              data: {
                items: [
                  {
                    message_id: "om_root",
                    chat_id: chatId,
                    thread_id: "omt_topic",
                    thread_message_position: "0",
                    msg_type: "text",
                    body: { content: JSON.stringify({ text: "Topic title" }) },
                  },
                ],
              },
            }),
      ),
    );
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    const actor = {
      botId: "feishu-1",
      provider: "feishu" as const,
      chatType: "group" as const,
      chatId: "oc_topic",
      providerUserId: "owner",
      providerMessageId: "om_root",
    };
    expect(
      await adapter.resolveTopic!(createFeishuBot({ feishuAppId: "resolve-topic" }), actor),
    ).toEqual({
      threadId: "omt_topic",
      rootMessageId: "om_root",
      topicTitle: "Topic title",
      topicUrl:
        "https://applink.feishu.cn/client/thread/open?openthreadid=omt_topic&openchatid=oc_topic&open_thread_id=omt_topic&open_chat_id=oc_topic&thread_position=0",
    });
    chatId = "oc_secret";
    await expect(
      adapter.resolveTopic!(createFeishuBot({ feishuAppId: "resolve-topic" }), actor),
    ).rejects.toThrow(/scope/);
  });
  it("allows dedicated topic groups and reports their native chat mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("tenant_access_token")
          ? Response.json({ code: 0, tenant_access_token: "topic-group-token", expire: 3600 })
          : Response.json({ code: 0, data: { name: "Topic group", chat_mode: "topic" } }),
      ),
    );
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    expect(
      await adapter.getGroupInfo!(createFeishuBot({ feishuAppId: "topic-group" }), "oc_topic"),
    ).toMatchObject({ name: "Topic group", chatMode: "topic" });
  });
  it.each(["file", "image", "post"])(
    "resolves archived %s resources from their native message",
    async (kind) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url.includes("tenant_access_token")
            ? Response.json({ code: 0, tenant_access_token: "resource-token", expire: 3600 })
            : Response.json({
                code: 0,
                data: {
                  items: [
                    {
                      message_id: "om_file",
                      chat_id: "oc_chat",
                      thread_id: "omt_topic",
                      msg_type: kind,
                      body: {
                        content: JSON.stringify(
                          kind === "file"
                            ? { file_key: "file_key", file_name: "sample.txt" }
                            : kind === "image"
                              ? { image_key: "img_key" }
                              : { zh_cn: { content: [[{ tag: "img", image_key: "img_key" }]] } },
                        ),
                      },
                    },
                  ],
                },
              }),
        ),
      );
      const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
      const result = await adapter.readTopicResourceMessage!(
        createFeishuBot({ feishuAppId: `resource-${kind}` }),
        {
          messageId: "om_file",
          chatId: "oc_chat",
          threadId: "omt_topic",
        },
      );
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).toMatchObject({
        providerFileId: kind === "file" ? "file_key" : "img_key",
        providerMetadata: { resourceMessageId: "om_file" },
      });
    },
  );

  it("rejects a missing archived native resource instead of returning an empty file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("tenant_access_token")
          ? Response.json({ code: 0, tenant_access_token: "resource-empty-token", expire: 3600 })
          : Response.json({ code: 0, data: { items: [] } }),
      ),
    );
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    await expect(
      adapter.readTopicResourceMessage!(createFeishuBot({ feishuAppId: "resource-empty" }), {
        messageId: "om_file",
        chatId: "oc_chat",
        threadId: "omt_topic",
      }),
    ).rejects.toThrow();
  });

  it("preserves missing permissions even on the first root invocation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("tenant_access_token")
          ? Response.json({ code: 0, tenant_access_token: "permission-token", expire: 3600 })
          : Response.json({ code: 99991672, msg: "Access denied: im:message.group_msg" }),
      ),
    );
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    await expect(
      adapter.readTopicHistory!(createFeishuBot({ feishuAppId: "history-permission" }), {
        chatId: "chat",
        threadId: "thread",
        rootMessageId: "root",
        messageId: "root",
      }),
    ).rejects.toBeInstanceOf(TopicHistoryPermissionError);
  });

  it.each(["before-checkpoint", "after-invocation", "deleted", "required"])(
    "only expands history cards inside the required window (%s)",
    async (position) => {
      const native = (id: string) => ({
        message_id: id,
        chat_id: "oc_chat",
        thread_id: "omt_topic",
        sender: { id: "ou_bot", sender_type: "app" },
        create_time: "1",
        msg_type: id === "om_card" ? "interactive" : "text",
        body: { content: JSON.stringify({ text: id }) },
        ...(position === "deleted" && id === "om_card" ? { deleted: true } : {}),
      });
      const order =
        position === "after-invocation"
          ? ["om_card", "om_current", "om_checkpoint"]
          : position === "before-checkpoint"
            ? ["om_current", "om_checkpoint", "om_card"]
            : ["om_current", "om_card", "om_checkpoint"];
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("tenant_access_token"))
          return Response.json({ code: 0, tenant_access_token: "token", expire: 3600 });
        if (url.includes("/messages/om_card"))
          return Response.json({ code: 999, msg: "unreadable" }, { status: 404 });
        if (url.includes("/members"))
          return Response.json({ code: 0, data: { items: [], has_more: false } });
        return Response.json({ code: 0, data: { items: order.map(native), has_more: false } });
      });
      vi.stubGlobal("fetch", fetchMock);
      const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
      const pending = adapter.readTopicHistory!(
        createFeishuBot({ feishuAppId: `window-${position}` }),
        {
          chatId: "oc_chat",
          threadId: "omt_topic",
          rootMessageId: "om_root",
          messageId: "om_current",
          checkpoint: "om_checkpoint",
        },
      );
      if (position === "required") await expect(pending).rejects.toThrow();
      else {
        expect((await pending).messages).toEqual([]);
        expect(fetchMock.mock.calls.some(([url]) => url.includes("/messages/om_card"))).toBe(false);
      }
    },
  );
  it("reads native thread pages without fetching full chat history", async () => {
    const native = (id: string) => ({
      message_id: id,
      chat_id: "oc_chat",
      thread_id: "omt_topic",
      sender: { id: "ou_user", sender_type: "user" },
      create_time: "1",
      parent_id: id === "om_old" ? "om_root" : undefined,
      msg_type: id === "om_old" ? "post" : "text",
      body: {
        content: JSON.stringify(
          id === "om_old"
            ? {
                zh_cn: {
                  title: "Original title",
                  content: [
                    [
                      { tag: "text", text: "original lines" },
                      { tag: "img", image_key: "img_history" },
                    ],
                  ],
                },
              }
            : { text: id },
        ),
      },
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("tenant_access_token"))
        return Response.json({ code: 0, tenant_access_token: "history-token", expire: 3600 });
      if (url.includes("/members"))
        return Response.json({
          code: 0,
          data: { items: [{ member_id: "ou_user", name: "Alice" }], has_more: false },
        });
      if (url.includes("/messages/om_root"))
        return Response.json({ code: 0, data: { items: [native("om_root")] } });
      return Response.json({
        code: 0,
        data: { items: [native("om_current"), native("om_old")], has_more: false },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    const result = await adapter.readTopicHistory!(
      createFeishuBot({ feishuAppId: "topic-history" }),
      {
        chatId: "oc_chat",
        threadId: "omt_topic",
        rootMessageId: "om_root",
        messageId: "om_current",
      },
    );
    expect(result.messages.map((m) => m.id)).toEqual(["om_root", "om_old"]);
    expect(result.messages[1]).toMatchObject({
      senderName: "Alice",
      senderId: "ou_user",
      parentId: "om_root",
      attachments: [{ kind: "image", name: expect.any(String) }],
    });
    expect(result.messages[1]!.text).toContain("original lines");
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.some((url) => url.includes("container_id_type=thread"))).toBe(true);
    expect(urls.some((url) => url.includes("container_id_type=chat"))).toBe(false);
  });
  it.each([false, true])(
    "keeps topic output inside its thread (selection=%s)",
    async (selection) => {
      const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
        url.includes("tenant_access_token")
          ? Response.json({ code: 0, tenant_access_token: "topic-token", expire: 3600 })
          : Response.json({ code: 0, data: { message_id: "om_sent" } }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
      await adapter.send(createFeishuBot({ feishuAppId: `topic-send-${selection}` }), {
        botId: "feishu-1",
        provider: "feishu",
        providerUserId: "oc_chat",
        text: "Result",
        threadId: "omt_topic",
        rootMessageId: "om_root",
        ...(selection
          ? {
              selection: {
                id: "queue",
                title: "Waiting",
                action: "queue.cancel" as const,
                options: [{ id: "/queue-cancel input", label: "Cancel" }],
              },
            }
          : {}),
      });
      const sent = fetchMock.mock.calls.find(([url]) => url.endsWith("/om_root/reply"));
      expect(sent).toBeDefined();
      expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({ reply_in_thread: true });
      expect(fetchMock.mock.calls.some(([url]) => url.includes("messages?"))).toBe(false);
    },
  );

  it("rejects topic output without an original topic message instead of posting to chat", async () => {
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    await expect(
      adapter.send(createFeishuBot(), {
        botId: "feishu-1",
        provider: "feishu",
        providerUserId: "oc_chat",
        text: "Result",
        threadId: "omt_topic",
      }),
    ).rejects.toThrow(/topic/i);
  });
  it.each(["om_request", undefined])(
    "keeps transient topic cards in the source thread (%s)",
    async (replyToMessageId) => {
      const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
        url.includes("tenant_access_token")
          ? Response.json({ code: 0, tenant_access_token: "transient-token", expire: 3600 })
          : Response.json({ code: 0, data: { message_id: "om_card" } }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
      await adapter.createTransientInteractionCard!(
        createFeishuBot({ feishuAppId: `transient-topic-${replyToMessageId}` }),
        {
          botId: "feishu-1",
          provider: "feishu",
          providerUserId: "oc_chat",
          text: "Approval required",
          threadId: "omt_topic",
          rootMessageId: "om_root",
          replyToMessageId,
        },
      );
      const sent = fetchMock.mock.calls.find(([url]) =>
        url.endsWith(`/${replyToMessageId ?? "om_root"}/reply`),
      );
      expect(sent).toBeDefined();
      expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({ reply_in_thread: true });
      expect(fetchMock.mock.calls.some(([url]) => url.includes("messages?"))).toBe(false);
    },
  );

  it("rejects transient topic cards without an anchor before provider I/O", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    await expect(
      adapter.createTransientInteractionCard!(createFeishuBot(), {
        botId: "feishu-1",
        provider: "feishu",
        providerUserId: "oc_chat",
        text: "Approval required",
        threadId: "omt_topic",
      }),
    ).rejects.toThrow(/topic/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders queue cancellation in one compact row with its original command", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("tenant_access_token")
        ? Response.json({ code: 0, tenant_access_token: "queue-token", expire: 3600 })
        : Response.json({ code: 0, data: { message_id: "om_card" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    const handle = await adapter.send(
      createFeishuBot({ id: "compact-queue", feishuAppId: "cli_compact_queue" }),
      {
        botId: "compact-queue",
        provider: "feishu",
        providerUserId: "ou_owner",
        text: "等待执行",
        selection: {
          id: "queue-one",
          title: "已排队",
          action: "queue.cancel",
          showCancel: false,
          options: [{ id: "/queue-cancel one", label: "取消" }],
        },
      },
    );
    expect(handle).toEqual({ providerMessageId: "om_card" });
    const sent = fetchMock.mock.calls.find(([url]) => String(url).includes("/messages?"));
    const body = JSON.parse(String((sent as unknown as [string, RequestInit])[1].body));
    const card = JSON.parse(body.content);
    expect(card.body.elements).toHaveLength(1);
    expect(card.body.elements[0].tag).toBe("column_set");
    expect(card.body.elements[0].columns[0].elements[0].content).toBe("等待执行");
    expect(card.body.elements[0].columns[1].elements[0].behaviors[0].value.command).toBe(
      "/queue-cancel one",
    );
  });
  it.each(["feishu", "lark"] as const)(
    "replaces only its own lifecycle reaction (%s)",
    async (provider) => {
      const bot = createFeishuBot({
        provider,
        id: `reaction-${provider}`,
        feishuAppId: `app-${provider}`,
      });
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("tenant_access_token"))
          return Response.json({ code: 0, tenant_access_token: "reaction-token", expire: 3600 });
        if (init?.method === "GET")
          return Response.json({
            code: 0,
            data: {
              items: [
                {
                  reaction_id: "ours",
                  operator: { operator_type: "app", operator_id: bot.feishuAppId },
                  reaction_type: { emoji_type: "OneSecond" },
                },
                {
                  reaction_id: "member",
                  operator: { operator_type: "user", operator_id: "ou_member" },
                  reaction_type: { emoji_type: "OneSecond" },
                },
                {
                  reaction_id: "other-app",
                  operator: { operator_type: "app", operator_id: "other" },
                  reaction_type: { emoji_type: "OnIt" },
                },
              ],
            },
          });
        return Response.json({ code: 0, data: { reaction_id: "new" } });
      });
      vi.stubGlobal("fetch", fetchMock);
      const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
      await adapter.updateInputReaction!(bot, "om_input", "working");
      const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.[0]).toContain("/reactions/ours");
      const adds = fetchMock.mock.calls.filter(
        ([url, init]) => init?.method === "POST" && url.endsWith("/reactions"),
      );
      expect(JSON.parse(String(adds[0]?.[1]?.body))).toEqual({
        reaction_type: { emoji_type: "OnIt" },
      });
      expect(adds[0]?.[0]).toContain(provider === "lark" ? "open.larksuite.com" : "open.feishu.cn");
    },
  );
  it("splits streaming cards before Card JSON 2.0 reaches the 200-element limit", () => {
    const segments = splitFeishuStreamingCardStates({
      providerUserId: "ou_user",
      locale: "zh-CN",
      blocks: Array.from({ length: 181 }, (_, index) => ({
        type: "message" as const,
        text: `message-${index}`,
      })),
      status: "running",
    });

    expect(segments).toHaveLength(2);
    expect(segments[0]?.status).toBe("sealed");
    expect(segments[1]?.status).toBe("running");
    expect(segments.flatMap((segment) => segment.blocks)).toHaveLength(181);
    for (const segment of segments) {
      expect(countFeishuCardTaggedElements(segment)).toBeLessThanOrEqual(180);
    }
  });

  it("returns the complete business card only after card action processing succeeds", async () => {
    let completeCallback: ((message: BotOutboundMessage) => void) | undefined;
    const callbackGate = new Promise<BotOutboundMessage>((resolve) => {
      completeCallback = resolve;
    });
    const handlers = createFeishuWebSocketEventHandlers({
      bot: createFeishuBot(),
      onPayload: vi.fn(async () => callbackGate),
    });
    let settled = false;
    const response = handlers["card.action.trigger"]({
      action: {
        value: {
          command: "/approve request-1 option-1",
          zcodeCardText: "Review this implementation plan.",
        },
      },
    }).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    completeCallback?.({
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "2/2\n第二题",
      selection: {
        id: "elicitation-request-1-1",
        token: "abc123def456",
        title: "2/2\n第二题",
        action: "elicitation.respond",
        options: [{ id: "next", label: "下一项" }],
      },
      elicitation: {
        requestId: "request-1",
        taskId: "task-1",
        currentQuestionIndex: 1,
        questions: [
          { question: "第一题", options: [{ value: "first", label: "第一项" }] },
          { question: "第二题", options: [{ value: "next", label: "下一项" }] },
        ],
        answers: { "0": ["first"] },
        status: "pending",
      },
    });
    const result = await response;
    expect(result).toMatchObject({ card: { type: "raw" } });
    expect(JSON.stringify(result)).toContain("第一题");
    expect(JSON.stringify(result)).toContain("第二题");
    expect(JSON.stringify(result)).toContain("abc123def456");
  });

  it("does not return a success card when card action processing rejects", async () => {
    const handlers = createFeishuWebSocketEventHandlers({
      bot: createFeishuBot(),
      onPayload: vi.fn(async () => {
        throw new Error("callback failed");
      }),
    });

    await expect(
      handlers["card.action.trigger"]({
        action: {
          value: {
            command: "/approve request-1 option-1",
            zcodeCardText: "Review this implementation plan.",
          },
        },
      }),
    ).rejects.toThrow("callback failed");
  });

  it("acknowledges slow card actions within the platform deadline and marks deferred delivery", async () => {
    vi.useFakeTimers();
    let payload: Record<string, unknown> | undefined;
    let finish!: (value: undefined) => void;
    const handlers = createFeishuWebSocketEventHandlers({
      bot: createFeishuBot(),
      onPayload: async (value) => {
        payload = value as Record<string, unknown>;
        return await new Promise<undefined>((resolve) => {
          finish = resolve;
        });
      },
    });
    const response = handlers["card.action.trigger"]({
      event: { context: { open_chat_id: "oc_group" } },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await response).toEqual({});
    expect(payload?.zcodeFeishuCardResponseState).toEqual({ deferred: true });
    finish(undefined);
  });

  it("keeps WebSocket bot identity trusted when event payload contains routing fields", async () => {
    const onPayload = vi.fn(async () => undefined);
    const handlers = createFeishuWebSocketEventHandlers({ bot: createFeishuBot(), onPayload });
    await handlers["im.message.receive_v1"]({ botId: "other", zcodeProvider: "lark" });
    expect(onPayload).toHaveBeenLastCalledWith(
      expect.objectContaining({ botId: "feishu-1", zcodeProvider: "feishu" }),
    );
    await handlers["card.action.trigger"]({
      botId: "other",
      zcodeFeishuSynchronousCardAction: false,
    });
    expect(onPayload).toHaveBeenLastCalledWith(
      expect.objectContaining({ botId: "feishu-1", zcodeFeishuSynchronousCardAction: true }),
    );
  });

  it("requires sender open_id for group authority", () => {
    const provider = createFeishuBotProvider({ loadCredential: vi.fn(async () => "secret") });
    expect(
      provider.parseCallback({
        botId: "feishu-1",
        zcodeBotOpenId: "ou_bot",
        event: {
          sender: { sender_type: "user", sender_id: { user_id: "ou_user" } },
          message: {
            chat_id: "oc_chat",
            message_id: "om_message",
            chat_type: "group",
            content: JSON.stringify({ text: "@_user_1 /status" }),
            mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
          },
        },
      }),
    ).toEqual([]);
  });

  it.each([true, false])(
    "recognizes only this bot as the topic root author (own=%s)",
    async (own) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("tenant_access_token")
              ? { code: 0, tenant_access_token: "token", expire: 3600 }
              : url.includes("bot/v3/info")
                ? { code: 0, bot: { open_id: "ou_bot" } }
                : {
                    code: 0,
                    data: {
                      items: [
                        {
                          message_id: "root",
                          chat_id: "chat",
                          thread_id: "topic",
                          msg_type: "text",
                          sender: {
                            id: own ? "app-root" : "other-app",
                            id_type: "app_id",
                            sender_type: "app",
                          },
                          body: { content: JSON.stringify({ text: "root reply" }) },
                        },
                      ],
                    },
                  },
          ),
        ),
      );
      const provider = createFeishuBotProvider({ loadCredential: vi.fn(async () => "secret") });
      const prepared = await provider.prepareCallbackPayload!(
        createFeishuBot({ feishuAppId: "app-root" }),
        {
          botId: "feishu-1",
          event: {
            sender: { sender_type: "user", sender_id: { open_id: "user" } },
            message: {
              message_id: "incoming",
              chat_type: "group",
              chat_id: "chat",
              thread_id: "topic",
              root_id: "root",
              parent_id: "root",
              content: JSON.stringify({ text: "continue" }),
              mentions: [],
            },
          },
        },
      );
      expect(provider.parseCallback(prepared)[0]).toMatchObject({
        mentionedBot: false,
        topicRootIsCurrentBot: own,
        referencedMessage: { text: "root reply" },
      });
      const again = await provider.prepareCallbackPayload!(
        createFeishuBot({ feishuAppId: "app-root" }),
        { ...(prepared as object), zcodeTopicActive: false, zcodeTopicHasAcceptedInput: true },
      );
      expect(provider.parseCallback(again)[0]?.referencedMessage).toBeUndefined();
      expect(
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("im/v1/messages/")),
      ).toHaveLength(1);
    },
  );

  it("preserves human and other-app topic messages but ignores itself", () => {
    const provider = createFeishuBotProvider({ loadCredential: vi.fn(async () => "secret") });
    const payload = {
      botId: "feishu-1",
      zcodeBotOpenId: "ou_bot",
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
        message: {
          chat_type: "group",
          chat_id: "oc_chat",
          thread_id: "omt_topic",
          root_id: "om_root",
          message_id: "om_input",
          content: JSON.stringify({ text: "@_user_1 hello" }),
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
        },
      },
    };
    expect(provider.parseCallback(payload)[0]?.actor).toMatchObject({
      chatId: "oc_chat",
      threadId: "omt_topic",
      rootMessageId: "om_root",
    });
    payload.event.message.mentions = [];
    payload.event.message.content = JSON.stringify({ text: "continue" });
    expect(provider.parseCallback(payload)[0]).toMatchObject({
      text: "continue",
      mentionedBot: false,
      actor: { threadId: "omt_topic" },
    });
    payload.event.sender.sender_type = "bot";
    expect(provider.parseCallback(payload)[0]).toMatchObject({
      senderType: "app",
      text: "continue",
      actor: { providerUserId: "ou_user" },
    });
    payload.event.sender.sender_id.open_id = "ou_bot";
    expect(provider.parseCallback(payload)).toEqual([]);
    payload.event.sender.sender_id.open_id = "ou_other_bot";
    payload.event.message.thread_id = "";
    expect(provider.parseCallback(payload)).toEqual([]);
    payload.event.message.mentions = [{ key: "@_bot", id: { open_id: "ou_bot" }, name: "Bot" }];
    payload.event.message.content = JSON.stringify({ text: "@_bot hello" });
    expect(provider.parseCallback(payload)[0]).toMatchObject({
      senderType: "app",
      mentionedBot: true,
    });
  });

  it.each(["feishu", "lark"])(
    "%s ignores bot cards instead of admitting visible text",
    (provider) => {
      const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
      const payload = {
        botId: "feishu-1",
        zcodeProvider: provider,
        zcodeBotOpenId: "ou_bot",
        event: {
          sender: { sender_type: "bot", sender_id: { open_id: "ou_other_bot" } },
          message: {
            chat_type: "group",
            chat_id: "oc_chat",
            thread_id: "omt_topic",
            root_id: "om_root",
            message_id: "om_card",
            message_type: "interactive",
            content: JSON.stringify({
              body: {
                elements: [
                  { tag: "markdown", content: "Analysis completed" },
                  {
                    tag: "button",
                    text: { content: "Details" },
                    value: { text: "/approve secret" },
                  },
                ],
              },
            }),
          },
        },
      };
      expect(adapter.parseCallback(payload)).toEqual([]);
      payload.event.sender.sender_type = "app";
      expect(adapter.parseCallback(payload)).toEqual([]);
      payload.event.sender.sender_id.open_id = "";
      expect(adapter.parseCallback(payload)).toEqual([]);
    },
  );

  it("ignores bot confirmation replies to a bot card while retaining human quotes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.includes("tenant_access_token")
            ? { code: 0, tenant_access_token: "card-token", expire: 3600 }
            : url.includes("bot/v3/info")
              ? { code: 0, bot: { open_id: "ou_bot" } }
              : {
                  code: 0,
                  data: {
                    items: [
                      {
                        message_id: "om_card",
                        chat_id: "oc_a",
                        thread_id: "omt_a",
                        msg_type: "interactive",
                        sender: { id: "ou_other", sender_type: "app" },
                        body: {
                          content: JSON.stringify({
                            elements: [
                              { tag: "markdown", content: "Permission options" },
                              {
                                tag: "button",
                                text: { content: "Allow" },
                                value: { command: "/approve" },
                              },
                            ],
                          }),
                        },
                      },
                    ],
                  },
                },
        ),
      ),
    );
    const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
    const event = {
      sender: { sender_type: "bot", sender_id: { open_id: "ou_other" } },
      message: {
        message_id: "om_confirm",
        chat_id: "oc_a",
        chat_type: "group",
        thread_id: "omt_a",
        parent_id: "om_card",
        message_type: "text",
        content: JSON.stringify({ text: "Permission response submitted." }),
        mentions: [{ key: "@_bot", id: { open_id: "ou_bot" }, name: "Bot" }],
      },
    };
    const bot = createFeishuBot({ feishuAppId: "card-confirm" });
    expect(
      adapter.parseCallback(await adapter.prepareCallbackPayload!(bot, { botId: bot.id, event })),
    ).toEqual([]);
    event.sender.sender_type = "user";
    expect(
      adapter.parseCallback(await adapter.prepareCallbackPayload!(bot, { botId: bot.id, event }))[0]
        ?.referencedMessage?.text,
    ).toBe("Permission options\nAllow");
  });

  it.each(["feishu", "lark"])(
    "%s admits plain conversation cards with native mentions",
    async (provider) => {
      const adapter = createFeishuBotProvider({ loadCredential: async () => "secret" });
      const payload = {
        botId: "feishu-1",
        zcodeProvider: provider,
        zcodeBotOpenId: "ou_bot",
        event: {
          sender: { sender_type: "bot", sender_id: { open_id: "ou_other_bot" } },
          message: {
            message_id: "om_plain",
            chat_id: "oc_a",
            chat_type: "group",
            thread_id: "omt_a",
            mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" }],
            message_type: "interactive",
            content: JSON.stringify({
              body: {
                elements: [
                  { tag: "markdown", content: "<at id=ou_sender_scope></at> What date is today?" },
                ],
              },
            }),
          },
        },
      };
      expect(adapter.parseCallback(payload)[0]).toMatchObject({
        text: "@Bot What date is today?",
        mentionedBot: true,
        senderType: "app",
        contentParts: [
          { type: "channelMention", targetId: "ou_bot" },
          { type: "text", text: " What date is today?" },
        ],
      });
      const actualContent = payload.event.message.content;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("tenant_access_token")
              ? { code: 0, tenant_access_token: "plain-token", expire: 3600 }
              : url.includes("bot/v3/info")
                ? { code: 0, bot: { open_id: "ou_bot" } }
                : {
                    code: 0,
                    data: {
                      items: [
                        {
                          message_id: "om_plain",
                          chat_id: "oc_a",
                          thread_id: "omt_a",
                          body: { content: actualContent },
                        },
                      ],
                    },
                  },
          ),
        ),
      );
      payload.event.message.content = JSON.stringify({
        elements: [[{ tag: "text", text: "请升级至最新版本客户端，以查看内容" }]],
      });
      const prepared = await adapter.prepareCallbackPayload!(
        createFeishuBot({
          provider: provider as "feishu" | "lark",
          feishuAppId: `plain-${provider}`,
        }),
        payload,
      );
      expect(adapter.parseCallback(prepared)[0]?.text).toBe("@Bot What date is today?");
      payload.event.message.content = actualContent;
      payload.event.sender.sender_id.open_id = "ou_bot";
      expect(adapter.parseCallback(payload)).toEqual([]);
    },
  );

  it("parses Feishu text callbacks into inbound bot messages", () => {
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "feishu-1",
        token: "token",
        zcodeBotOpenId: "ou_bot",
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
          message: {
            chat_id: "oc_chat",
            message_id: "om_message",
            chat_type: "group",
            content: JSON.stringify({ text: "@_user_1 /status" }),
            mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "ZCode" }],
          },
        },
      }),
    ).toEqual([
      {
        botId: "feishu-1",
        text: "@ZCode /status",
        commandText: "/status",
        contentParts: [
          {
            type: "channelMention",
            channel: "feishu",
            entityType: "unknown",
            idType: "open_id",
            name: "ZCode",
            refId: "om_message:m1",
            targetId: "ou_bot",
          },
          { type: "text", text: " /status" },
        ],
        botOpenId: "ou_bot",
        mentionedBot: true,
        topicRootIsCurrentBot: false,
        actor: {
          provider: "feishu",
          botId: "feishu-1",
          providerUserId: "ou_user",
          chatType: "group",
          chatId: "oc_chat",
          providerMessageId: "om_message",
        },
      },
    ]);
  });

  it.each(["feishu", "lark"])("preserves ordered native post mentions on %s", (providerName) => {
    const provider = createFeishuBotProvider({ loadCredential: async () => "secret" });
    const messages = provider.parseCallback({
      botId: "native-post",
      zcodeProvider: providerName,
      zcodeBotOpenId: "ou_bot",
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
        message: {
          chat_id: "oc_group",
          message_id: "om_post",
          chat_type: "group",
          message_type: "post",
          mentions: [
            { key: "@_user_1", id: { open_id: "ou_bot" }, name: "ZBot" },
            { key: "@_user_2", id: { open_id: "ou_target" }, name: "Ryan Bot" },
          ],
          content: JSON.stringify({
            content: [
              [
                { tag: "at", user_id: "ou_bot", user_name: "ZBot" },
                { tag: "text", text: "帮我 " },
                { tag: "at", user_id: "ou_target", user_name: "Ryan Bot" },
                { tag: "text", text: " 确认" },
              ],
            ],
          }),
        },
      },
    });
    expect(messages[0]).toMatchObject({
      text: "@ZBot帮我 @Ryan Bot 确认",
      commandText: "帮我 @Ryan Bot 确认",
      contentParts: [
        { type: "channelMention", targetId: "ou_bot", name: "ZBot", channel: providerName },
        { type: "text", text: "帮我 " },
        {
          type: "channelMention",
          refId: expect.stringContaining("om_post:"),
          targetId: "ou_target",
          name: "Ryan Bot",
          channel: providerName,
        },
        { type: "text", text: " 确认" },
      ],
    });
  });

  it("parses Feishu post callbacks as normal text messages", () => {
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "feishu-1",
        event: {
          sender: { sender_id: { open_id: "ou_user" } },
          message: {
            chat_id: "oc_chat",
            message_id: "om_post",
            chat_type: "p2p",
            message_type: "post",
            content: JSON.stringify({
              content: [
                [
                  { tag: "at", user_id: "ou_bot", user_name: "ZCode" },
                  { tag: "text", text: "看看这个方案 " },
                  {
                    tag: "a",
                    text: "技术文档",
                    href: "https://example.com/doc",
                  },
                ],
                [{ tag: "text", text: "顺便总结风险" }],
              ],
            }),
          },
        },
      }),
    ).toEqual([
      {
        botId: "feishu-1",
        text: "看看这个方案 技术文档 https://example.com/doc\n顺便总结风险",
        actor: {
          provider: "feishu",
          botId: "feishu-1",
          providerUserId: "ou_user",
          chatType: "private",
          chatId: undefined,
          providerMessageId: "om_post",
        },
      },
    ]);
  });

  it("parses localized Feishu post callbacks", () => {
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "feishu-1",
        event: {
          sender: { sender_id: { open_id: "ou_user" } },
          message: {
            message_id: "om_i18n_post",
            chat_type: "p2p",
            message_type: "post",
            content: JSON.stringify({
              post: {
                zh_cn: {
                  title: "标题",
                  content: [[{ tag: "text", text: "正文" }]],
                },
              },
            }),
          },
        },
      }),
    ).toMatchObject([{ text: "标题\n正文" }]);
  });

  it("parses Lark callbacks into Lark inbound bot messages", () => {
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "lark-1",
        zcodeProvider: "lark",
        event: {
          sender: { sender_id: { open_id: "ou_user" } },
          message: {
            message_id: "om_message",
            chat_type: "p2p",
            content: JSON.stringify({ text: "/status" }),
          },
        },
      }),
    ).toEqual([
      {
        botId: "lark-1",
        text: "/status",
        actor: {
          provider: "lark",
          botId: "lark-1",
          providerUserId: "ou_user",
          chatType: "private",
          chatId: undefined,
          providerMessageId: "om_message",
        },
      },
    ]);
  });

  it.each([
    [400, 230011, { deliveryRejected: true, deliveryReplyUnavailable: true }],
    [400, 230020, { deliveryRejected: true, retryAfterMs: 1000 }],
    [400, 230049, { deliveryRejected: false }],
    [500, undefined, { deliveryRejected: false }],
  ])(
    "classifies HTTP %s / code %s for safe saved-result recovery",
    async (status, code, expected) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("tenant_access_token")
              ? { code: 0, tenant_access_token: "token" }
              : { code, msg: "test failure" },
            { status: url.includes("tenant_access_token") ? 200 : status },
          ),
        ),
      );
      const provider = createFeishuBotProvider({ loadCredential: vi.fn(async () => "secret") });
      await expect(
        provider.send(createFeishuBot({ feishuAppId: `cli_recovery_${status}_${code}` }), {
          botId: "feishu-1",
          provider: "feishu",
          providerUserId: "oc_group",
          text: "saved",
          deliveryId: "saved-id",
          replyToMessageId: "om_original",
        }),
      ).rejects.toMatchObject(expected);
    },
  );

  it("replies to the original group input using a stable delivery uuid", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("tenant_access_token")
              ? { code: 0, tenant_access_token: "token" }
              : { code: 0, data: { message_id: "om_result" } },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({ loadCredential: vi.fn(async () => "secret") });
    await provider.send(createFeishuBot({ feishuAppId: "cli_group_delivery_test" }), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "oc_group",
      text: "answer",
      replyToMessageId: "om_original",
      deliveryId: "stable-result",
    });
    const call = fetchMock.mock.calls.find(([url]) => url.includes("/om_original/reply"));
    expect(call).toBeDefined();
    expect(JSON.parse(String((call as unknown as [string, RequestInit])[1].body))).toMatchObject({
      uuid: "stable-result-0",
      msg_type: "interactive",
    });
  });

  it("rejects an explicitly referenced attachment from a different chat", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("tenant_access_token")
              ? { code: 0, tenant_access_token: "token", expire: 7200 }
              : url.includes("bot/v3/info")
                ? { code: 0, bot: { open_id: "ou_bot" } }
                : {
                    code: 0,
                    data: {
                      items: [
                        {
                          message_id: "om_file",
                          chat_id: "oc_other",
                          msg_type: "file",
                          body: {
                            content: JSON.stringify({ file_key: "file_1", file_name: "a.txt" }),
                          },
                        },
                      ],
                    },
                  },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({ loadCredential: vi.fn(async () => "secret") });
    await expect(
      provider.prepareCallbackPayload!(
        createFeishuBot({ feishuAppId: "cli_group_reference_test" }),
        {
          botId: "feishu-1",
          event: {
            sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
            message: {
              message_id: "om_input",
              chat_id: "oc_a",
              chat_type: "group",
              parent_id: "om_file",
              content: JSON.stringify({ text: "@_user_1 review" }),
              mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
            },
          },
        },
      ),
    ).rejects.toThrow("same group");
  });

  it("rejects an explicitly referenced attachment from a different topic", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("tenant_access_token")
              ? { code: 0, tenant_access_token: "token", expire: 7200 }
              : url.includes("bot/v3/info")
                ? { code: 0, bot: { open_id: "ou_bot" } }
                : {
                    code: 0,
                    data: {
                      items: [
                        {
                          message_id: "om_file",
                          chat_id: "oc_a",
                          thread_id: "omt_other",
                          msg_type: "file",
                          body: {
                            content: JSON.stringify({ file_key: "file_1", file_name: "a.txt" }),
                          },
                        },
                      ],
                    },
                  },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({ loadCredential: vi.fn(async () => "secret") });
    await expect(
      provider.prepareCallbackPayload!(
        createFeishuBot({ feishuAppId: "cli_topic_reference_test" }),
        {
          botId: "feishu-1",
          event: {
            sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
            message: {
              message_id: "om_input",
              chat_id: "oc_a",
              chat_type: "group",
              parent_id: "om_file",
              thread_id: "omt_current",
              content: JSON.stringify({ text: "@_user_1 review" }),
              mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
            },
          },
        },
      ),
    ).rejects.toThrow("same topic");
  });

  it("rejects the entire rich-text input when an image reference is malformed", () => {
    const provider = createFeishuBotProvider({ loadCredential: vi.fn(async () => "secret") });
    expect(
      provider.parseCallback({
        botId: "feishu-1",
        zcodeBotOpenId: "ou_bot",
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
          message: {
            chat_type: "group",
            chat_id: "oc_a",
            message_id: "om_invalid",
            message_type: "post",
            mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
            content: JSON.stringify({
              content: [
                [
                  { tag: "at", user_id: "ou_bot" },
                  { tag: "text", text: "execute partial text" },
                  { tag: "img" },
                ],
              ],
            }),
          },
        },
      }),
    ).toEqual([]);
  });

  it("preserves inline group images and other mentions in one input", () => {
    const provider = createFeishuBotProvider({ loadCredential: vi.fn(async () => "secret") });
    const result = provider.parseCallback({
      botId: "feishu-1",
      zcodeBotOpenId: "ou_bot",
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
        message: {
          chat_type: "group",
          chat_id: "oc_a",
          message_id: "om_post",
          message_type: "post",
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" }],
          content: JSON.stringify({
            content: [
              [
                { tag: "at", user_id: "ou_bot" },
                { tag: "text", text: "review " },
                { tag: "at", user_id: "ou_other", user_name: "Alice" },
                { tag: "img", image_key: "img_1" },
              ],
            ],
          }),
        },
      },
    });
    expect(result[0]?.text).toBe("@Botreview @Alice");
    expect(result[0]?.commandText).toBe("review @Alice");
    expect(result[0]?.attachments).toEqual([
      expect.objectContaining({ kind: "image", providerFileId: "img_1" }),
    ]);
  });

  it("parses Feishu image callbacks into attachments", () => {
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "feishu-1",
        event: {
          sender: { sender_id: { open_id: "ou_user" } },
          message: {
            chat_id: "oc_chat",
            message_id: "om_image",
            chat_type: "p2p",
            message_type: "image",
            content: JSON.stringify({ image_key: "img-key-1" }),
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        text: "",
        attachments: [
          expect.objectContaining({
            kind: "image",
            providerFileId: "img-key-1",
          }),
        ],
      }),
    ]);
  });

  it("downloads Feishu message resources with message id and file key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" })),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    await expect(
      provider.downloadAttachment?.(
        createFeishuBot({
          id: "feishu-download",
          feishuAppId: "cli_download",
          credentialRef: "download-secret",
        }),
        {
          id: "img-key-1",
          kind: "image",
          filename: "image.jpg",
          mimeType: "image/jpeg",
          providerFileId: "img-key-1",
        },
        {
          provider: "feishu",
          botId: "feishu-download",
          providerUserId: "ou_user",
          chatType: "private",
          providerMessageId: "om_message",
        },
      ),
    ).resolves.toEqual({
      attachment: expect.objectContaining({ providerFileId: "img-key-1" }),
      data: new Uint8Array([1, 2, 3]),
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/im/v1/messages/om_message/resources/img-key-1?type=image",
    );
  });

  it("parses Feishu card actions in private chats when context includes a chat id", () => {
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "feishu-1",
        event_type: "card.action.trigger",
        operator: { operator_id: { open_id: "ou_user" } },
        action: { value: { command: "/model provider custom:test" } },
        context: { open_chat_id: "oc_context" },
      }),
    ).toEqual([
      {
        botId: "feishu-1",
        text: "/model provider custom:test",
        actor: {
          provider: "feishu",
          botId: "feishu-1",
          providerUserId: "ou_user",
          chatType: "private",
        },
      },
    ]);
  });

  it("parses Feishu card actions from nested event payloads", () => {
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "feishu-1",
        header: { event_type: "card.action.trigger" },
        event: {
          event_id: "feishu-card-event-1",
          operator: { operator_id: { open_id: "ou_user" } },
          action: { value: { command: "/cancel" }, token: "card-token" },
          context: { open_chat_id: "oc_context" },
        },
      }),
    ).toMatchObject([
      {
        text: "/cancel",
        actor: { providerMessageId: "feishu-card-event-1" },
      },
    ]);
  });

  it("parses Feishu card actions from schema 2 behavior values", () => {
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "feishu-1",
        header: { event_type: "card.action.trigger" },
        event: {
          event_id: "feishu-card-event-2",
          operator: { operator_id: { open_id: "ou_user" } },
          action: {
            behaviors: [
              {
                type: "callback",
                value: { command: "/workspace /tmp/workspace" },
              },
            ],
          },
          context: { open_chat_id: "oc_context" },
        },
      }),
    ).toMatchObject([
      {
        text: "/workspace /tmp/workspace",
        actor: { providerMessageId: "feishu-card-event-2" },
      },
    ]);
  });

  it("parses legacy Feishu card actions with top-level open_id", () => {
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "feishu-1",
        open_id: "ou_user",
        action: { value: { command: "/status" } },
      }),
    ).toEqual([
      {
        botId: "feishu-1",
        text: "/status",
        actor: {
          provider: "feishu",
          botId: "feishu-1",
          providerUserId: "ou_user",
          chatType: "private",
        },
      },
    ]);
  });

  it("marks explicit group card callbacks for authorization", () => {
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "feishu-1",
        event_type: "card.action.trigger",
        operator: { operator_id: { open_id: "ou_user" } },
        action: { value: { command: "/status" } },
        context: { chat_type: "group_chat", open_chat_id: "oc_group" },
      }),
    ).toEqual([
      {
        botId: "feishu-1",
        groupCardAction: true,
        text: "/status",
        actor: {
          provider: "feishu",
          botId: "feishu-1",
          providerUserId: "ou_user",
          chatType: "group",
          chatId: "oc_group",
        },
      },
    ]);
  });

  it("sends text messages through Feishu markdown cards", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "oc_chat",
      text: "**hello**",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("receive_id_type=chat_id");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      receive_id?: string;
      msg_type?: string;
      content?: string;
    };
    expect(body.receive_id).toBe("oc_chat");
    expect(body.msg_type).toBe("interactive");
    expect(parseFeishuCardContent(body.content)).toMatchObject({
      schema: "2.0",
      body: {
        elements: [
          {
            tag: "markdown",
            content: "**hello**",
          },
        ],
      },
    });
  });

  it("keeps multiline status replies readable in Feishu schema 2 cards", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "oc_chat",
      text: [
        "Workspace: z-code",
        "Model: DeepSeek/deepseek-v4-flash",
        "------",
        "Task: 你好啊 (sess_1)",
        "State: completed",
        "Worked: 1s",
      ].join("\n"),
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as {
      content?: string;
    };
    expect(parseFeishuCardContent(body.content)).toMatchObject({
      schema: "2.0",
      body: {
        elements: [
          {
            tag: "markdown",
            content: [
              "Workspace: z-code  ",
              "Model: DeepSeek/deepseek-v4-flash",
              "",
              "---",
              "",
              "Task: 你好啊 (sess_1)  ",
              "State: completed  ",
              "Worked: 1s",
            ].join("\n"),
          },
        ],
      },
    });
  });

  it("uses the Lark OpenAPI domain for Lark bots", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot({ provider: "lark", id: "lark-1" }), {
      botId: "lark-1",
      provider: "lark",
      providerUserId: "ou_user",
      text: "hello",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "https://open.larksuite.com/open-apis/im/v1/messages",
    );
  });

  it("creates and updates Feishu streaming reply cards with collapsed tool summaries", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (String(url).includes("/open-apis/im/v1/messages?receive_id_type=open_id")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_streaming" } }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    const handle = await provider.createStreamingReplyCard?.(createFeishuBot(), {
      providerUserId: "ou_user",
      blocks: [
        { type: "message", text: "正在检查项目" },
        {
          type: "tools",
          title: "工具摘要",
          summaries: ["- 完成 · Read `README.md`"],
          expanded: true,
        },
      ],
      status: "running",
    });
    await provider.updateStreamingReplyCard?.(createFeishuBot(), handle!, {
      providerUserId: "ou_user",
      blocks: [
        { type: "message", text: "正在检查项目" },
        {
          type: "tools",
          title: "工具摘要",
          summaries: ["- 完成 · Read `README.md`"],
          expanded: false,
        },
        { type: "message", text: "检查完成" },
        {
          type: "tools",
          title: "工具摘要",
          summaries: ["- 完成 · Bash `pnpm test`"],
          expanded: false,
        },
      ],
      status: "completed",
    });

    expect(handle).toEqual({ providerMessageId: "om_streaming" });
    const createCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages?receive_id_type=open_id"),
    );
    const createBody = JSON.parse(String(createCall?.[1]?.body)) as { content?: string };
    const createCard = parseFeishuCardContent(createBody.content);
    expect(createCard).toMatchObject({
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: "正在检查项目" },
          {
            tag: "collapsible_panel",
            expanded: true,
            background_color: "grey-50",
            border: { color: "grey", corner_radius: "8px" },
            header: {
              title: { tag: "plain_text", content: "🛠️ 工具摘要 (1)" },
              vertical_align: "center",
              icon: {
                tag: "standard_icon",
                token: "down-small-ccm_outlined",
                color: "grey",
                size: "16px 16px",
              },
              icon_position: "right",
              icon_expanded_angle: -180,
            },
          },
          { tag: "markdown", content: "⏳ 运行中" },
        ],
      },
    });
    expect(JSON.stringify(createCard)).not.toContain("input");
    const updateCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages/om_streaming"),
    );
    expect(String(updateCall?.[0])).toContain("/open-apis/im/v1/messages/om_streaming");
    expect(updateCall?.[1]?.method).toBe("PATCH");
    const updateBody = JSON.parse(String(updateCall?.[1]?.body)) as { content?: string };
    const updateCard = parseFeishuCardContent(updateBody.content);
    expect(updateCard).toMatchObject({
      schema: "2.0",
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "collapsible_panel",
            expanded: false,
          }),
        ]),
      },
    });
    const updateCardJson = JSON.stringify(updateCard);
    expect(updateCardJson.match(/🛠️ 工具摘要 \(1\)/gu) ?? []).toHaveLength(2);
    expect(updateCardJson).toContain("检查完成");
    expect(updateCardJson).toContain("✅ 已完成");
  });

  it("resolves the Feishu bot name from application info API", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.endsWith("/application/v6/applications/cli_name?lang=zh_cn")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              app: {
                app_name: "ZCode Assistant",
              },
            },
          }),
        );
      }
      return new Response(JSON.stringify({ code: 999, msg: "unexpected request" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await expect(
      provider.resolveName?.({
        ...createFeishuBot(),
        credentialRef: "app-secret-name",
        feishuAppId: "cli_name",
      }),
    ).resolves.toBe("ZCode Assistant");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/open-apis/application/v6/applications/cli_name?lang=zh_cn",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ authorization: "Bearer tenant-token" });
  });

  it("falls back to the current Feishu app when app id info is not ready", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.endsWith("/application/v6/applications/cli_fallback?lang=zh_cn")) {
        return new Response(JSON.stringify({ code: 999, msg: "not ready" }));
      }
      if (url.endsWith("/application/v6/applications/me?lang=zh_cn")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              app: {
                app_name: "ZCode Assistant",
              },
            },
          }),
        );
      }
      return new Response(JSON.stringify({ code: 999, msg: "unexpected request" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await expect(
      provider.resolveName?.({
        ...createFeishuBot(),
        credentialRef: "app-secret-name",
        feishuAppId: "cli_fallback",
      }),
    ).resolves.toBe("ZCode Assistant");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "/open-apis/application/v6/applications/me?lang=zh_cn",
    );
  });

  it.each(["feishu", "lark"] as const)(
    "resolves %s group actors through the chat directory",
    async (domain) => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/tenant_access_token/internal"))
          return new Response(JSON.stringify({ code: 0, tenant_access_token: "member-token" }));
        expect(url).toContain(domain === "lark" ? "open.larksuite.com" : "open.feishu.cn");
        expect(url).toContain("/im/v1/chats/oc_directory/members?");
        expect(url).toContain("member_id_type=open_id");
        return new Response(
          JSON.stringify({
            code: 0,
            data: { items: [{ member_id: "ou_member", name: "Alice" }], has_more: false },
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const provider = createFeishuBotProvider({ loadCredential: vi.fn(async () => "secret") });
      const bot = createFeishuBot({ provider: domain, feishuAppId: `cli_directory_${domain}` });
      expect(
        await provider.resolveActorDisplayName!(bot, {
          botId: bot.id,
          provider: domain,
          providerUserId: "ou_member",
          chatType: "group",
          chatId: "oc_directory",
        }),
      ).toBe("Alice");
      expect(await provider.getGroupMemberNames!(bot, "oc_directory")).toEqual({
        ou_member: "Alice",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("resolves Feishu actor display names from the contact API", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.includes("/open-apis/contact/v3/users/ou_user?user_id_type=open_id")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              user: {
                name: "张三",
              },
            },
          }),
        );
      }
      return new Response(JSON.stringify({ code: 999, msg: "unexpected request" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await expect(
      provider.resolveActorDisplayName?.(
        createFeishuBot({
          credentialRef: "app-secret-actor-name",
          feishuAppId: "cli_actor_name",
        }),
        {
          botId: "feishu-1",
          provider: "feishu",
          providerUserId: "ou_user",
          chatType: "private",
        },
      ),
    ).resolves.toBe("张三");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ authorization: "Bearer tenant-token" });
  });

  it("sends selection prompts as Feishu interactive cards", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "Select",
      selection: {
        id: "workspace",
        title: "Workspace",
        cancelLabel: "Cancel",
        action: "workspace.set",
        options: [{ id: "/workspace workspace-1", label: "Workspace" }],
      },
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as { msg_type?: string; content?: string };
    expect(body.msg_type).toBe("interactive");
    const card = parseFeishuCardContent(body.content);
    expect(card).toMatchObject({
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: "Select" },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Workspace" },
            behaviors: [
              {
                value: { command: "/workspace /workspace workspace-1" },
                type: "callback",
              },
            ],
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Cancel" },
            behaviors: [
              {
                value: { command: "/cancel" },
                type: "callback",
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(card)).not.toContain('"tag":"action"');
    expect(JSON.stringify(card)).not.toContain('"actions"');
  });

  it.each([200, 400])(
    "reports message delivery failure and recovery for HTTP %s",
    async (status) => {
      let failed = true;
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/tenant_access_token/internal")) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
        }
        return new Response(
          JSON.stringify(
            failed
              ? {
                  code: 230101,
                  msg: "Sending messages to users is temporarily unavailable.",
                  error: { log_id: "delivery-log" },
                }
              : { code: 0, data: { message_id: "om_delivered" } },
          ),
          { status: failed ? status : 200 },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const onDeliveryResult = vi.fn();
      const provider = createFeishuBotProvider({
        loadCredential: async () => "secret",
        onDeliveryResult,
      });
      const bot = createFeishuBot();
      const message = {
        botId: bot.id,
        provider: bot.provider,
        providerUserId: "ou_user",
        text: "test",
      };
      await expect(provider.send(bot, message)).rejects.toThrow(`HTTP ${status}, code=230101`);
      expect(onDeliveryResult).toHaveBeenLastCalledWith(
        bot,
        expect.stringContaining("log_id=delivery-log"),
      );
      expect(onDeliveryResult).toHaveBeenLastCalledWith(
        bot,
        expect.stringContaining("receive_id_type=open_id"),
      );
      failed = false;
      await provider.send(bot, message);
      expect(onDeliveryResult).toHaveBeenLastCalledWith(bot, undefined);
    },
  );

  it("preserves update business errors and falls back to the response log header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/tenant_access_token/internal")
          ? new Response(JSON.stringify({ code: 0, tenant_access_token: "token" }))
          : new Response(JSON.stringify({ code: 230101, msg: "Delivery rejected" }), {
              headers: { "x-tt-logid": "header-log" },
            }),
      ),
    );
    const onDeliveryResult = vi.fn();
    const bot = createFeishuBot();
    const provider = createFeishuBotProvider({
      loadCredential: async () => "secret",
      onDeliveryResult,
    });
    await expect(
      provider.updateTransientInteractionCard!(
        bot,
        { providerMessageId: "om_card" },
        {
          botId: bot.id,
          provider: bot.provider,
          providerUserId: "ou_user",
          text: "reply",
        },
      ),
    ).rejects.toThrow("HTTP 200, code=230101, msg=Delivery rejected, log_id=header-log");
    expect(onDeliveryResult).toHaveBeenCalledWith(bot, expect.stringContaining("header-log"));
  });

  it("preserves Feishu business error details when sending a card returns HTTP 400", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(
        JSON.stringify({
          code: 230013,
          msg: "Bot has NO availability to this user.",
          error: { log_id: "20260805113649ABCDEF" },
        }),
        { status: 400 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await expect(
      provider.send(createFeishuBot(), {
        botId: "feishu-1",
        provider: "feishu",
        providerUserId: "ou_user",
        text: "Help",
      }),
    ).rejects.toThrow(
      "Feishu send interactive message failed: HTTP 400, code=230013, msg=Bot has NO availability to this user., log_id=20260805113649ABCDEF",
    );
  });

  it("sends elicitation options as Feishu elicitation commands", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "Ask",
      selection: {
        id: "elicitation-1",
        token: "abc123def456",
        title: "Ask",
        action: "elicitation.respond",
        options: [{ id: "fast path", label: "Fast" }],
      },
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as { content?: string };
    expect(parseFeishuCardContent(body.content)).toMatchObject({
      schema: "2.0",
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "button",
            behaviors: [
              expect.objectContaining({
                value: { command: "/elicitation abc123def456 fast path", zcodeCardText: "Ask" },
              }),
            ],
          }),
        ]),
      },
    });
  });

  it("renders ExitPlanMode as a plan approval card instead of a generic question", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "Review this implementation plan.",
      locale: "zh-CN",
      elicitation: {
        requestId: "plan-1",
        taskId: "task-1",
        runId: "run-1",
        currentQuestionIndex: 0,
        questions: [
          {
            question: "Review this implementation plan.",
            header: "Implementation plan",
            options: [
              {
                value: "approve",
                label: "Approve",
                description: "Exit plan mode and start implementation.",
              },
            ],
          },
        ],
        status: "pending",
        schema: {
          interaction: "plan_approval",
          toolName: "ExitPlanMode",
          plan: "# Snake game\n\n1. Create Vite project\n2. Implement gameplay",
        },
      },
      selection: {
        id: "elicitation-plan-1-0",
        token: "abc123def456",
        title: "Review this implementation plan.",
        action: "elicitation.respond",
        options: [
          {
            id: "approve",
            label: "批准",
            description: "退出计划模式并开始实施。",
          },
        ],
      },
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as { content?: string };
    const cardJson = JSON.stringify(parseFeishuCardContent(body.content));
    expect(cardJson).toContain("**请审阅此实施计划。**");
    expect(cardJson).not.toContain("**Review this implementation plan.**");
    expect(cardJson).toContain("# Snake game");
    expect(cardJson).toContain("Implement gameplay");
    expect(cardJson).toContain("批准");
    expect(cardJson).toContain("自定义回答");
    expect(cardJson).not.toContain("#### 提问");
    expect(cardJson).not.toContain("退出计划模式并开始实施。");
    const planIndex = cardJson.indexOf("# Snake game");
    const dividerIndex = cardJson.indexOf('"tag":"hr"');
    const reviewIndex = cardJson.indexOf("**请审阅此实施计划。**");
    expect(planIndex).toBeGreaterThan(-1);
    expect(dividerIndex).toBeGreaterThan(planIndex);
    expect(reviewIndex).toBeGreaterThan(dividerIndex);
  });

  it("localizes the ExitPlanMode review title for English Feishu cards", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "Review this implementation plan.",
      locale: "en-US",
      elicitation: {
        requestId: "plan-en-1",
        taskId: "task-1",
        runId: "run-1",
        currentQuestionIndex: 0,
        questions: [
          {
            question: "Review this implementation plan.",
            options: [{ value: "approve", label: "Approve" }],
          },
        ],
        status: "pending",
        schema: { interaction: "plan_approval", toolName: "ExitPlanMode", plan: "1. Ship it" },
      },
      selection: {
        id: "elicitation-plan-en-1-0",
        token: "abc123def456",
        title: "Review this implementation plan.",
        action: "elicitation.respond",
        options: [{ id: "approve", label: "Approve" }],
      },
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as { content?: string };
    const cardJson = JSON.stringify(parseFeishuCardContent(body.content));
    expect(cardJson).toContain("**Review this implementation plan.**");
    expect(cardJson).not.toContain("请审阅此实施计划。");
  });

  it("renders AskUserQuestion answers and multi-select actions in one Feishu card", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "Question",
      elicitation: {
        requestId: "ask-1",
        taskId: "task-1",
        runId: "run-1",
        currentQuestionIndex: 1,
        questions: [
          {
            question: "你想在哪里运行贪吃蛇游戏？",
            options: [{ value: "web", label: "网页版 (HTML/CSS/JS)" }],
          },
          {
            question: "你希望游戏有什么功能？",
            options: [
              { value: "base", label: "基础玩法" },
              { value: "score", label: "分数系统" },
            ],
            multiSelect: true,
          },
        ],
        answers: { "0": ["web"], "1": ["base"] },
        status: "pending",
      },
      selection: {
        id: "elicitation-ask-1-1",
        token: "abc123def456",
        title: "Question",
        action: "elicitation.respond",
        options: [
          { id: "base", label: "[x] 基础玩法" },
          { id: "score", label: "[ ] 分数系统" },
          { id: "__submit__", label: "完成" },
        ],
      },
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as { content?: string };
    const card = parseFeishuCardContent(body.content);
    const cardJson = JSON.stringify(card);
    expect(card).toMatchObject({ schema: "2.0" });
    expect(cardJson).toContain("#### 1/2 你想在哪里运行贪吃蛇游戏？");
    expect(cardJson).toContain("网页版 (HTML/CSS/JS)");
    expect(cardJson).toContain('"tag":"hr"');
    expect(cardJson).not.toContain('"content":"---\\n"');
    expect(cardJson).toContain("#### 提问");
    expect(cardJson).toContain("你希望游戏有什么功能？");
    expect(cardJson).toContain('"tag":"form"');
    expect(cardJson).toContain("☑ 基础玩法");
    expect(cardJson).toContain("☐ 分数系统");
    expect(cardJson).toContain("☐ 自定义回答");
    // 当前题的“基础玩法”只应存在于待回答区的选中按钮，不能提前进入已回答历史。
    expect(cardJson.match(/基础玩法/gu)).toHaveLength(1);
    expect(cardJson.indexOf("你想在哪里运行贪吃蛇游戏？")).toBeLessThan(
      cardJson.indexOf('"tag":"hr"'),
    );
    expect(cardJson.indexOf('"tag":"hr"')).toBeLessThan(cardJson.indexOf("你希望游戏有什么功能？"));
    expect(cardJson).toContain('"tag":"form"');
    expect(cardJson).not.toContain('"tag":"input"');
    expect(cardJson).not.toContain('"tag":"multi_select_static"');
    expect(cardJson).toContain("/elicitation abc123def456 __form__:");
    expect(cardJson).not.toContain("__submit__");
  });

  it("renders free-text AskUserQuestion as a Feishu form input", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "Question",
      elicitation: {
        requestId: "ask-text",
        taskId: "task-1",
        runId: "run-1",
        currentQuestionIndex: 0,
        questions: [
          {
            question: "请补充需求说明",
            options: [],
          },
        ],
        answers: {},
        status: "pending",
      },
      selection: {
        id: "elicitation-ask-text-0",
        token: "abc123def456",
        title: "Question",
        action: "elicitation.respond",
        options: [],
      },
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as { content?: string };
    const cardJson = JSON.stringify(parseFeishuCardContent(body.content));
    expect(cardJson).toContain("#### 提问");
    expect(cardJson).toContain("请补充需求说明");
    expect(cardJson).toContain("自定义回答");
    expect(cardJson).toContain('"tag":"input"');
    expect(cardJson).toContain('"input_type":"multiline_text"');
    expect(cardJson).toContain("/elicitation abc123def456 __form__:");
  });

  it("renders single-select AskUserQuestion as flat radio choices", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "Question",
      elicitation: {
        requestId: "ask-select",
        taskId: "task-1",
        runId: "run-1",
        currentQuestionIndex: 0,
        questions: [
          {
            question: "你想在哪里运行贪吃蛇游戏？",
            options: [{ value: "web", label: "网页版 (HTML/CSS/JS)" }],
          },
        ],
        answers: {},
        status: "pending",
      },
      selection: {
        id: "elicitation-ask-select-0",
        token: "abc123def456",
        title: "Question",
        action: "elicitation.respond",
        options: [{ id: "web", label: "网页版 (HTML/CSS/JS)" }],
      },
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as { content?: string };
    const cardJson = JSON.stringify(parseFeishuCardContent(body.content));
    expect(cardJson).toContain("○ 网页版 (HTML/CSS/JS)");
    expect(cardJson).toContain("○ 自定义回答");
    expect(cardJson).not.toContain('"tag":"input"');
    expect(cardJson).not.toContain('"tag":"form"');
    expect(cardJson).not.toContain('"tag":"select_static"');
    expect(cardJson).toContain("/elicitation abc123def456 __custom__");
  });

  it("expands custom input after choosing custom AskUserQuestion answer", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "Question",
      elicitation: {
        requestId: "ask-custom",
        taskId: "task-1",
        runId: "run-1",
        currentQuestionIndex: 0,
        questions: [
          {
            question: "你想在哪里运行贪吃蛇游戏？",
            options: [{ value: "web", label: "网页版 (HTML/CSS/JS)" }],
          },
        ],
        answers: {},
        expandedCustomAnswerQuestionIndexes: [0],
        status: "pending",
      },
      selection: {
        id: "elicitation-ask-custom-0",
        token: "abc123def456",
        title: "Question",
        action: "elicitation.respond",
        options: [{ id: "web", label: "网页版 (HTML/CSS/JS)" }],
      },
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as { content?: string };
    const cardJson = JSON.stringify(parseFeishuCardContent(body.content));
    expect(cardJson).toContain("● 自定义回答");
    expect(cardJson).toContain('"tag":"input"');
    expect(cardJson).toContain("请输入自定义回答");
    expect(cardJson).toContain("/elicitation abc123def456 __custom__");
    expect(cardJson).toContain("/elicitation abc123def456 __form__:");
  });

  it("uses the outbound locale for Feishu AskUserQuestion controls", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "Question",
      locale: "en-US",
      elicitation: {
        requestId: "ask-custom-en",
        taskId: "task-1",
        runId: "run-1",
        currentQuestionIndex: 0,
        questions: [
          {
            question: "Where should the game run?",
            options: [{ value: "web", label: "Web" }],
          },
        ],
        answers: {},
        expandedCustomAnswerQuestionIndexes: [0],
        status: "pending",
      },
      selection: {
        id: "elicitation-ask-custom-en-0",
        token: "abc123def456",
        title: "Question",
        action: "elicitation.respond",
        options: [{ id: "web", label: "Web" }],
      },
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as { content?: string };
    const cardJson = JSON.stringify(parseFeishuCardContent(body.content));
    expect(cardJson).toContain("#### Question");
    expect(cardJson).toContain("● Custom answer");
    expect(cardJson).toContain("Enter a custom answer");
    expect(cardJson).toContain("Done");
    expect(cardJson).toContain("Cancel");
  });

  it("omits cancel buttons when selection disallows cancellation", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.send(createFeishuBot(), {
      botId: "feishu-1",
      provider: "feishu",
      providerUserId: "ou_user",
      text: "Permission",
      selection: {
        id: "permission-1",
        title: "Permission",
        action: "permission.respond",
        showCancel: false,
        options: [{ id: "/approve req-1 allow", label: "Allow" }],
      },
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const body = JSON.parse(String(sendCall?.[1]?.body)) as { content?: string };
    const card = parseFeishuCardContent(body.content);
    expect(card).toMatchObject({ schema: "2.0" });
    expect(JSON.stringify(card)).toContain("/approve req-1 allow");
    expect(JSON.stringify(card)).not.toContain('"command":"/cancel"');
  });

  it("updates legacy Feishu cards after acknowledging an action", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.acknowledgeCallback?.(
      createFeishuBot(),
      {
        botId: "feishu-1",
        event: {
          operator: { operator_id: { open_id: "ou_user" } },
          action: { token: "card-token", value: { command: "/workspace 1" } },
        },
      },
      "已进入 /tmp/workspace 的新任务草稿。",
    );

    const updateCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/interactive/v1/card/update"),
    );
    expect(updateCall?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json",
        },
      }),
    );
    const body = JSON.parse(String(updateCall?.[1]?.body)) as { token?: string; card?: unknown };
    expect(body.token).toBe("card-token");
    expect(body).toMatchObject({ open_ids: ["ou_user"] });
    expect(body.card).toMatchObject({ schema: "2.0" });
    expect(JSON.stringify(body.card)).toContain("已进入 /tmp/workspace 的新任务草稿。");
    expect(JSON.stringify(body.card)).not.toContain('"command"');
  });

  it("updates Feishu selection cards with original text after acknowledging an action", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.acknowledgeCallback?.(
      createFeishuBot(),
      {
        botId: "feishu-1",
        event: {
          operator: { operator_id: { open_id: "ou_user" } },
          action: {
            token: "card-token",
            value: {
              command: "/workspace /tmp/workspace",
              zcodeCardText: "请选择工作区",
            },
          },
        },
      },
      "已进入 /tmp/workspace 的新任务草稿。",
    );

    const updateCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/interactive/v1/card/update"),
    );
    expect(updateCall).toBeTruthy();
    const body = JSON.parse(String(updateCall?.[1]?.body)) as { card?: unknown };
    expect(body.card).toMatchObject({ schema: "2.0" });
    expect(JSON.stringify(body.card)).toContain("请选择工作区");
    expect(JSON.stringify(body.card)).not.toContain("已进入 /tmp/workspace 的新任务草稿。");
    expect(JSON.stringify(body.card)).not.toContain('"command"');
  });

  it("updates schema 2 Feishu selection cards with context card tokens", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.acknowledgeCallback?.(
      createFeishuBot(),
      {
        botId: "feishu-1",
        event: {
          operator: { operator_id: { open_id: "ou_user" } },
          action: {
            behaviors: [
              {
                type: "callback",
                value: {
                  command: "/workspace /tmp/workspace",
                  zcodeCardText: "请选择工作区",
                },
              },
            ],
          },
          context: { card_update_token: "schema-2-card-token" },
        },
      },
      "已进入 /tmp/workspace 的新任务草稿。",
    );

    const updateCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/interactive/v1/card/update"),
    );
    expect(updateCall).toBeTruthy();
    const body = JSON.parse(String(updateCall?.[1]?.body)) as { token?: string; card?: unknown };
    expect(body.token).toBe("schema-2-card-token");
    expect(body).toMatchObject({ open_ids: ["ou_user"] });
    expect(body.card).toMatchObject({ schema: "2.0" });
    expect(JSON.stringify(body.card)).toContain("请选择工作区");
    expect(JSON.stringify(body.card)).not.toContain('"command"');
  });

  it("updates the same AskUserQuestion card to the next question", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    const result = await provider.acknowledgeCallback?.(
      createFeishuBot(),
      {
        botId: "feishu-1",
        event: {
          operator: { operator_id: { open_id: "ou_user" } },
          action: {
            behaviors: [
              {
                type: "callback",
                value: {
                  command: "/elicitation question0token web",
                  zcodeCardText: "第一题",
                },
              },
            ],
          },
          context: { card_update_token: "ask-card-token" },
        },
      },
      "第二题",
      {
        botId: "feishu-1",
        provider: "feishu",
        providerUserId: "ou_user",
        text: "第二题",
        selection: {
          id: "elicitation-ask-1-1",
          token: "question1token",
          title: "第二题",
          action: "elicitation.respond",
          options: [{ id: "base", label: "基础玩法" }],
        },
        elicitation: {
          requestId: "ask-1",
          taskId: "task-1",
          currentQuestionIndex: 1,
          questions: [
            { question: "第一题", options: [{ value: "web", label: "网页" }] },
            { question: "第二题", options: [{ value: "base", label: "基础玩法" }] },
          ],
          answers: { "0": ["web"] },
          status: "pending",
        },
      },
    );

    expect(result).toEqual({ handled: true });
    const updateCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/interactive/v1/card/update"),
    );
    const body = JSON.parse(String(updateCall?.[1]?.body)) as { card?: unknown };
    const cardJson = JSON.stringify(body.card);
    expect(cardJson).toContain("第一题");
    expect(cardJson).toContain("第二题");
    expect(cardJson).toContain('"command"');
  });

  it("updates completed AskUserQuestion cards in place and marks the callback handled", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    const result = await provider.acknowledgeCallback?.(
      createFeishuBot(),
      {
        botId: "feishu-1",
        event: {
          operator: { operator_id: { open_id: "ou_user" } },
          action: {
            behaviors: [
              {
                type: "callback",
                value: {
                  command: "/elicitation abc123def456 __submit__",
                  zcodeCardText: "Question",
                },
              },
            ],
          },
          context: { card_update_token: "ask-card-token" },
        },
      },
      "已提交问答响应。",
      {
        botId: "feishu-1",
        provider: "feishu",
        providerUserId: "ou_user",
        text: "已提交问答响应。",
        elicitation: {
          requestId: "ask-1",
          taskId: "task-1",
          runId: "run-1",
          currentQuestionIndex: 1,
          questions: [
            {
              question: "你想在哪里运行贪吃蛇游戏？",
              options: [{ value: "web", label: "网页版 (HTML/CSS/JS)" }],
            },
            {
              question: "你希望游戏有什么功能？",
              options: [
                { value: "base", label: "基础玩法" },
                { value: "score", label: "分数系统" },
              ],
              multiSelect: true,
            },
          ],
          answers: { "0": ["web"], "1": ["base", "score"] },
          status: "completed",
        },
      },
    );

    expect(result).toEqual({ handled: true });
    const updateCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/interactive/v1/card/update"),
    );
    const body = JSON.parse(String(updateCall?.[1]?.body)) as { token?: string; card?: unknown };
    const cardJson = JSON.stringify(body.card);
    expect(body.token).toBe("ask-card-token");
    expect(body).toMatchObject({ open_ids: ["ou_user"] });
    expect(body.card).toMatchObject({ schema: "2.0" });
    expect(cardJson).toContain("#### 1/2 你想在哪里运行贪吃蛇游戏？");
    expect(cardJson).toContain("网页版 (HTML/CSS/JS)");
    expect(cardJson).toContain("#### 2/2 你希望游戏有什么功能？");
    expect(cardJson).toContain("基础玩法, 分数系统");
    expect(cardJson).not.toContain('"content":"---\\n"');
    expect(cardJson).not.toContain("✅ Questions answered");
    expect(cardJson).not.toContain('"command"');
  });

  it("uses Feishu Typing reactions as provider typing state", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.endsWith("/messages/om_message/reactions")) {
        return new Response(JSON.stringify({ code: 0, data: { reaction_id: "reaction-1" } }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.startTyping?.(createFeishuBot(), {
      providerUserId: "ou_user",
      providerMessageId: "om_message",
    });
    await provider.stopTyping?.(createFeishuBot(), {
      providerUserId: "ou_user",
      providerMessageId: "om_message",
    });

    const addCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/messages/om_message/reactions"),
    );
    expect(addCall?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reaction_type: {
            emoji_type: "Typing",
          },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_message/reactions/reaction-1",
      expect.objectContaining({
        method: "DELETE",
        headers: {
          authorization: "Bearer tenant-token",
        },
      }),
    );
  });

  it("keeps command typing reactions until explicit stop", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.endsWith("/messages/om_command/reactions")) {
        return new Response(JSON.stringify({ code: 0, data: { reaction_id: "reaction-command" } }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });

    await provider.sendTyping?.(createFeishuBot(), {
      providerUserId: "ou_user",
      providerMessageId: "om_command",
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/messages/om_command/reactions/reaction-command") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);

    await provider.stopTyping?.(createFeishuBot(), {
      providerUserId: "ou_user",
      providerMessageId: "om_command",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_command/reactions/reaction-command",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("lets long-running Feishu typing take over transient command typing", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.endsWith("/messages/om_takeover/reactions")) {
        return new Response(
          JSON.stringify({ code: 0, data: { reaction_id: "reaction-takeover" } }),
        );
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createFeishuBotProvider({
      loadCredential: vi.fn(async () => "app-secret-value"),
    });
    const bot = createFeishuBot();
    const target = {
      providerUserId: "ou_user",
      providerMessageId: "om_takeover",
    };

    await provider.sendTyping?.(bot, target);
    await provider.startTyping?.(bot, target);
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/messages/om_takeover/reactions/reaction-takeover") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);

    await provider.stopTyping?.(bot, target);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_takeover/reactions/reaction-takeover",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
