import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "@zcode/shared";
import { createTelegramBotProvider } from "../src/bots/providers/telegramProvider.js";

const bot: BotConfig = {
  id: "telegram-1",
  name: "Telegram",
  provider: "telegram",
  enabled: true,
  credentialRef: "token-key",
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
  replyMode: "assistant_changes",
};

describe("telegram bot provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses short numeric callback data for long option ids", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.send(bot, {
      botId: bot.id,
      provider: "telegram",
      providerUserId: "chat-1",
      text: "选择 workspace",
      selection: {
        id: "workspace-select",
        title: "选择 workspace",
        cancelLabel: "Cancel",
        action: "workspace.set",
        options: [
          {
            id: `ssh://host/${"very-long-path/".repeat(10)}`,
            label: "Remote Workspace",
          },
        ],
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> };
    };
    expect(body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("zc:workspace:1");
    expect(body.reply_markup?.inline_keyboard?.[1]?.[0]).toEqual({
      text: "Cancel",
      callback_data: "zc:cancel",
    });
  });

  it("sends Telegram messages with Markdown parse mode", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.send(bot, {
      botId: bot.id,
      provider: "telegram",
      providerUserId: "chat-1",
      text: "*Done*\n\n```ts\nconst value = 1;\n```",
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      chat_id: "chat-1",
      text: "*Done*\n\n```ts\nconst value = 1;\n```",
      parse_mode: "Markdown",
    });
  });

  it("parses Telegram media messages with captions into attachments", () => {
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    expect(
      provider.parseCallback({
        botId: "telegram-1",
        update: {
          message: {
            message_id: 101,
            caption: "看这张图",
            chat: { id: "chat-1", type: "private" },
            from: { id: "user-1", username: "alice" },
            photo: [
              { file_id: "small", file_size: 10 },
              { file_id: "large", file_size: 20 },
            ],
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        text: "看这张图",
        attachments: [
          expect.objectContaining({
            kind: "image",
            providerFileId: "large",
            filename: "telegram-photo.jpg",
          }),
        ],
      }),
    ]);
  });

  it("downloads Telegram attachments through getFile", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, result: { file_path: "photos/file.jpg", file_size: 3 } }),
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await expect(
      provider.downloadAttachment?.(bot, {
        id: "file-1",
        kind: "image",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        providerFileId: "file-1",
      }),
    ).resolves.toEqual({
      attachment: expect.objectContaining({ sizeBytes: 3 }),
      data: new Uint8Array([1, 2, 3]),
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/getFile");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/file/bottoken/photos/file.jpg");
  });

  it("falls back to plain text when Telegram rejects Markdown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.send(bot, {
      botId: bot.id,
      provider: "telegram",
      providerUserId: "chat-1",
      text: "*unclosed",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      chat_id: "chat-1",
      text: "*unclosed",
    });
  });

  it.each([403, 429, 500, 200])(
    "does not retry non-format rejection or report it as success: %s",
    async (status) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error_code: status === 200 ? 403 : status,
              description: "rejected",
            }),
            { status },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const provider = createTelegramBotProvider({ loadCredential: async () => "token" });
      await expect(
        provider.send(bot, {
          botId: bot.id,
          provider: "telegram",
          providerUserId: "chat",
          text: "hello",
        }),
      ).rejects.toThrow("rejected");
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("reports rejected plain-text fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "can't parse entities" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "blocked" }), { status: 403 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({ loadCredential: async () => "token" });
    await expect(
      provider.send(bot, {
        botId: bot.id,
        provider: "telegram",
        providerUserId: "chat",
        text: "hello",
      }),
    ).rejects.toThrow("blocked");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves Telegram bot name from getMe", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, result: { first_name: "ZCode Bot", username: "zcode_bot" } }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await expect(provider.resolveName?.(bot)).resolves.toBe("ZCode Bot");
    await expect(provider.test(bot)).resolves.toMatchObject({
      ok: true,
      name: "ZCode Bot",
    });
  });

  it("syncs Telegram bot menu with all supported commands", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.syncCommands?.(bot);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/setMyCommands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          commands: [
            { command: "help", description: "Show help" },
            { command: "status", description: "Show current status" },
            { command: "new", description: "Create a new task" },
            { command: "project", description: "Select project" },
            { command: "model", description: "Select model" },
            { command: "mode", description: "Select mode" },
            { command: "think", description: "Select thinking level" },
            { command: "reply", description: "Select reply detail" },
            { command: "bind", description: "Bind this chat" },
          ],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears Telegram bot menu when bot is disabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.syncCommands?.({ ...bot, enabled: false });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/deleteMyCommands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  });

  it("uses command callback data for permission buttons", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.send(bot, {
      botId: bot.id,
      provider: "telegram",
      providerUserId: "chat-1",
      text: "需要权限：Run command",
      selection: {
        id: "permission-req-1",
        title: "需要权限：Run command",
        action: "permission.respond",
        showCancel: false,
        options: [
          {
            id: "/approve req-1 allow",
            label: "允许",
          },
          {
            id: "/deny req-1",
            label: "拒绝",
          },
        ],
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    expect(body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("zc:permission:1");
    expect(body.reply_markup?.inline_keyboard?.[1]?.[0]?.callback_data).toBe("zc:permission:2");
    expect(body.reply_markup?.inline_keyboard).toHaveLength(2);
  });

  it("parses callback data back into a numbered command", () => {
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    expect(
      provider.parseCallback({
        botId: "telegram-1",
        update: {
          callback_query: {
            data: "zc:workspace:1",
            from: { id: 42, username: "user" },
            message: { chat: { id: 42, type: "private" } },
          },
        },
      }),
    ).toMatchObject([
      {
        botId: "telegram-1",
        text: "/workspace 1",
        actor: {
          provider: "telegram",
          providerUserId: "42",
          chatType: "private",
        },
      },
    ]);
  });

  it("parses permission callback data back into a numbered permission command", () => {
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    expect(
      provider.parseCallback({
        botId: "telegram-1",
        update: {
          callback_query: {
            data: "zc:permission:1",
            from: { id: 42, username: "user" },
            message: { chat: { id: 42, type: "private" } },
          },
        },
      }),
    ).toMatchObject([{ text: "/permission 1" }]);
  });

  it("uses short callback data for elicitation buttons", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.send(bot, {
      botId: bot.id,
      provider: "telegram",
      providerUserId: "chat-1",
      text: "请选择",
      selection: {
        id: "elicitation-long-request",
        token: "abc123def456",
        title: "请选择",
        action: "elicitation.respond",
        options: [{ id: `answer-${"x".repeat(100)}`, label: "很长的选项" }],
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    expect(body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("zc:e:abc123def456:1");
  });

  it("attaches interactive buttons to the final chunk of a long Plan", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text?: string; parse_mode?: string };
      const isFinalMarkdownChunk =
        body.parse_mode === "Markdown" && body.text?.includes("Review this implementation plan.");
      return new Response(JSON.stringify({ ok: !isFinalMarkdownChunk }), {
        status: isFinalMarkdownChunk ? 400 : 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.send(bot, {
      botId: bot.id,
      provider: "telegram",
      providerUserId: "chat-1",
      text: `${"Plan context. ".repeat(320)}\n\n------\n\nReview this implementation plan.`,
      selection: {
        id: "plan-approval",
        token: "abc123def456",
        title: "Review this implementation plan.",
        action: "elicitation.respond",
        options: [{ id: "approve", label: "Approve" }],
      },
    });

    const bodies = fetchMock.mock.calls.map(
      ([, init]) =>
        JSON.parse(String(init?.body)) as {
          text?: string;
          parse_mode?: string;
          reply_markup?: unknown;
        },
    );
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.reply_markup).toBeUndefined();
    expect(bodies[1]).toMatchObject({
      parse_mode: "Markdown",
      reply_markup: expect.any(Object),
    });
    expect(bodies[2]?.parse_mode).toBeUndefined();
    expect(bodies[2]?.reply_markup).toEqual(expect.any(Object));
    expect(bodies[1]?.text).toContain("Review this implementation plan.");
    expect(bodies[2]?.text).toBe(bodies[1]?.text);
  });

  it("parses elicitation callback data back into a numbered command", () => {
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    expect(
      provider.parseCallback({
        botId: "telegram-1",
        update: {
          callback_query: {
            id: "callback-1",
            data: "zc:e:abc123def456:2",
            from: { id: 42, username: "user" },
            message: { chat: { id: 42, type: "private" } },
          },
        },
      }),
    ).toMatchObject([
      {
        text: "/elicitation abc123def456 2",
        actor: { providerMessageId: "callback-1" },
      },
    ]);
  });

  it("parses cancel callback data back into explicit cancel command", () => {
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    expect(
      provider.parseCallback({
        botId: "telegram-1",
        update: {
          callback_query: {
            data: "zc:cancel",
            from: { id: 42, username: "user" },
            message: { chat: { id: 42, type: "private" } },
          },
        },
      }),
    ).toMatchObject([{ text: "/cancel" }]);
  });

  it("sends Telegram typing chat action", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.sendTyping?.(bot, { providerUserId: "chat-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/sendChatAction",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chat_id: "chat-1",
          action: "typing",
        }),
      }),
    );
  });

  it("acknowledges callback queries", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createTelegramBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.acknowledgeCallback?.(
      bot,
      {
        botId: "telegram-1",
        update: {
          callback_query: {
            id: "callback-1",
            data: "zc:permission:1",
            message: { message_id: 100, chat: { id: "chat-1", type: "private" } },
          },
        },
      },
      "已提交权限响应。",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/answerCallbackQuery",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          callback_query_id: "callback-1",
          text: "已提交权限响应。",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/editMessageReplyMarkup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chat_id: "chat-1",
          message_id: 100,
          reply_markup: { inline_keyboard: [] },
        }),
      }),
    );
  });
});
