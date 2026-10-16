import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMarketingTouchService } from "#src/marketing-touch/marketingTouchService.js";

function fixture(createService = createMarketingTouchService) {
  let token: string | null = "first-token";
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ code: 0, data: { server_time: 1, language: "en-US", deliveries: [] } }),
      ),
  );
  const service = createService({
    apiClient: { request },
    getToken: async () => token,
    getDeviceMid: () => "550e8400-e29b-41d4-a716-446655440000",
    baseUrl: "https://api.example.com",
    appVersion: "3.11.2",
  });
  return {
    service,
    request,
    setToken: (next: string | null) => {
      token = next;
    },
  };
}

describe("MarketingTouchService", () => {
  it("supplies common headers, original campaign ID and no unsupported event fields", async () => {
    const f = fixture();
    const snapshot = await f.service.query({ locale: "en-US" });
    await f.service.report({
      locale: "en-US",
      scope: snapshot.scope,
      campaignId: "193001",
      actionType: "confirm",
    });
    const [url, init] = f.request.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/v1/marketing/touch/action");
    expect(new Headers(init.headers).get("X-Device-Mid")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(new Headers(init.headers).get("X-Client-Language")).toBe("en-US");
    expect(new Headers(init.headers).get("X-ZCode-App-Version")).toBe("3.11.2");
    expect(JSON.parse(String(init.body))).toEqual({
      campaign_id: "193001",
      action_type: "confirm",
    });
    expect(JSON.stringify(snapshot)).not.toContain("first-token");
  });
  it("refuses to report an old operation using a new account", async () => {
    const f = fixture();
    const snapshot = await f.service.query({ locale: "en-US" });
    f.setToken("second-token");
    await expect(
      f.service.report({
        locale: "en-US",
        scope: snapshot.scope,
        campaignId: "193001",
        actionType: "cancel",
      }),
    ).rejects.toThrow("marketing_identity_changed");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("allows anonymous delivery and does not retry uncertain reports", async () => {
    const f = fixture();
    f.setToken(null);
    const snapshot = await f.service.query({ locale: "en-US" });
    f.request.mockRejectedValueOnce(new Error("network"));
    await expect(
      f.service.report({
        locale: "en-US",
        scope: snapshot.scope,
        campaignId: "193001",
        actionType: "cancel",
      }),
    ).rejects.toThrow("network");
    expect(f.request).toHaveBeenCalledTimes(2);
    const [, init] = f.request.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });
});

describe("MarketingTouchService boot request sequence", () => {
  let createService: typeof createMarketingTouchService;
  beforeEach(async () => {
    vi.resetModules();
    ({ createMarketingTouchService: createService } =
      await import("#src/marketing-touch/marketingTouchService.js"));
  });

  function sequences(f: ReturnType<typeof fixture>) {
    return f.request.mock.calls.map((call) =>
      new URL((call as unknown as [string])[0]).searchParams.get("seq"),
    );
  }

  it("starts at zero, continues across accounts, locales and service instances", async () => {
    const f = fixture(createService);
    await f.service.query({ locale: "en-US" });
    f.setToken(null);
    await f.service.query({ locale: "zh-CN" });
    f.setToken("second-token");
    await f.service.query({ locale: "en-US" });
    expect(sequences(f)).toEqual(["0", "1", "2"]);
    const next = fixture(createService);
    await next.service.query({ locale: "en-US" });
    expect(sequences(next)).toEqual(["3"]);
  });

  it("counts failed and concurrent requests without reusing a sequence", async () => {
    const f = fixture(createService);
    f.request.mockRejectedValueOnce(new Error("network"));
    await expect(f.service.query({ locale: "en-US" })).rejects.toThrow("network");
    f.request.mockResolvedValueOnce(new Response("invalid JSON"));
    await expect(f.service.query({ locale: "en-US" })).rejects.toThrow();
    await Promise.all([f.service.query({ locale: "en-US" }), f.service.query({ locale: "en-US" })]);
    expect(sequences(f)).toEqual(["0", "1", "2", "3"]);
  });

  it("does not count validation failures or action reports", async () => {
    const f = fixture(createService);
    await expect(f.service.query({ locale: "invalid" as "en-US" })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    const snapshot = await f.service.query({ locale: "en-US" });
    await f.service.report({
      locale: "en-US",
      scope: snapshot.scope,
      campaignId: "193001",
      actionType: "cancel",
    });
    await f.service.query({ locale: "en-US" });
    expect(sequences(f)).toEqual(["0", null, "1"]);
  });

  it("starts at zero in a freshly initialized process module", async () => {
    const f = fixture(createService);
    await f.service.query({ locale: "en-US" });
    expect(sequences(f)).toEqual(["0"]);
  });
});
