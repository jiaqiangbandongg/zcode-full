import { describe, expect, it, vi } from "vitest";
import {
  fetchPersonalCodingPlanEntitlement,
  fetchTeamCodingPlanEntitlement,
} from "../src/bigmodel/codingPlanEntitlement.js";

const active = {
  productId: "personal",
  productName: "GLM Coding Lite",
  status: "VALID",
  inCurrentPeriod: true,
};
function client(data: unknown) {
  return {
    request: vi.fn(async () => new Response(JSON.stringify({ code: 200, success: true, data }))),
  };
}
describe("订阅权益不依赖 quota", () => {
  it.each([
    { data: [active], expected: "available" },
    { data: [{ ...active, inCurrentPeriod: false }], expected: "unavailable" },
    { data: [], expected: "unavailable" },
    { data: null, expected: "unknown" },
    { data: [{}], expected: "unavailable" },
    { data: [{}, active], expected: "available" },
    { data: [{ productName: "Storage" }, active], expected: "available" },
    { data: [null, 42, active], expected: "available" },
    { data: [{ productName: "Coding legacy" }], expected: "unknown" },
    { data: [{ productId: "coding-plan", status: "VALID" }], expected: "unknown" },
    {
      data: [{ productId: 42, productName: "Coding", status: "VALID", inCurrentPeriod: true }],
      expected: "unknown",
    },
    { data: [{ productName: "Coding legacy" }, active], expected: "available" },
    { data: [active, { productName: "Storage" }], expected: "available" },
  ])("个人响应 $expected", async ({ data, expected }) => {
    const apiClient = client(data);
    const result = await fetchPersonalCodingPlanEntitlement({
      apiClient,
      authorization: "personal.secret",
      url: "https://bigmodel.cn/api/biz/subscription/list",
      timeoutMs: 100,
    });
    expect(result.kind).toBe(expected);
    expect(apiClient.request).toHaveBeenCalledExactlyOnceWith(
      "https://bigmodel.cn/api/biz/subscription/list",
      expect.objectContaining({
        headers: { Authorization: "personal.secret" },
      }),
    );
  });
  it.each([
    {
      data: {
        hasSubscription: true,
        status: "EFFECTIVE",
        memberGrantStatus: "VALID",
        productId: "team",
        productName: "团队",
        subscribeEndTime: "2027-08-25",
      },
      expected: "available",
    },
    { data: { hasSubscription: false }, expected: "unavailable" },
    {
      data: {
        hasSubscription: true,
        status: "EXPIRED",
        memberGrantStatus: "UNASSIGNED",
        subscribeEndTime: "2026-08-06",
      },
      expected: "unavailable",
    },
    {
      data: { hasSubscription: true, status: "EFFECTIVE", memberGrantStatus: "UNASSIGNED" },
      expected: "unavailable",
    },
    {
      data: { hasSubscription: true, status: "FUTURE_STATE", memberGrantStatus: "UNASSIGNED" },
      expected: "unknown",
    },
    {
      data: {
        hasSubscription: true,
        status: "EFFECTIVE",
        memberGrantStatus: "FUTURE_STATE",
      },
      expected: "unknown",
    },
    { data: {}, expected: "unknown" },
    { data: null, expected: "unknown" },
  ])("团队响应 $expected", async ({ data, expected }) => {
    const apiClient = client(data);
    const result = await fetchTeamCodingPlanEntitlement({
      apiClient,
      authorization: "business-token",
      host: "https://bigmodel.cn",
      teamContext: { organizationId: "org", projectId: "project" },
      timeoutMs: 100,
    });
    expect(result.kind).toBe(expected);
    expect(apiClient.request).toHaveBeenCalledExactlyOnceWith(
      "https://bigmodel.cn/api/biz/team/subscribe/product/querySubscribeDetail",
      expect.objectContaining({
        headers: {
          Authorization: "business-token",
          "bigmodel-organization": "org",
          "bigmodel-project": "project",
        },
      }),
    );
    if (result.kind === "available")
      expect(result.subscription).toMatchObject({
        productId: "team",
        subscribeEndTime: "2027-08-25",
      });
  });
});

describe("个人与团队共享响应 envelope 兼容", () => {
  it.each([
    { envelope: { success: true }, expected: "available" },
    { envelope: {}, expected: "available" },
    { envelope: { code: 0 }, expected: "available" },
    { envelope: { code: 200 }, expected: "available" },
    { envelope: { code: 500, success: true }, expected: "unknown" },
    { envelope: { code: 0, success: false }, expected: "unknown" },
    { envelope: { code: null }, expected: "unknown" },
    { envelope: { code: "200" }, expected: "unknown" },
  ])("$envelope => $expected", async ({ envelope, expected }) => {
    const apiClient = {
      request: vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify({
              ...envelope,
              data: url.endsWith("subscription/list")
                ? [active]
                : {
                    hasSubscription: true,
                    status: "EFFECTIVE",
                    memberGrantStatus: "VALID",
                  },
            }),
          ),
      ),
    };
    expect(
      (
        await fetchPersonalCodingPlanEntitlement({
          apiClient,
          authorization: "key",
          url: "https://bigmodel.cn/api/biz/subscription/list",
          timeoutMs: 100,
        })
      ).kind,
    ).toBe(expected);
    expect(
      (
        await fetchTeamCodingPlanEntitlement({
          apiClient,
          authorization: "business",
          host: "https://bigmodel.cn",
          teamContext: { organizationId: "org", projectId: "project" },
          timeoutMs: 100,
        })
      ).kind,
    ).toBe(expected);
  });
});
