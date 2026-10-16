import { describe, expect, it, vi } from "vitest";
import { createProviderSettingsConnectivityTester } from "../src/model-provider/providerSettingsConnectivity.js";

describe("Provider Settings connectivity", () => {
  it("只把目标 Environment 与 ModelSelection 交给正式 Model 执行链", async () => {
    const testModelConnectivity = vi.fn(async () => ({ success: true as const }));
    const tester = createProviderSettingsConnectivityTester({ testModelConnectivity });

    await expect(
      tester({
        workspacePath: "/remote/project",
        workspaceIdentity: "ssh:box:/remote/project",
        providerId: "personal-api",
        modelId: "model-a",
      }),
    ).resolves.toEqual({ success: true });
    expect(testModelConnectivity).toHaveBeenCalledWith({
      workspacePath: "/remote/project",
      workspaceIdentity: "ssh:box:/remote/project",
      selection: { providerId: "personal-api", modelId: "model-a" },
    });
  });

  it("原样透传正式 Model 的错误消息，不维护设置页第二套错误分类", async () => {
    const error = Object.assign(new Error("upstream unavailable"), {
      data: { statusCode: 503 },
    });
    const tester = createProviderSettingsConnectivityTester({
      testModelConnectivity: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(
      tester({
        workspacePath: "/workspace/app",
        providerId: "provider-a",
        modelId: "model-a",
      }),
    ).resolves.toEqual({
      success: false,
      error: {
        message: error.message,
      },
    });
  });
});
