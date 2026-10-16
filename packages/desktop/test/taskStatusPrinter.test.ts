import { describe, expect, it, vi } from "vitest";

const { oraMock } = vi.hoisted(() => ({
  oraMock: vi.fn(),
}));

vi.mock("ora", () => ({
  default: oraMock,
}));

import { createStatusPrinter } from "../../../scripts/release-it/task-status-printer.mjs";

describe("createStatusPrinter", () => {
  it("只输出任务名和状态", () => {
    const api = {
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
    };
    oraMock.mockReturnValue(api);

    const printer = createStatusPrinter("改写 changelog");
    printer.start("开始");
    printer.succeed("完成");
    printer.fail("失败");

    expect(oraMock).toHaveBeenCalledWith(
      expect.objectContaining({
        isEnabled: true,
        stream: process.stderr,
      }),
    );
    expect(api.start).toHaveBeenCalledWith("改写 changelog 开始");
    expect(api.succeed).toHaveBeenCalledWith("改写 changelog 完成");
    expect(api.fail).toHaveBeenCalledWith("改写 changelog 失败");
  });
});
