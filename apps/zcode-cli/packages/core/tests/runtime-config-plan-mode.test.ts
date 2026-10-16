import { describe, expect, it } from "vitest";
import { createRuntimeSessionModePort } from "../src/runtime/session-mode-port.js";
import { updateConfig } from "../src/runtime/methods/config.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

// 旧 mode=plan 只在兼容入口拆分；新输入的权限与 Plan 可以分别变化。
describe("updateConfig independent Plan", () => {
  it.each(["build", "edit", "guarded", "yolo"] as const)("进入/退出 Plan 保留 %s 权限", (mode) => {
    const fixture = { config: { mode, planEnabled: false }, needsPlanModeExitReminder: false };
    const runtime = fixture as unknown as AgentRuntimeInternal;
    updateConfig.call(runtime, { mode: "plan" });
    expect(fixture.config).toEqual({ mode, planEnabled: true });
    updateConfig.call(runtime, { mode: "plan" });
    expect(fixture.config).toEqual({ mode, planEnabled: true });
    updateConfig.call(runtime, { planEnabled: false });
    expect(fixture.config).toEqual({ mode, planEnabled: false });
    expect(fixture.needsPlanModeExitReminder).toBe(true);
  });
  it("Guarded 的 Enter/Exit 工具只切换 Plan 标记", async () => {
    const runtime = {
      config: { mode: "guarded", planEnabled: false },
      createEvent: (type: unknown, payload: unknown) => ({ type, payload }),
      appendEvent: async () => undefined,
    } as unknown as AgentRuntimeInternal;
    const port = createRuntimeSessionModePort(runtime);
    expect(await port.enterPlanMode()).toMatchObject({ mode: "guarded", planEnabled: true });
    expect(await port.exitPlanMode()).toMatchObject({ mode: "guarded", planEnabled: false });
  });
  it("新提交明确携带 true，改变权限不退出规划", () => {
    const runtime = { config: { mode: "build", planEnabled: true } } as AgentRuntimeInternal;
    updateConfig.call(runtime, { mode: "yolo", planEnabled: true });
    expect(runtime.config).toMatchObject({ mode: "yolo", planEnabled: true });
    updateConfig.call(runtime, { mode: "edit" });
    expect(runtime.config).toMatchObject({ mode: "edit", planEnabled: false });
  });
});
