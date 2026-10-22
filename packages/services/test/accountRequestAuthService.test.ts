import { describe, expect, it, vi } from "vitest";
import { createAccountRequestAuthService, type AccountRequestAuthResolver } from "../src/index.js";

describe("AccountRequestAuthService", () => {
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
