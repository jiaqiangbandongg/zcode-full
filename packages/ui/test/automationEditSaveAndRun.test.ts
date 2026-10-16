import { describe, expect, it, vi } from "vitest";
import { saveAndRunAutomation } from "@/settings/AutomationEditView.js";

describe("AutomationEditView save and run", () => {
  it("保存当前表单成功后才立即运行", async () => {
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push("save");
      return true;
    });
    const run = vi.fn(async () => {
      order.push("run");
    });

    await expect(saveAndRunAutomation(save, run)).resolves.toBe(true);
    expect(order).toEqual(["save", "run"]);
  });

  it("保存失败时不立即运行", async () => {
    const save = vi.fn(async () => false);
    const run = vi.fn(async () => undefined);

    await expect(saveAndRunAutomation(save, run)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
