import { describe, expect, it, vi } from "vitest";
import {
  ensureIndependentPlanSupport,
  supportsHistoryFirst,
} from "../src/zcode-agent/independentPlanSupport.js";

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

describe("历史先显示执行端能力", () => {
  it("同一 CLI 只查询一次，只有显式 true 才开启", async () => {
    const client = { request: vi.fn().mockResolvedValue({ historyFirst: true }) };
    expect(
      await Promise.all([
        supportsHistoryFirst(client as never),
        supportsHistoryFirst(client as never),
      ]),
    ).toEqual([true, true]);
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(
      await supportsHistoryFirst({
        request: vi.fn().mockResolvedValue({ independentPlanState: true }),
      } as never),
    ).toBe(false);
  });
  it("旧方法或临时请求失败不发送新订阅字段，下一次可重新协商", async () => {
    const client = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error("Method not found"))
        .mockResolvedValue({ historyFirst: true }),
    };
    expect(await supportsHistoryFirst(client as never)).toBe(false);
    expect(await supportsHistoryFirst(client as never)).toBe(true);
  });
});
