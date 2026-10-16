import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebhookBotProvider } from "../src/bots/providers/webhookProvider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webhook bot provider", () => {
  it("parses webhook attachments with empty text", () => {
    const provider = createWebhookBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        botId: "webhook-1",
        userId: "user-1",
        text: "",
        attachments: [
          {
            id: "img-1",
            kind: "image",
            filename: "demo.png",
            mimeType: "image/png",
            dataBase64: "AQID",
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
            dataBase64: "AQID",
          }),
        ],
      }),
    ]);
  });

  it("parses structured elicitation responses without text", () => {
    const provider = createWebhookBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    expect(
      provider.parseCallback({
        type: "zcode.bot.elicitation_response",
        botId: "webhook-1",
        userId: "user-1",
        requestId: "elicit-1",
        action: "accept",
        content: { answer: "yes" },
      }),
    ).toEqual([
      expect.objectContaining({
        text: "",
        elicitationResponse: {
          requestId: "elicit-1",
          action: "accept",
          content: { answer: "yes" },
        },
      }),
    ]);
  });

  it("posts outbound replies to the configured webhook URL with the bot secret", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createWebhookBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    await provider.send(
      {
        id: "webhook-1",
        name: "Webhook",
        provider: "webhook",
        enabled: true,
        webhookUrl: "https://example.test/zcode",
        webhookSecretRef: "secret-ref",
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
      },
      {
        botId: "webhook-1",
        provider: "webhook",
        providerUserId: "user-1",
        text: "hello",
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/zcode",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-zcode-bot-secret": "secret",
        }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { type?: string; text?: string };
    expect(body).toMatchObject({ type: "zcode.bot.message", text: "hello" });
  });

  it("posts structured elicitation requests to webhook URLs", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createWebhookBotProvider({
      loadCredential: vi.fn(async () => "secret"),
    });

    await provider.send(
      {
        id: "webhook-1",
        name: "Webhook",
        provider: "webhook",
        enabled: true,
        webhookUrl: "https://example.test/zcode",
        webhookSecretRef: "secret-ref",
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
      },
      {
        botId: "webhook-1",
        provider: "webhook",
        providerUserId: "user-1",
        text: "Question",
        elicitation: {
          requestId: "elicit-1",
          taskId: "task-1",
          runId: "trace-1",
          currentQuestionIndex: 0,
          questions: [
            {
              question: "Pick?",
              header: "Pick",
              options: [{ value: "yes", label: "Yes" }],
            },
          ],
        },
      },
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      type?: string;
      elicitation?: unknown;
    };
    expect(body.type).toBe("zcode.bot.elicitation_request");
    expect(body.elicitation).toMatchObject({ requestId: "elicit-1" });
  });
});
