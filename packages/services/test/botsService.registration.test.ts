import { describe, expect, it, vi } from "vitest";
import * as f from "./botsService.fixtures.js";

describe("botsService registration", () => {
  it("starts Feishu QR app registration", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
      if (body.get("action") === "init") {
        return new Response(JSON.stringify({ supported_auth_methods: ["client_secret"] }));
      }
      return new Response(JSON.stringify({
        device_code: "device-1",
        verification_uri_complete: "https://accounts.feishu.cn/verify?device_code=device-1",
        user_code: "ABCD",
        interval: 2,
        expire_in: 600,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = f.createBotsService({
      credentialService: f.createCredentialService(),
      repo: f.createMemoryRepo({ version: 3, bots: [] }),
      legacyTaskService: f.createLegacyTaskService(),
      broadcastService: f.createBroadcastService(),
    });

    const result = await service.beginFeishuRegistration({ domain: "feishu" });

    expect(result).toMatchObject({
      deviceCode: "device-1",
      userCode: "ABCD",
      interval: 2,
      domain: "feishu",
      pollDomain: "feishu",
    });
    expect(result.qrUrl).toContain("from=sdk");
    expect(result.qrUrl).toContain("source=node-sdk%2Fzcode");
    expect(result.qrUrl).toContain("tp=sdk");
  });

  it("starts Lark QR app registration from the SDK default Feishu issuer", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
      if (body.get("action") === "init") {
        return new Response(JSON.stringify({ supported_auth_methods: ["client_secret"] }));
      }
      return new Response(JSON.stringify({
        device_code: "device-lark",
        verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=LARK",
        user_code: "LARK",
        interval: 2,
        expire_in: 600,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = f.createBotsService({
      credentialService: f.createCredentialService(),
      repo: f.createMemoryRepo({ version: 3, bots: [] }),
      legacyTaskService: f.createLegacyTaskService(),
      broadcastService: f.createBroadcastService(),
    });

    const result = await service.beginFeishuRegistration({ domain: "lark" });

    expect(result).toMatchObject({
      deviceCode: "device-lark",
      userCode: "LARK",
      interval: 2,
      domain: "lark",
      pollDomain: "feishu",
    });
    expect(result.qrUrl).toBe(
      "https://open.feishu.cn/page/launcher?user_code=LARK&from=sdk&source=node-sdk%2Fzcode&tp=sdk",
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://accounts.feishu.cn/oauth/v1/app/registration",
      "https://accounts.feishu.cn/oauth/v1/app/registration",
    ]);
  });

  it("switches Lark QR app registration polling to the Lark issuer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      user_info: { open_id: "ou_owner", tenant_brand: "lark" },
      error: "authorization_pending",
    })));
    vi.stubGlobal("fetch", fetchMock);
    const service = f.createBotsService({
      credentialService: f.createCredentialService(),
      repo: f.createMemoryRepo({ version: 3, bots: [] }),
      legacyTaskService: f.createLegacyTaskService(),
      broadcastService: f.createBroadcastService(),
    });

    await expect(
      service.pollFeishuRegistration({
        deviceCode: "device-lark",
        domain: "lark",
        pollDomain: "feishu",
      }),
    ).resolves.toEqual({
      status: "pending",
      interval: 0,
      domain: "lark",
      pollDomain: "lark",
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://accounts.feishu.cn/oauth/v1/app/registration",
    ]);
  });

  it("polls Feishu QR app registration success", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      client_id: "cli_xxx",
      client_secret: "secret",
      user_info: { open_id: "ou_owner", tenant_brand: "feishu" },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const service = f.createBotsService({
      credentialService: f.createCredentialService(),
      repo: f.createMemoryRepo({ version: 3, bots: [] }),
      legacyTaskService: f.createLegacyTaskService(),
      broadcastService: f.createBroadcastService(),
    });

    await expect(
      service.pollFeishuRegistration({ deviceCode: "device-1", domain: "feishu" }),
    ).resolves.toEqual({
      status: "success",
      appId: "cli_xxx",
      appSecret: "secret",
      domain: "feishu",
      openId: "ou_owner",
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://accounts.feishu.cn/oauth/v1/app/registration",
    ]);
  });

  it("polls Lark QR app registration success after domain switch", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      client_id: "cli_lark",
      client_secret: "secret",
      user_info: { open_id: "ou_owner", tenant_brand: "lark" },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const service = f.createBotsService({
      credentialService: f.createCredentialService(),
      repo: f.createMemoryRepo({ version: 3, bots: [] }),
      legacyTaskService: f.createLegacyTaskService(),
      broadcastService: f.createBroadcastService(),
    });

    await expect(
      service.pollFeishuRegistration({
        deviceCode: "device-lark",
        domain: "lark",
        pollDomain: "lark",
      }),
    ).resolves.toEqual({
      status: "success",
      appId: "cli_lark",
      appSecret: "secret",
      domain: "lark",
      openId: "ou_owner",
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://accounts.larksuite.com/oauth/v1/app/registration",
    ]);
  });


  it("backfills the Feishu bot name when saving scanned credentials", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.endsWith("/application/v6/applications/cli_xxx?lang=zh_cn")) {
        return new Response(JSON.stringify({ code: 999, msg: "not ready" }));
      }
      if (url.endsWith("/application/v6/applications/me?lang=zh_cn")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            app: {
              app_name: "ZCode Assistant",
            },
          },
        }));
      }
      return new Response(JSON.stringify({ code: 999, msg: "unexpected request" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo({ version: 3, bots: [] });
    const service = f.createBotsService({
      credentialService: f.createCredentialService(),
      repo,
      legacyTaskService: f.createLegacyTaskService(),
    });

    const saved = await service.saveBot({
      bot: {
        id: "feishu-1",
        name: "Feishu bot",
        provider: "feishu",
        enabled: false,
        feishuAppId: "cli_xxx",
        allowedWorkspaces: ["*"],
        allowedCommands: f.defaultUserCommands,
        currentOptions: {},
        replyMode: "assistant_changes",
      },
      credentialValue: "secret",
    });

    expect(saved.name).toBe("ZCode Assistant");
    expect((await repo.readConfig()).bots[0]?.name).toBe("ZCode Assistant");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    service.disposeAll();
  });

});
