import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchZaiStartPlanBalanceEnvelope } from "../src/model-provider/zaiStartPlanBilling.js";

const response = () => new Response(JSON.stringify({ code: 0, data: { plans: [], balances: [] } }));
afterEach(() => vi.useRealTimers());
describe("Start balance 共享读取", () => {
  it("权益检查完成后，用量查询在一秒内复用；到期后重新请求", async () => {
    vi.useFakeTimers();
    const api = { request: vi.fn(async () => response()) };
    const first = await fetchZaiStartPlanBalanceEnvelope(api, "Bearer account-a");
    await vi.advanceTimersByTimeAsync(999);
    expect(await fetchZaiStartPlanBalanceEnvelope(api, "Bearer account-a")).toBe(first);
    expect(api.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await fetchZaiStartPlanBalanceEnvelope(api, "Bearer account-a");
    expect(api.request).toHaveBeenCalledTimes(2);
  });
  it("429 在窗口内不重复发起，下一窗口可以重试", async () => {
    vi.useFakeTimers();
    const api = { request: vi.fn(async () => new Response("limited", { status: 429 })) };
    await expect(fetchZaiStartPlanBalanceEnvelope(api, "a")).rejects.toThrow();
    await expect(fetchZaiStartPlanBalanceEnvelope(api, "a")).rejects.toThrow();
    expect(api.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(fetchZaiStartPlanBalanceEnvelope(api, "a")).rejects.toThrow();
    expect(api.request).toHaveBeenCalledTimes(2);
  });
  it("不同账号不共享", async () => {
    const api = { request: vi.fn(async () => response()) };
    await fetchZaiStartPlanBalanceEnvelope(api, "a");
    await fetchZaiStartPlanBalanceEnvelope(api, "b");
    expect(api.request).toHaveBeenCalledTimes(2);
  });
});

it("失效后重新读取，旧请求完成不得覆盖或删除新快照", async () => {
  vi.useFakeTimers();
  let finish!: (value: Response) => void;
  const api = {
    request: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            finish = r;
          }),
      )
      .mockImplementation(async () => response()),
  };
  const old = fetchZaiStartPlanBalanceEnvelope(api, "a");
  await vi.advanceTimersByTimeAsync(1100);
  const current = await fetchZaiStartPlanBalanceEnvelope(api, "a", true);
  finish(response());
  await old;
  expect(await fetchZaiStartPlanBalanceEnvelope(api, "a")).toBe(current);
  expect(api.request).toHaveBeenCalledTimes(2);
});

it("请求超过一秒仍合并未完成的读取", async () => {
  vi.useFakeTimers();
  let finish!: (value: Response) => void;
  const api = {
    request: vi.fn(
      () =>
        new Promise<Response>((r) => {
          finish = r;
        }),
    ),
  };
  const first = fetchZaiStartPlanBalanceEnvelope(api, "a");
  await vi.advanceTimersByTimeAsync(1100);
  const second = fetchZaiStartPlanBalanceEnvelope(api, "a");
  expect(api.request).toHaveBeenCalledTimes(1);
  finish(response());
  expect(await second).toBe(await first);
});

it("HTTP Date 已越过到期日时不信任旧 JSON 时间和 active 状态", async () => {
  const body = {
    code: 0,
    data: {
      server_time: 1788448680,
      plans: [
        { user_plan_id: "old", plan_id: "start", status: "active", ends_at: 1788796799 },
        { user_plan_id: "new", plan_id: "start", status: "active", ends_at: 1791000000 },
      ],
      balances: [
        { user_plan_id: "old", plan_id: "start", remaining_units: 3000000 },
        { user_plan_id: "new", plan_id: "start", remaining_units: 5000000 },
      ],
    },
  };
  const api = {
    request: vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          headers: { Date: "Thu, 17 Sep 2026 13:42:46 GMT" },
        }),
    ),
  };
  const result = await fetchZaiStartPlanBalanceEnvelope(api, "expired-account");
  expect(result.data?.plans?.map((p) => p.status)).toEqual(["expired", "active"]);
  expect(result.data?.balances?.map((b) => b.user_plan_id)).toEqual(["new"]);
  expect(body.data.plans[0].status).toBe("active");
});
