import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireTelegramPollingLock,
  acquireWeixinPollingLock,
  acquireFeishuWebSocketLock,
  BOT_RUNTIME_LOCK_LEASE_MS,
  isBotRuntimeLockConflictError,
  waitFor,
} from "../src/bots/channelRuntime.js";
import { createTelegramChannelRuntime } from "../src/bots/telegramChannelRuntime.js";
import { createWeixinChannelRuntime } from "../src/bots/weixinChannelRuntime.js";
import { createFeishuChannelRuntime } from "../src/bots/feishuChannelRuntime.js";
import { setDataBaseDir } from "../src/paths.js";
import * as f from "./botsService.fixtures.js";

let tempDir: string | null = null;

afterEach(() => {
  vi.useRealTimers();
  setDataBaseDir(null);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("telegram channel runtime", () => {
  it("waits for polling lock release before dispose resolves", async () => {
    let finishRelease: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const release = vi.fn(async () => releaseGate);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/deleteWebhook")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const runtime = createTelegramChannelRuntime({
      credentialService: f.createCredentialService({ "telegram-token": "token" }),
      telegramProvider: null,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.telegramConfig),
      readTelegramOffset: vi.fn(async () => undefined),
      writeTelegramOffset: vi.fn(async () => undefined),
      processProviderCallback: vi.fn(async () => ({ ok: true, status: 200, replies: [] })),
      acquirePollingLock: vi.fn(async () => ({ release })),
    });

    await runtime.refresh(f.telegramConfig);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    let disposed = false;
    const disposing = runtime.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(disposed).toBe(false);
    finishRelease?.();
    await disposing;
    expect(disposed).toBe(true);
  });

  it("reports lock I/O failures and retries without rejecting the background loop", async () => {
    vi.useFakeTimers();
    const statuses = new Map();
    const acquirePollingLock = vi
      .fn()
      .mockRejectedValueOnce(new Error("lock directory unavailable"))
      .mockResolvedValue(null);
    const runtime = createTelegramChannelRuntime({
      credentialService: f.createCredentialService({
        "telegram-token": "token",
      }),
      telegramProvider: {
        test: vi.fn(async () => ({ ok: true, message: "ok" })),
        send: vi.fn(async () => undefined),
        parseCallback: vi.fn(() => []),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      statusSink: {
        getRuntimeStatus: (botId) => statuses.get(botId),
        setRuntimeStatus: (status) => statuses.set(status.botId, status),
      },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.telegramConfig),
      readTelegramOffset: vi.fn(async () => undefined),
      writeTelegramOffset: vi.fn(async () => undefined),
      processProviderCallback: vi.fn(async () => ({
        ok: true,
        status: 200,
        replies: [],
      })),
      acquirePollingLock,
    });

    await runtime.refresh(f.telegramConfig);
    await vi.waitFor(() =>
      expect(statuses.get("telegram-1")).toMatchObject({
        status: "error",
        message: expect.stringContaining("lock directory unavailable"),
      }),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(acquirePollingLock).toHaveBeenCalledTimes(2));
    runtime.dispose();
  });

  it("commits an update offset only after the business callback succeeds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            url.endsWith("/getUpdates")
              ? JSON.stringify({
                  ok: true,
                  result: [{ update_id: 42, message: { text: "hello" } }],
                })
              : JSON.stringify({ ok: true }),
            { status: 200 },
          ),
      ),
    );
    const statuses = new Map();
    const processProviderCallback = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, replies: [] })
      .mockResolvedValue({ ok: true, status: 200, replies: [] });
    const writeTelegramOffset = vi.fn(async () => undefined);
    let runtime: ReturnType<typeof createTelegramChannelRuntime>;
    writeTelegramOffset.mockImplementation(async () => {
      runtime.stopPolling("telegram-1");
    });
    runtime = createTelegramChannelRuntime({
      credentialService: f.createCredentialService({
        "telegram-token": "token",
      }),
      telegramProvider: {
        test: vi.fn(async () => ({ ok: true, message: "ok" })),
        send: vi.fn(async () => undefined),
        parseCallback: vi.fn(() => []),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      statusSink: {
        getRuntimeStatus: (botId) => statuses.get(botId),
        setRuntimeStatus: (status) => statuses.set(status.botId, status),
      },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.telegramConfig),
      readTelegramOffset: vi.fn(async () => undefined),
      writeTelegramOffset,
      processProviderCallback,
      acquirePollingLock: vi.fn(async () => ({
        release: vi.fn(async () => undefined),
      })),
    });

    await runtime.refresh(f.telegramConfig);
    await vi.waitFor(() => expect(processProviderCallback).toHaveBeenCalledTimes(1));
    expect(writeTelegramOffset).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(processProviderCallback).toHaveBeenCalledTimes(2));
    expect(writeTelegramOffset).toHaveBeenCalledWith("telegram-1", 43);
    runtime.dispose();
  });

  it("keeps the latest token when overlapping refreshes wait for the old lock", async () => {
    let releaseOldLock: (() => void) | undefined;
    const oldLockGate = new Promise<void>((resolve) => {
      releaseOldLock = resolve;
    });
    const credentialService = f.createCredentialService({
      "telegram-token": "old-token",
      "telegram-token-b": "token-b",
      "telegram-token-c": "token-c",
    });
    const events: string[] = [];
    const acquirePollingLock = vi.fn(async (token: string) => {
      events.push(`acquire:${token}`);
      return {
        release: vi.fn(async () => {
          events.push(`release-start:${token}`);
          if (token === "old-token") {
            await oldLockGate;
          }
          events.push(`release:${token}`);
        }),
      };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/deleteWebhook")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        events.push("get-updates:old-token");
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const runtime = createTelegramChannelRuntime({
      credentialService,
      telegramProvider: null,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.telegramConfig),
      readTelegramOffset: vi.fn(async () => undefined),
      writeTelegramOffset: vi.fn(async () => undefined),
      processProviderCallback: vi.fn(async () => ({ ok: true, status: 200, replies: [] })),
      acquirePollingLock,
    });

    await runtime.refresh(f.telegramConfig);
    await vi.waitFor(() => expect(events).toContain("acquire:old-token"));
    await vi.waitFor(() => expect(events).toContain("get-updates:old-token"));
    const configB = {
      ...f.telegramConfig,
      bots: f.telegramConfig.bots.map((bot) => ({
        ...bot,
        credentialRef: "telegram-token-b",
      })),
    };
    const configC = {
      ...f.telegramConfig,
      bots: f.telegramConfig.bots.map((bot) => ({
        ...bot,
        credentialRef: "telegram-token-c",
      })),
    };
    const refreshB = runtime.refresh(configB);
    await vi.waitFor(() => expect(events).toContain("release-start:old-token"));
    const refreshC = runtime.refresh(configC);
    releaseOldLock?.();
    await Promise.all([refreshB, refreshC]);
    await vi.waitFor(() => expect(events).toContain("acquire:token-c"));

    expect(events.indexOf("release:old-token")).toBeLessThan(events.indexOf("acquire:token-c"));
    expect(events).not.toContain("acquire:token-b");
    runtime.dispose();
  });

  it("times out a stalled long-poll body, releases its lock, and accepts refreshed config", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const credentialService = f.createCredentialService({
      "telegram-token": "old-token",
      "telegram-token-b": "new-token",
    });
    const release = vi.fn(async () => {
      events.push("release:old-token");
    });
    const acquirePollingLock = vi.fn(async (token: string) => {
      events.push(`acquire:${token}`);
      return token === "old-token" &&
        events.filter((event) => event === "acquire:old-token").length === 1
        ? { release }
        : null;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/deleteWebhook")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
          { status: 200 },
        );
      }),
    );
    const runtime = createTelegramChannelRuntime({
      credentialService,
      telegramProvider: null,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.telegramConfig),
      readTelegramOffset: vi.fn(async () => undefined),
      writeTelegramOffset: vi.fn(async () => undefined),
      processProviderCallback: vi.fn(async () => ({
        ok: true,
        status: 200,
        replies: [],
      })),
      acquirePollingLock,
    });

    await runtime.refresh(f.telegramConfig);
    await vi.waitFor(() => expect(events).toContain("acquire:old-token"));
    // Bugfix 回归：fetch 已返回 headers 但 body 永不结束时，40 秒 deadline 仍需中断读取；
    // 退避结束后 finally 释放锁，配置刷新才能启动新 credential 的 runtime。
    await vi.advanceTimersByTimeAsync(45_000);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

    const refreshedConfig = {
      ...f.telegramConfig,
      bots: f.telegramConfig.bots.map((bot) => ({
        ...bot,
        credentialRef: "telegram-token-b",
      })),
    };
    await runtime.refresh(refreshedConfig);
    await vi.waitFor(() => expect(events).toContain("acquire:new-token"));
    runtime.dispose();
  });
});

describe("weixin channel runtime", () => {
  it("waits for polling lock release before dispose resolves", async () => {
    let finishRelease: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const release = vi.fn(async () => releaseGate);
    const getUpdates = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const runtime = createWeixinChannelRuntime({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.weixinConfig),
      readWeixinGetUpdatesBuf: vi.fn(async () => undefined),
      writeWeixinGetUpdatesBuf: vi.fn(async () => undefined),
      processProviderCallback: vi.fn(async () => ({ ok: true, status: 200, replies: [] })),
      acquirePollingLock: vi.fn(async () => ({ release })),
      getUpdates,
    });

    await runtime.refresh(f.weixinConfig);
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledOnce());
    let disposed = false;
    const disposing = runtime.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(disposed).toBe(false);
    finishRelease?.();
    await disposing;
    expect(disposed).toBe(true);
  });

  it("does not commit buf when the callback returns ok=false", async () => {
    vi.useFakeTimers();
    const processProviderCallback = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, replies: [] })
      .mockResolvedValue({ ok: true, status: 200, replies: [] });
    const writeWeixinGetUpdatesBuf = vi.fn(async () => undefined);
    let runtime: ReturnType<typeof createWeixinChannelRuntime>;
    writeWeixinGetUpdatesBuf.mockImplementation(async () => {
      void runtime.stopPolling("weixin-1");
    });
    runtime = createWeixinChannelRuntime({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.weixinConfig),
      readWeixinGetUpdatesBuf: vi.fn(async () => undefined),
      writeWeixinGetUpdatesBuf,
      processProviderCallback,
      acquirePollingLock: vi.fn(async () => ({
        release: vi.fn(async () => undefined),
      })),
      getUpdates: vi.fn(async () => ({
        messages: [
          {
            text: "hello",
            attachments: [],
            actor: {
              botId: "weixin-1",
              provider: "weixin",
              providerUserId: "user-1",
              chatId: "chat-1",
              providerMessageId: "message-1",
            },
          },
        ],
        rawMessageCount: 1,
        buf: "next-buf",
      })),
    });

    await runtime.refresh(f.weixinConfig);
    await vi.waitFor(() => expect(processProviderCallback).toHaveBeenCalledTimes(1));
    expect(writeWeixinGetUpdatesBuf).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(processProviderCallback).toHaveBeenCalledTimes(2));
    expect(writeWeixinGetUpdatesBuf).toHaveBeenCalledWith("weixin-1", "next-buf");
    runtime.dispose();
  });

  it("keeps the latest credential when refreshes overlap during abort", async () => {
    let releaseOldRequest: (() => void) | undefined;
    const oldRequestGate = new Promise<void>((resolve) => {
      releaseOldRequest = resolve;
    });
    const credentialService = f.createCredentialService({
      "weixin-token": "old-token",
      "weixin-token-b": "token-b",
      "weixin-token-c": "token-c",
    });
    const signals: AbortSignal[] = [];
    const startedCredentialRefs: Array<string | undefined> = [];
    const runtime = createWeixinChannelRuntime({
      credentialService,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.weixinConfig),
      readWeixinGetUpdatesBuf: vi.fn(async () => undefined),
      writeWeixinGetUpdatesBuf: vi.fn(async () => undefined),
      processProviderCallback: vi.fn(async () => ({ ok: true, status: 200, replies: [] })),
      acquirePollingLock: vi.fn(async () => ({
        release: vi.fn(async () => undefined),
      })),
      getUpdates: vi.fn(async ({ bot, signal }) => {
        if (!signal) throw new Error("missing signal");
        signals.push(signal);
        startedCredentialRefs.push(bot.credentialRef);
        return await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              void oldRequestGate.then(() => reject(new DOMException("aborted", "AbortError")));
            },
            { once: true },
          );
        });
      }),
    });

    await runtime.refresh(f.weixinConfig);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const configB = {
      ...f.weixinConfig,
      bots: f.weixinConfig.bots.map((bot) => ({
        ...bot,
        credentialRef: "weixin-token-b",
      })),
    };
    const configC = {
      ...f.weixinConfig,
      bots: f.weixinConfig.bots.map((bot) => ({
        ...bot,
        credentialRef: "weixin-token-c",
      })),
    };
    const refreshB = runtime.refresh(configB);
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
    const refreshC = runtime.refresh(configC);
    releaseOldRequest?.();
    await Promise.all([refreshB, refreshC]);
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    expect(signals[0]?.aborted).toBe(true);
    expect(startedCredentialRefs).toEqual(["weixin-token", "weixin-token-c"]);
    runtime.dispose();
  });

  it("does not poll or commit buf when another host owns the token lock", async () => {
    vi.useFakeTimers();
    const getUpdates = vi.fn();
    const writeWeixinGetUpdatesBuf = vi.fn(async () => undefined);
    const acquirePollingLock = vi.fn(async () => null);
    const runtime = createWeixinChannelRuntime({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.weixinConfig),
      readWeixinGetUpdatesBuf: vi.fn(async () => "owner-buf"),
      writeWeixinGetUpdatesBuf,
      processProviderCallback: vi.fn(async () => ({ ok: true, status: 200, replies: [] })),
      acquirePollingLock,
      getUpdates,
    });

    await runtime.refresh(f.weixinConfig);
    await vi.waitFor(() => expect(acquirePollingLock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(acquirePollingLock).toHaveBeenCalledTimes(2));

    expect(getUpdates).not.toHaveBeenCalled();
    expect(writeWeixinGetUpdatesBuf).not.toHaveBeenCalled();
    runtime.dispose();
  });
});

describe("feishu channel runtime", () => {
  it("reports lock acquisition failures to the service logger", async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const acquireWebSocketLock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rename failed"), { code: "EPERM" }))
      .mockResolvedValue(null);
    const runtime = createFeishuChannelRuntime({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      logger,
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.feishuConfig),
      summarizeCallbackPayload: vi.fn(() => "payload"),
      processProviderCallback: vi.fn(async () => ({ ok: true, status: 200, replies: [] })),
      acquireWebSocketLock,
    });

    await runtime.refresh(f.feishuConfig);
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(undefined, expect.stringContaining("EPERM")),
    );
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("propagates a terminal websocket error, closes the client, and releases the lock", async () => {
    vi.useFakeTimers();
    let rejectTerminated: ((error: Error) => void) | undefined;
    const terminated = new Promise<void>((_resolve, reject) => {
      rejectTerminated = reject;
    });
    const onConnectionInvalidated = vi.fn();
    const close = vi.fn();
    const closeAfterRetry = vi.fn();
    const release = vi.fn(async () => undefined);
    const setRuntimeStatus = vi.fn();
    const startWebSocket = vi
      .fn()
      .mockResolvedValueOnce({ close, terminated })
      .mockResolvedValueOnce({
        close: closeAfterRetry,
        terminated: new Promise<void>(() => undefined),
      });
    const runtime = createFeishuChannelRuntime({
      onConnectionInvalidated,
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.feishuConfig),
      summarizeCallbackPayload: vi.fn(() => "payload"),
      processProviderCallback: vi.fn(async () => ({ ok: true, status: 200, replies: [] })),
      acquireWebSocketLock: vi.fn(async () => ({ release })),
      startWebSocket,
    });

    await runtime.refresh(f.feishuConfig);
    await vi.waitFor(() =>
      expect(setRuntimeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: "connected" }),
      ),
    );
    expect(onConnectionInvalidated).toHaveBeenCalledWith("feishu-1");
    const connection = startWebSocket.mock.calls[0]?.[0] as {
      onConnectionStateChange: (state: string) => void;
    };
    connection.onConnectionStateChange("reconnecting");
    expect(onConnectionInvalidated).toHaveBeenCalledTimes(2);
    rejectTerminated?.(new Error("reconnect exhausted"));
    await vi.waitFor(() =>
      expect(setRuntimeStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          message: expect.stringContaining("reconnect exhausted"),
        }),
      ),
    );
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(startWebSocket).toHaveBeenCalledTimes(2));
    await runtime.dispose();
    expect(closeAfterRetry).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("waits for websocket lock release before dispose resolves", async () => {
    let finishRelease: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const release = vi.fn(async () => releaseGate);
    const close = vi.fn();
    const startWebSocket = vi.fn(async () => ({ close }));
    const runtime = createFeishuChannelRuntime({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.feishuConfig),
      summarizeCallbackPayload: vi.fn(() => "payload"),
      processProviderCallback: vi.fn(async () => ({ ok: true, status: 200, replies: [] })),
      acquireWebSocketLock: vi.fn(async () => ({ release })),
      startWebSocket,
    });

    await runtime.refresh(f.feishuConfig);
    await vi.waitFor(() => expect(startWebSocket).toHaveBeenCalledOnce());
    let disposed = false;
    const disposing = runtime.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(close).toHaveBeenCalledOnce();
    expect(disposed).toBe(false);
    finishRelease?.();
    await disposing;
    expect(disposed).toBe(true);
  });

  it("rejects websocket delivery when the business callback returns ok=false", async () => {
    let onPayload: ((payload: unknown) => Promise<void>) | undefined;
    const runtime = createFeishuChannelRuntime({
      credentialService: f.createCredentialService({
        "feishu-secret": "secret",
      }),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.feishuConfig),
      summarizeCallbackPayload: vi.fn(() => "payload"),
      processProviderCallback: vi.fn(async () => ({
        ok: false,
        status: 401,
        replies: [],
      })),
      acquireWebSocketLock: vi.fn(async () => ({
        release: vi.fn(async () => undefined),
      })),
      startWebSocket: vi.fn(async (params) => {
        onPayload = params.onPayload;
        return { close: vi.fn() };
      }),
    });

    await runtime.refresh(f.feishuConfig);
    await vi.waitFor(() => expect(onPayload).toBeTypeOf("function"));
    await expect(onPayload?.({ event: "card.action.trigger" })).rejects.toThrow(
      "Feishu callback failed: status=401",
    );
    runtime.dispose();
  });

  it("starts only the latest config after an overlapping refresh", async () => {
    let releaseOldLock: (() => void) | undefined;
    const oldLockGate = new Promise<void>((resolve) => {
      releaseOldLock = resolve;
    });
    const credentialService = f.createCredentialService({
      "feishu-secret": "old-secret",
      "feishu-secret-b": "secret-b",
      "feishu-secret-c": "secret-c",
    });
    const events: string[] = [];
    const runtime = createFeishuChannelRuntime({
      credentialService,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
      ensureBotStorageMigrated: vi.fn(async () => undefined),
      readConfig: vi.fn(async () => f.feishuConfig),
      summarizeCallbackPayload: vi.fn(() => "payload"),
      processProviderCallback: vi.fn(async () => ({ ok: true, status: 200, replies: [] })),
      acquireWebSocketLock: vi.fn(async (bot) => ({
        release: vi.fn(async () => {
          events.push(`release-start:${bot.feishuAppId}`);
          if (bot.feishuAppId === "cli_xxx") {
            await oldLockGate;
          }
          events.push(`release:${bot.feishuAppId}`);
        }),
      })),
      startWebSocket: vi.fn(async ({ bot }) => {
        events.push(`start:${bot.feishuAppId}`);
        return { close: () => events.push(`close:${bot.feishuAppId}`) };
      }),
    });

    await runtime.refresh(f.feishuConfig);
    await vi.waitFor(() => expect(events).toContain("start:cli_xxx"));
    const configB = {
      ...f.feishuConfig,
      bots: f.feishuConfig.bots.map((bot) => ({
        ...bot,
        credentialRef: "feishu-secret-b",
        feishuAppId: "cli_b",
      })),
    };
    const configC = {
      ...f.feishuConfig,
      bots: f.feishuConfig.bots.map((bot) => ({
        ...bot,
        credentialRef: "feishu-secret-c",
        feishuAppId: "cli_c",
      })),
    };
    const refreshB = runtime.refresh(configB);
    await vi.waitFor(() => expect(events).toContain("release-start:cli_xxx"));
    const refreshC = runtime.refresh(configC);
    releaseOldLock?.();
    await Promise.all([refreshB, refreshC]);
    await vi.waitFor(() => expect(events).toContain("start:cli_c"));

    expect(events.indexOf("close:cli_xxx")).toBeLessThan(events.indexOf("start:cli_c"));
    expect(events.indexOf("release:cli_xxx")).toBeLessThan(events.indexOf("start:cli_c"));
    expect(events).not.toContain("start:cli_b");
    runtime.dispose();
  });
});

describe("bot channel runtime lock", () => {
  it("classifies directory rename conflicts across platforms", () => {
    expect(isBotRuntimeLockConflictError(Object.assign(new Error(), { code: "EPERM" }))).toBe(true);
    expect(isBotRuntimeLockConflictError(Object.assign(new Error(), { code: "EISDIR" }))).toBe(
      true,
    );
    expect(isBotRuntimeLockConflictError(Object.assign(new Error(), { code: "EACCES" }))).toBe(
      false,
    );
  });

  it("atomically grants a concurrently initialized lock to one host", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-bot-runtime-lock-"));
    setDataBaseDir(tempDir);

    // 回归：旧实现先发布空锁目录再写 owner，并发请求会把初始化中的锁当成 stale 删除。
    const locks = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        acquireTelegramPollingLock("shared-token", `bot-${index}`),
      ),
    );
    const acquired = locks.filter((lock) => lock !== null);

    expect(acquired).toHaveLength(1);
    await acquired[0]?.release();
  });

  it("grants a Weixin token lock to one host and allows takeover after release", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-weixin-runtime-lock-"));
    setDataBaseDir(tempDir);

    const [owner, contender] = await Promise.all([
      acquireWeixinPollingLock("shared-weixin-token", "bot-owner"),
      acquireWeixinPollingLock("shared-weixin-token", "bot-contender"),
    ]);
    const acquired = [owner, contender].filter((lock) => lock !== null);
    expect(acquired).toHaveLength(1);

    await acquired[0]?.release();
    const replacement = await acquireWeixinPollingLock("shared-weixin-token", "bot-replacement");
    expect(replacement).not.toBeNull();
    await replacement?.release();
  });

  it("locks the same Feishu App identity across local bot records", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-feishu-runtime-lock-"));
    setDataBaseDir(tempDir);

    const owner = await acquireFeishuWebSocketLock({
      id: "bot-owner",
      provider: "feishu",
      feishuAppId: " cli_same_app ",
    });
    const contender = await acquireFeishuWebSocketLock({
      id: "bot-contender",
      provider: "feishu",
      feishuAppId: "cli_same_app",
    });

    expect(owner).not.toBeNull();
    expect(contender).toBeNull();
    await owner?.release();
  });

  it("takes over an expired lease even when its PID is alive", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-expired-runtime-lock-"));
    setDataBaseDir(tempDir);
    const token = "pid-reuse-token";
    const nonce = "abandoned-owner";
    const lockHash = createHash("sha256").update(token).digest("hex");
    const lockPath = join(
      tempDir,
      ".zcode",
      "v2",
      "bots-runtime-locks",
      "telegram-polling",
      `${lockHash}.lock`,
    );
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        botId: "abandoned-bot",
        nonce,
        createdAt: Date.now() - BOT_RUNTIME_LOCK_LEASE_MS - 1,
      })}\n`,
    );
    const leasePath = join(lockPath, `lease-${nonce}`);
    writeFileSync(leasePath, "");
    const expiredAt = new Date(Date.now() - BOT_RUNTIME_LOCK_LEASE_MS - 1);
    utimesSync(leasePath, expiredAt, expiredAt);

    const replacement = await acquireTelegramPollingLock(token, "replacement-bot");

    expect(replacement).not.toBeNull();
    await replacement?.release();
  });
});

describe("bot channel runtime wait", () => {
  it("removes the abort listener when the timeout finishes", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    await waitFor(0, controller.signal);

    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes the abort listener when the runtime is aborted", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = waitFor(60_000, controller.signal);

    controller.abort();
    await waiting;

    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
