import { afterEach, describe, expect, it, vi } from "vitest";
import type { IZCodeAgentService } from "@zcode/services";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  type ZCodeAutomation,
} from "@zcode/shared";
import { useAutomationManagementStore } from "@/store/automationManagementStore.js";

function makeAutomation(index: number): ZCodeAutomation {
  const statuses = ["active", "paused", "completed", "failed"] as const;
  return {
    automationId: `automation-${index}`,
    title: `task-${index}`,
    cronExpr: "0 9 * * *",
    prompt: "check repository",
    workspaceKey: "/tmp/ws",
    workspacePath: "/tmp/ws",
    locationKind: "local",
    recurring: true,
    runCount: 0,
    enabled: statuses[index % statuses.length] === "active",
    lifecycleStatus: statuses[index % statuses.length]!,
    dispatchStatus: "idle",
    dispatchAttempts: 0,
    createdAt: index,
    updatedAt: index,
  };
}

describe("automationManagementStore create limit", () => {
  afterEach(() => {
    useAutomationManagementStore.setState(
      useAutomationManagementStore.getInitialState(),
      true,
    );
  });

  it("全状态任务合计达到 20 条后不发送创建 RPC", async () => {
    const agentService = {
      createAutomation: vi.fn(),
    } as unknown as IZCodeAgentService;
    useAutomationManagementStore.setState({
      workspacePath: "/tmp/ws",
      workspaceIdentity: null,
      automations: Array.from({ length: AUTOMATION_CREATE_LIMIT }, (_, index) =>
        makeAutomation(index),
      ),
    });

    await expect(
      useAutomationManagementStore.getState().createAutomation(
        {
          title: "task-over-limit",
          cronExpr: "0 10 * * *",
          prompt: "check limits",
        },
        agentService,
      ),
    ).resolves.toBeNull();

    expect(agentService.createAutomation).not.toHaveBeenCalled();
    expect(useAutomationManagementStore.getState().error).toContain(
      AUTOMATION_CREATE_LIMIT_ERROR_CODE,
    );
  });
});
