import { afterEach, describe, expect, it, vi } from "vitest";
import { BIGMODEL_PROVIDER_ID, type OAuthTokenSet } from "@zcode/shared";
import { OAuthService } from "#src/oauth/oauthService.js";
import { parseOAuthLoginAttribution } from "#src/oauth/callbackAttribution.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const services: OAuthService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.cancelPending()));
});

async function setup() {
  let now = 2_000_000_000_000;
  const credentials = new Map<string, string>();
  const exchange = deferred<OAuthTokenSet>();
  const normalize = deferred<OAuthTokenSet>();
  const pollResponse = deferred<Response>();
  const parse = vi.fn((url: string) => {
    const params = new URL(url).searchParams;
    return {
      code: params.get("code")!,
      state: params.get("state")!,
      attribution: parseOAuthLoginAttribution(params),
    };
  });
  const exchangeToken = vi.fn(() => exchange.promise);
  const normalizePolledTokenSet = vi.fn(() => normalize.promise);
  const request = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/init")
      ? Response.json({
          code: 0,
          data: {
            authorize_url: "https://example.com/authorize?state=race-state&channel_id=launch",
            expires_at: 2_000_000_300,
            flow_id: "race",
            poll_interval_sec: 1,
          },
        })
      : pollResponse.promise,
  );
  const save = vi.fn(async (key: string, value: string) => {
    credentials.set(key, value);
  });
  const service = new OAuthService(
    {
      load: async (key) => credentials.get(key) ?? null,
      save,
      delete: async (key) => {
        credentials.delete(key);
      },
    },
    {
      now: () => now,
      apiClient: { request },
      adapters: [
        {
          providerId: BIGMODEL_PROVIDER_ID,
          meta: { id: BIGMODEL_PROVIDER_ID, displayName: "BigModel", enabled: true, order: 1 },
          redirectUri: "zcode://oauth/callback",
          buildAuthorizeUrl: () => "",
          parseCallbackParams: parse,
          exchangeToken,
          normalizePolledTokenSet,
          normalizeError: (e) => (e instanceof Error ? e : new Error(String(e))),
        },
      ],
    },
  );
  services.push(service);
  const started = await service.startOAuthWithPolling(BIGMODEL_PROVIDER_ID);
  expect(new URL(started.authorizeUrl).searchParams.get("channel_id")).toBe("launch");
  const callback =
    "zcode://oauth/callback?state=race-state&code=code&channel_id=desktop&utm_source=site&utm_campaign=launch";
  const ready = () =>
    pollResponse.resolve(
      Response.json({
        code: 0,
        data: {
          status: "ready",
          token: "poll-jwt",
          user: { user_id: "user", name: "User" },
          bigmodel: { access_token: "poll-token" },
        },
      }),
    );
  return {
    service,
    advanceTime: (milliseconds: number) => {
      now += milliseconds;
    },
    credentials,
    save,
    exchange,
    normalize,
    pollResponse,
    parse,
    exchangeToken,
    normalizePolledTokenSet,
    callback,
    ready,
  };
}

const attribution = JSON.stringify({
  channel_id: "desktop",
  utm_source: "site",
  utm_campaign: "launch",
});
describe("OAuth completion arbitration", () => {
  it.each(["callback", "poll"] as const)(
    "%s first succeeds: skips the second exchange but preserves attribution",
    async (first) => {
      const f = await setup();
      const firstCall =
        first === "callback" ? f.service.handleCallback(f.callback) : f.service.pollPendingOAuth();
      f.ready();
      await vi.waitFor(() =>
        expect(
          first === "callback" ? f.exchangeToken : f.normalizePolledTokenSet,
        ).toHaveBeenCalledOnce(),
      );
      const secondCall =
        first === "callback" ? f.service.pollPendingOAuth() : f.service.handleCallback(f.callback);
      await new Promise((resolve) => setImmediate(resolve));
      expect(first === "callback" ? f.normalizePolledTokenSet : f.parse).not.toHaveBeenCalled();
      (first === "callback" ? f.exchange : f.normalize).resolve({
        accessToken: "winner",
        zcodeJwtToken: "winner-jwt",
      });
      expect(await firstCall).toMatchObject({ kind: "session" });
      const secondResult = await secondCall;
      expect(secondResult?.kind).not.toBe("session");
      expect(f.credentials.get("oauth:bigmodel:access_token")).toBe("winner");
      expect(f.credentials.get("oauth:login_attribution")).toBe(attribution);
      expect(f.save.mock.calls.filter(([key]) => key === "oauth:active_provider")).toHaveLength(1);
    },
  );

  it.each(["callback", "poll"] as const)(
    "%s first fails: queued alternative succeeds without propagating failure",
    async (first) => {
      const f = await setup();
      const firstCall =
        first === "callback" ? f.service.handleCallback(f.callback) : f.service.pollPendingOAuth();
      f.ready();
      await vi.waitFor(() =>
        expect(
          first === "callback" ? f.exchangeToken : f.normalizePolledTokenSet,
        ).toHaveBeenCalledOnce(),
      );
      const secondCall =
        first === "callback" ? f.service.pollPendingOAuth() : f.service.handleCallback(f.callback);
      await new Promise((resolve) => setImmediate(resolve));
      (first === "callback" ? f.exchange : f.normalize).reject(new Error("first route failed"));
      (first === "callback" ? f.normalize : f.exchange).resolve({
        accessToken: "fallback",
        zcodeJwtToken: "fallback-jwt",
      });
      const results = await Promise.all([firstCall, secondCall]);
      expect(results.filter((r) => r?.kind === "session")).toHaveLength(1);
      expect(f.credentials.get("oauth:bigmodel:access_token")).toBe("fallback");
      expect(f.credentials.get("oauth:login_attribution")).toBe(attribution);
    },
  );

  it("preserves attribution from a late callback without parsing its code", async () => {
    const f = await setup();
    f.ready();
    f.normalize.resolve({ accessToken: "poll", zcodeJwtToken: "jwt" });
    await f.service.pollPendingOAuth();
    expect(await f.service.handleCallback(f.callback)).toMatchObject({ kind: "duplicate" });
    expect(f.parse).not.toHaveBeenCalled();
    expect(f.credentials.get("oauth:login_attribution")).toBe(attribution);
    await expect(
      f.service.handleCallback(f.callback.replace("race-state", "wrong-state")),
    ).rejects.toThrow();
    expect(f.credentials.get("oauth:login_attribution")).toBe(attribution);
  });
  it.each(["callback", "poll"] as const)(
    "%s first and both paths fail: reports failure without credentials",
    async (first) => {
      const f = await setup();
      const a =
        first === "callback" ? f.service.handleCallback(f.callback) : f.service.pollPendingOAuth();
      f.ready();
      await vi.waitFor(() =>
        expect(
          first === "callback" ? f.exchangeToken : f.normalizePolledTokenSet,
        ).toHaveBeenCalledOnce(),
      );
      const b =
        first === "callback" ? f.service.pollPendingOAuth() : f.service.handleCallback(f.callback);
      const results = Promise.allSettled([a, b]);
      await new Promise((resolve) => setImmediate(resolve));
      const firstError = new Error("first failed");
      const secondError = new Error("second failed");
      (first === "callback" ? f.exchange : f.normalize).reject(firstError);
      await vi.waitFor(() =>
        expect(
          first === "callback" ? f.normalizePolledTokenSet : f.exchangeToken,
        ).toHaveBeenCalledOnce(),
      );
      (first === "callback" ? f.normalize : f.exchange).reject(secondError);
      expect(await results).toEqual([
        { status: "rejected", reason: firstError },
        { status: "rejected", reason: secondError },
      ]);
      expect(f.credentials.has("oauth:active_provider")).toBe(false);
      expect(await f.service.pollPendingOAuth()).toBeNull();
    },
  );

  it("cancellation skips a queued callback including its attribution", async () => {
    const f = await setup();
    const poll = f.service.pollPendingOAuth();
    f.ready();
    await vi.waitFor(() => expect(f.normalizePolledTokenSet).toHaveBeenCalledOnce());
    const callback = f.service.handleCallback(f.callback);
    await f.service.cancelPending();
    f.normalize.resolve({ accessToken: "cancelled" });
    expect(await poll).toBeNull();
    expect(await callback).toBeNull();
    expect(f.credentials.size).toBe(0);
    expect(f.parse).not.toHaveBeenCalled();
  });

  it("a stale HTTP 401 cannot clear a replacement flow", async () => {
    const f = await setup();
    const oldPoll = f.service.pollPendingOAuth();
    await f.service.startOAuthWithPolling(BIGMODEL_PROVIDER_ID);
    f.pollResponse.resolve(Response.json({ code: 401 }, { status: 401 }));
    expect(await oldPoll).toBeNull();
    f.exchange.resolve({ accessToken: "new-flow" });
    expect(await f.service.handleCallback(f.callback)).toMatchObject({ kind: "session" });
    expect(f.credentials.get("oauth:bigmodel:access_token")).toBe("new-flow");
  });

  it("ignores an invalid polling result when the earlier callback succeeds", async () => {
    const f = await setup();
    const callback = f.service.handleCallback(f.callback);
    await vi.waitFor(() => expect(f.exchangeToken).toHaveBeenCalledOnce());
    const poll = f.service.pollPendingOAuth();
    f.pollResponse.resolve(Response.json({ code: 0, data: { status: "invalid" } }));
    await new Promise((resolve) => setImmediate(resolve));
    f.exchange.resolve({ accessToken: "winner" });
    expect(await callback).toMatchObject({ kind: "session" });
    expect(await poll).toMatchObject({ kind: "duplicate" });
    expect(f.normalizePolledTokenSet).not.toHaveBeenCalled();
  });
  it("does not accept attribution after a completed flow is cancelled", async () => {
    const f = await setup();
    f.ready();
    f.normalize.resolve({ accessToken: "poll" });
    await f.service.pollPendingOAuth();
    await f.service.cancelPending();
    await expect(f.service.handleCallback(f.callback)).rejects.toThrow("OAuth state");
    expect(f.credentials.has("oauth:login_attribution")).toBe(false);
  });
});

it.each(["pending", "completed"])(
  "keeps %s callbacks admitted before the grace deadline",
  async (phase) => {
    const f = await setup();
    const gate = deferred<void>();
    f.save.mockImplementation(async (key, value) => {
      if (key === "oauth:login_attribution") await gate.promise;
      f.credentials.set(key, value);
    });
    const poll = f.service.pollPendingOAuth();
    f.ready();
    await vi.waitFor(() => expect(f.normalizePolledTokenSet).toHaveBeenCalledOnce());
    if (phase === "completed") {
      f.normalize.resolve({ accessToken: "winner" });
      await poll;
    }
    const first = f.service.handleCallback(f.callback);
    const second = f.service.handleCallback(
      f.callback.replace("utm_campaign=launch", "utm_campaign=queued"),
    );
    f.normalize.resolve({ accessToken: "winner" });
    await poll;
    await vi.waitFor(() =>
      expect(f.save.mock.calls.some(([key]) => key === "oauth:login_attribution")).toBe(true),
    );
    f.advanceTime(30_001);
    gate.resolve();
    expect(await first).toMatchObject({ kind: "duplicate" });
    expect(await second).toMatchObject({ kind: "duplicate" });
    expect(JSON.parse(f.credentials.get("oauth:login_attribution")!).utm_campaign).toBe("queued");
    expect(f.parse).not.toHaveBeenCalled();
    await expect(f.service.handleCallback(f.callback)).rejects.toThrow("OAuth state");
  },
);
