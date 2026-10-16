import { describe, expect, it, vi } from "vitest";
import { ensureIndependentPlanSupport } from "../src/zcode-agent/independentPlanSupport.js";

describe("独立 Plan 执行端能力", () => {
  it("复用同一 CLI 的成功检查，重建 CLI 后重新检查", async () => {
    const first = { request: vi.fn().mockResolvedValue({ independentPlanState: true }) };
    await ensureIndependentPlanSupport(first as never);
    await ensureIndependentPlanSupport(first as never);
    expect(first.request).toHaveBeenCalledTimes(1);
    const second = { request: vi.fn().mockResolvedValue({ independentPlanState: true }) };
    await ensureIndependentPlanSupport(second as never);
    expect(second.request).toHaveBeenCalledTimes(1);
  });
  it("旧 CLI 不认识能力查询时拒绝，不能只相信新 Host 的版本", async () => {
    const client = { request: vi.fn().mockRejectedValue(new Error("Method not found")) };
    await expect(ensureIndependentPlanSupport(client as never)).rejects.toThrow(
      "proto.independentPlanUnsupported",
    );
  });
});
