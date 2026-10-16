import { afterEach, describe, expect, it, vi } from "vitest";
import { AddressInfo } from "node:net";
import {
  ServiceCollection,
  IBotsService,
  type IBotsService as BotsService,
} from "@zcode/services";
import { createHttpServer } from "../src/http.js";

describe("bots HTTP callback", () => {
  const servers: Array<{ close(callback?: (err?: Error) => void): void }> = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error?: Error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      ),
    );
    servers.length = 0;
  });

  it("forwards provider payload and webhook secret to the bots service", async () => {
    const handleProviderCallback = vi.fn(async () => [
      {
        botId: "webhook-1",
        provider: "webhook" as const,
        providerUserId: "user-1",
        text: "ok",
      },
    ]);
    const handleProviderCallbackResponse = vi.fn(async (_provider: unknown, payload: unknown) => ({
      ok: true,
      replies: await handleProviderCallback("webhook", payload),
    }));
    const services = new ServiceCollection().register(IBotsService, {
      handleProviderCallback,
      handleProviderCallbackResponse,
    } as unknown as BotsService);
    const server = createHttpServer(services, 0);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/bots/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zcode-bot-secret": "secret",
      },
      body: JSON.stringify({
        botId: "webhook-1",
        userId: "user-1",
        text: "/status",
      }),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      replies: [
        {
          botId: "webhook-1",
          provider: "webhook",
          providerUserId: "user-1",
          text: "ok",
        },
      ],
    });
    expect(handleProviderCallbackResponse).toHaveBeenCalledWith("webhook", {
      botId: "webhook-1",
      userId: "user-1",
      text: "/status",
      rawBody: JSON.stringify({
        botId: "webhook-1",
        userId: "user-1",
        text: "/status",
      }),
      webhookSecret: "secret",
    });
  });

  it("rejects unsupported bot providers", async () => {
    const services = new ServiceCollection();
    const server = createHttpServer(services, 0);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/bots/unknown`, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(400);
  });

  it("returns a retryable HTTP status when bot business handling fails", async () => {
    const services = new ServiceCollection().register(IBotsService, {
      handleProviderCallbackResponse: vi.fn(async () => ({
        ok: false,
        replies: [],
        status: 503,
      })),
    } as unknown as BotsService);
    const server = createHttpServer(services, 0);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/bots/webhook`,
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("rejects non-webhook providers on the HTTP callback endpoint", async () => {
    const services = new ServiceCollection();
    const server = createHttpServer(services, 0);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/bots/feishu/feishu-1`, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Provider feishu does not support HTTP callbacks.",
    });
  });
});
