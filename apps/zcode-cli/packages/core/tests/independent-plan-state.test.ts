import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createRuntimeSessionModePort } from "../src/runtime/session-mode-port.js";
import { PermissionService } from "../src/permission/service.js";

describe("Todo151 独立 Plan", () => {
  it("持久化失败时不退出 Plan，也不发布成功事件", async () => {
    const fixture = {
      sessionId: "session",
      config: { mode: "yolo", planEnabled: true },
      sessionPersisted: true,
      sessionStore: { saveSessionEntry: vi.fn().mockRejectedValue(new Error("disk full")) },
      rootTraceContext: {},
      appendEvent: vi.fn(),
    };
    const port = createRuntimeSessionModePort(fixture as unknown as AgentRuntimeInternal);
    await expect(port.exitPlanMode({ toolCallId: "exit" as never })).rejects.toThrow("disk full");
    expect(fixture.config).toEqual({ mode: "yolo", planEnabled: true });
    expect(fixture.appendEvent).not.toHaveBeenCalled();
  });

  it("工具进入／批准退出不改变 yolo，状态成对保存", async () => {
    const fixture = {
      sessionId: "session",
      config: { mode: "yolo", planEnabled: false },
      sessionPersisted: true,
      sessionStore: { saveSessionEntry: vi.fn().mockResolvedValue(undefined) },
      rootTraceContext: {},
      createEvent: vi.fn((_type, payload) => ({ payload })),
      appendEvent: vi.fn().mockResolvedValue(undefined),
    };
    const port = createRuntimeSessionModePort(fixture as unknown as AgentRuntimeInternal);
    await port.enterPlanMode({ toolCallId: "enter" as never });
    expect(fixture.config).toMatchObject({ mode: "yolo", planEnabled: true });
    await port.exitPlanMode({ toolCallId: "exit" as never });
    expect(fixture.config).toMatchObject({ mode: "yolo", planEnabled: false });
    expect(fixture.sessionStore.saveSessionEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "runtime/execution_state",
        data: { mode: "yolo", planEnabled: false },
      }),
    );
  });

  it("yolo 不能绕过 Plan 写入限制或计划审批", () => {
    const service = new PermissionService();
    const context = {
      toolName: "Write",
      input: {},
      riskLevel: "low" as const,
      mode: "yolo" as const,
      planEnabled: true,
    };
    expect(service.checkPermission(context, { readOnly: false }).decision).toBe("deny");
    expect(
      service.checkPermission(
        { ...context, toolName: "ExitPlanMode" },
        { requiresUserInteraction: true },
      ).decision,
    ).toBe("ask");
    expect(
      service.checkPermission({ ...context, planEnabled: false }, { readOnly: false }).decision,
    ).toBe("allow");
  });
});
