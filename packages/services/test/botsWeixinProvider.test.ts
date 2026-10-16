import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv } from "node:crypto";
import type { BotConfig } from "@zcode/shared";
import { createWeixinBotProvider, getWeixinUpdates } from "../src/bots/providers/weixinProvider.js";
import { beginWeixinRegistration, pollWeixinRegistration } from "../src/bots/providers/weixinRegistration.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function encryptWeixinCdnFixture(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function createWeixinBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: "weixin-1",
    name: "Weixin",
    provider: "weixin" as const,
    enabled: true,
    credentialRef: "weixin-token",
    providerUserId: "bot-1@im.bot",
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

describe("weixin bot provider", () => {
  it("parses Weixin iLink getupdates messages", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ret: 0,
      get_updates_buf: "buf-2",
      msgs: [
        {
          message_id: 1001,
          message_type: 1,
          from_user_id: "wx_user",
          context_token: "ctx-1",
          msg: {
            sender_name: "User",
            item_list: [{ type: 1, text_item: { text: "/状态" } }],
          },
        },
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getWeixinUpdates({
      bot: createWeixinBot(),
      deps: { loadCredential: vi.fn(async () => "token") },
      buf: "buf-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ilinkai.weixin.qq.com/ilink/bot/getupdates",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer token",
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": expect.any(String),
        },
        body: JSON.stringify({ base_info: { channel_version: "2.0.0" }, get_updates_buf: "buf-1" }),
      }),
    );
    expect(result.buf).toBe("buf-2");
    expect(result.messages).toEqual([
      {
        botId: "weixin-1",
        text: "/状态",
        actor: {
          provider: "weixin",
          botId: "weixin-1",
          providerUserId: "wx_user",
          displayName: "User",
          chatType: "private",
          chatId: undefined,
          providerMessageId: "1001",
          providerContextToken: "ctx-1",
        },
      },
    ]);
  });

  it("does not apply the ordinary 15-second deadline to idle getupdates", async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          providerSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const polling = getWeixinUpdates({
      bot: createWeixinBot(),
      deps: { loadCredential: vi.fn(async () => "token") },
      signal: external.signal,
    });
    const rejection = expect(polling).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(providerSignal?.aborted).toBe(false);

    external.abort(new Error("runtime disposed"));
    await rejection;
    vi.useRealTimers();
  });

  it("reads nested Weixin message ids for inbound dedupe", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ret: 0,
      msgs: [
        {
          message_type: 1,
          from_user_id: "wx_user",
          msg: {
            message_id: 2001,
            item_list: [{ type: 1, text_item: { text: "继续" } }],
          },
        },
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getWeixinUpdates({
      bot: createWeixinBot(),
      deps: { loadCredential: vi.fn(async () => "token") },
    });

    expect(result.messages[0]?.actor.providerMessageId).toBe("2001");
  });

  it("parses Weixin mixed text and media item_list into attachments", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ret: 0,
      msgs: [
        {
          message_id: 1002,
          message_type: 1,
          from_user_id: "wx_user",
          msg: {
            item_list: [
              { type: 1, text_item: { text: "帮我看一下" } },
              {
                type: 2,
                image_item: {
                  file_id: "img-1",
                  file_name: "demo.png",
                  mime_type: "image/png",
                  size: 123,
                },
              },
            ],
          },
        },
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getWeixinUpdates({
      bot: createWeixinBot(),
      deps: { loadCredential: vi.fn(async () => "token") },
    });

    expect(result.messages[0]).toMatchObject({
      text: "帮我看一下",
      attachments: [
        {
          id: "img-1",
          kind: "image",
          filename: "demo.png",
          mimeType: "image/png",
          sizeBytes: 123,
          providerFileId: "img-1",
        },
      ],
    });
  });

  it("parses Weixin file_item media metadata into SVG attachments", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ret: 0,
      msgs: [
        {
          message_id: 1004,
          message_type: 1,
          from_user_id: "wx_user",
          item_list: [
            {
              type: 4,
              file_item: {
                file_name: "WeChat-Icon-Logo.wine.svg",
                media: {
                  md5: "svg-md5",
                  len: 456,
                },
              },
            },
          ],
        },
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getWeixinUpdates({
      bot: createWeixinBot(),
      deps: { loadCredential: vi.fn(async () => "token") },
    });

    expect(result.messages[0]).toMatchObject({
      text: "",
      attachments: [
        {
          id: "svg-md5",
          kind: "image",
          filename: "WeChat-Icon-Logo.wine.svg",
          mimeType: "image/svg+xml",
          sizeBytes: 456,
          providerFileId: "svg-md5",
        },
      ],
    });
  });

  it("parses Weixin image_item media id into image attachments", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ret: 0,
      msgs: [
        {
          message_id: 1005,
          message_type: 1,
          from_user_id: "wx_user",
          item_list: [
            {
              type: 2,
              image_item: {
                aeskey: "image-aes-key",
                media: 123456,
                mid_size: 117378,
                thumb_size: 4096,
                thumb_height: 160,
                thumb_width: 160,
              },
            },
          ],
        },
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getWeixinUpdates({
      bot: createWeixinBot(),
      deps: { loadCredential: vi.fn(async () => "token") },
    });

    expect(result.messages[0]).toMatchObject({
      text: "",
      attachments: [
        {
          id: "123456",
          kind: "image",
          filename: "weixin-image-1.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 117378,
          providerFileId: "123456",
        },
      ],
    });
  });

  it("parses Weixin image_item nested full_url into downloadable image attachments", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ret: 0,
      msgs: [
        {
          message_id: 1006,
          message_type: 1,
          from_user_id: "wx_user",
          item_list: [
            {
              type: 2,
              image_item: {
                aeskey: "outer-aes-key",
                media: {
                  encrypt_query_param: "encrypted-query",
                  aes_key: "nested-aes-key",
                  full_url: "https://weixin.example.test/image.jpg",
                },
                mid_size: 2048,
              },
            },
          ],
        },
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getWeixinUpdates({
      bot: createWeixinBot(),
      deps: { loadCredential: vi.fn(async () => "token") },
    });

    expect(result.messages[0]).toMatchObject({
      text: "",
      attachments: [
        {
          id: "encrypted-query",
          kind: "image",
          filename: "weixin-image-1.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 2048,
          providerFileId: "encrypted-query",
          downloadUrl: "https://weixin.example.test/image.jpg",
          providerMetadata: {
            weixinAesKey: "nested-aes-key",
          },
        },
      ],
    });
  });

  it("decrypts Weixin CDN attachment downloads", async () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plaintext = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const encrypted = encryptWeixinCdnFixture(plaintext, key);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(encrypted)));
    const provider = createWeixinBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    const downloaded = await provider.downloadAttachment?.(
      createWeixinBot(),
      {
        id: "encrypted-query",
        kind: "image",
        filename: "weixin-image-1.jpg",
        mimeType: "image/jpeg",
        downloadUrl: "https://weixin.example.test/image.jpg",
        providerMetadata: {
          weixinAesKey: key.toString("base64"),
        },
      },
    );

    expect(Buffer.from(downloaded?.data ?? [])).toEqual(plaintext);
  });

  it("preserves attachments when Weixin polling re-enters the callback parser", () => {
    const provider = createWeixinBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    expect(
      provider.parseCallback({
        botId: "weixin-1",
        messages: [
          {
            id: "1003",
            from: "wx_user",
            text: "",
            attachments: [
              {
                id: "img-1",
                kind: "image",
                filename: "demo.png",
                mimeType: "image/png",
                providerFileId: "img-1",
                providerMetadata: {
                  weixinAesKey: "00112233445566778899aabbccddeeff",
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        text: "",
        attachments: [
          expect.objectContaining({
            id: "img-1",
            kind: "image",
            providerMetadata: {
              weixinAesKey: "00112233445566778899aabbccddeeff",
            },
          }),
        ],
      }),
    ]);
  });

  it("ignores webhookUrl when calling the built-in Weixin iLink API", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0, get_updates_buf: "", msgs: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await getWeixinUpdates({
      bot: createWeixinBot({ webhookUrl: "https://webhook.example.test/reply" }),
      deps: { loadCredential: vi.fn(async () => "token") },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://ilinkai.weixin.qq.com/ilink/bot/getupdates");
  });

  it("sends replies through Weixin iLink sendmessage", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0 })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createWeixinBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.send(createWeixinBot(), {
      botId: "weixin-1",
      provider: "weixin",
      providerUserId: "wx_user",
      text: "hello",
      providerContextToken: "ctx-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      base_info: { channel_version: "2.0.0" },
      msg: {
        from_user_id: "bot-1@im.bot",
        to_user_id: "wx_user",
        client_id: expect.any(String),
        message_type: 2,
        message_state: 2,
        context_token: "ctx-1",
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      },
    });
  });

  it("normalizes multiline replies to hard text line breaks", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0 })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createWeixinBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.send(createWeixinBot(), {
      botId: "weixin-1",
      provider: "weixin",
      providerUserId: "wx_user",
      text: ["Workspace: z-code", "Model: DeepSeek/deepseek-v4-flash", "State: completed"].join("\n"),
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      msg?: { item_list?: Array<{ text_item?: { text?: string } }> };
    };
    expect(body.msg?.item_list?.[0]?.text_item?.text).toBe(
      ["Workspace: z-code", "Model: DeepSeek/deepseek-v4-flash", "State: completed"].join("\r\n"),
    );
  });

  it("sends typing through Weixin iLink sendtyping", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith("/getconfig") ? { ret: 0, typing_ticket: "ticket-1" } : { ret: 0 },
    )));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createWeixinBotProvider({
      loadCredential: vi.fn(async () => "token"),
    });

    await provider.sendTyping?.(createWeixinBot(), { providerUserId: "wx_user", providerContextToken: "ctx-1" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://ilinkai.weixin.qq.com/ilink/bot/getconfig",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ base_info: { channel_version: "2.0.0" }, ilink_user_id: "wx_user", context_token: "ctx-1" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://ilinkai.weixin.qq.com/ilink/bot/sendtyping",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ base_info: { channel_version: "2.0.0" }, ilink_user_id: "wx_user", typing_ticket: "ticket-1", status: 1 }),
      }),
    );
  });

  it("starts and polls built-in Weixin QR login", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/get_bot_qrcode?bot_type=3")) {
        return new Response(JSON.stringify({
        ret: 0,
        qrcode: "qr-key-1",
        qrcode_img_content: "https://liteapp.weixin.qq.com/q/login-1",
        expires_in: 90,
      }));
      }
      return new Response(JSON.stringify({ ret: 0, status: "confirmed", bot_token: "bot-token", ilink_bot_id: "bot-1" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const started = await beginWeixinRegistration();
    expect(started.qrCode).toBe("qr-key-1");
    expect(started.qrUrl).toBe("https://liteapp.weixin.qq.com/q/login-1");
    expect(started).not.toHaveProperty("baseUrl");

    const result = await pollWeixinRegistration({ qrCode: started.qrCode });
    expect(result).toEqual({
      status: "success",
      botToken: "bot-token",
      botId: "bot-1",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr-key-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("keeps Weixin QR polling pending when status request times out", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollWeixinRegistration({ qrCode: "qr-key-1" })).resolves.toEqual({
      status: "pending",
      interval: 3,
    });
  });

});
