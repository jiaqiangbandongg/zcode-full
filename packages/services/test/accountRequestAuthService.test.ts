import { describe, expect, it, vi } from "vitest";
import {
  createAccountRequestAuthService,
  type AccountRequestAuthInput,
  type AccountRequestAuthResolver,
} from "../src/index.js";

describe("AccountRequestAuthService", () => {
  it("把一次请求原样委托给注入的 Resolver", async () => {
    const input: AccountRequestAuthInput = {
      providerId: "account:zai-individual-coding-plan",
      modelId: "glm-5",
      accountAccess: {
        type: "zhipu-account",
        family: "zai",
        planKind: "individual-coding-plan",
      },
      reason: "model-request",
    };
    const resolveCurrent = vi.fn(async () => ({
      apiKey: "runtime-key",
      headers: { "x-runtime": "value" },
    }));
    const service = createAccountRequestAuthService({
      resolveCurrent,
    } as AccountRequestAuthResolver);

    await expect(service.resolveCurrent(input)).resolves.toEqual({
      apiKey: "runtime-key",
      headers: { "x-runtime": "value" },
    });
    expect(resolveCurrent).toHaveBeenCalledOnce();
    expect(resolveCurrent).toHaveBeenCalledWith(input);
  });

  it("保留 Resolver 的鉴权失败，不在服务层回退或伪造凭据", async () => {
    const error = new Error("credential unavailable");
    const service = createAccountRequestAuthService({
      resolveCurrent: vi.fn(async () => Promise.reject(error)),
    } as AccountRequestAuthResolver);

    await expect(
      service.resolveCurrent({
        providerId: "account:zai-start-plan",
        modelId: "glm-5",
        accountAccess: {
          type: "zhipu-account",
          family: "zai",
          planKind: "start-plan",
        },
        reason: "model-request",
      }),
    ).rejects.toBe(error);
  });
});
