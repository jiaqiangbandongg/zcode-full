import { describe, expect, it } from "vitest";
import { createComputerUseRuntime } from "../index.js";
import { callBrokerMethod } from "../broker.js";

describe("Computer Use placeholder", () => {
  it("执行入口明确报告不可用，且不触发真实 broker 准备", async () => {
    let prepared = false;
    const runtime = createComputerUseRuntime({
      ensureBrokerAvailable: async () => {
        prepared = true;
      },
    });
    await expect(
      runtime.execute({
        toolName: "computer_use",
        arguments: {},
        context: { sessionId: "example", runtimeScope: "main", workspaceKey: "example" },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(prepared).toBe(false);
    await runtime.dispose();
  });

  it("broker 方法拒绝执行真实系统能力", async () => {
    await expect(
      callBrokerMethod({ method: "example", socketPath: "unused" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
