import { describe, expect, it, vi } from "vitest";
import { createToolRegistry, registerBuiltInTools } from "../src/tool/index.js";
import {
  cronCreateHandler,
  cronCreateToolEntry,
  cronDeleteHandler,
  cronListHandler,
  cronUpdateHandler,
  cronUpdateToolEntry,
} from "../src/tool/handlers/cron.js";
import { CoreErrorType, type AutomationPort, type TraceId } from "@zcode/contracts";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

function createContext(port?: AutomationPort): ToolExecutionContext {
  return {
    toolCallId: "tool-cron",
    traceId: "trace-cron" as TraceId,
    abortSignal: new AbortController().signal,
    automationPort: port,
    model: createTestRuntimeModel({
      generateText: async () => ({ finishReason: "stop", text: "" }),
      providerId: "zai-api",
      modelId: "GLM-5",
    }),
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionId: "sess-cron" as never,
  };
}

const automation = {
  automationId: "automation-1",
  title: "daily report",
  cronExpr: "0 9 * * *",
  prompt: "write daily report",
  enabled: true,
  lifecycleStatus: "active" as const,
  nextRunAt: 1_700_000_000_000,
  runCount: 0,
  recurring: true,
};

describe("cron tools", () => {
  it("CronCreate 提醒模型在标题中保留用户的时间规则", () => {
    expect(cronCreateToolEntry.metadata.modelInstructions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("preserve the user's natural-language schedule phrase"),
      ]),
    );
  });

  it("CronCreate 向模型说明本地时间、一次性和持久化语义", () => {
    expect(cronCreateToolEntry.metadata.description).toContain("persistent");
    expect(cronCreateToolEntry.metadata.description).toContain("must never ask the run to create");
    expect(cronCreateToolEntry.metadata.modelInstructions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Do not convert to UTC"),
        expect.stringContaining("delayMinutes=3"),
        // 相对延迟必须覆盖小时/中文表述并换算成分钟，避免模型只认“in N minutes”。
        expect.stringContaining("delayMinutes=120"),
        // 根因守卫：pin 绝对 cron 的指令必须显式声明相对一次性改走 delayMinutes，
        // 否则“一次性提醒就 pin 月日时分”会覆盖相对延迟规则，模型自算出会滚到下一年的固定日历 cron。
        expect.stringContaining("must use delayMinutes"),
        expect.stringContaining("recurring=false"),
        expect.stringContaining("maxRuns=N"),
        expect.stringContaining("not session-only or auto-deleted"),
        expect.stringContaining("without adding jitter"),
        expect.stringContaining("Never ask the scheduled run to create"),
      ]),
    );
  });

  it("registerBuiltInTools：只有注入 automation port 时才暴露 Cron 工具", () => {
    const withoutPort = createToolRegistry();
    registerBuiltInTools(withoutPort);
    expect(withoutPort.has("CronCreate")).toBe(false);
    expect(withoutPort.has("CronList")).toBe(false);
    expect(withoutPort.has("CronUpdate")).toBe(false);
    expect(withoutPort.has("CronDelete")).toBe(false);

    const withPort = createToolRegistry();
    registerBuiltInTools(withPort, { includeAutomation: true });
    expect(withPort.has("CronCreate")).toBe(true);
    expect(withPort.has("CronList")).toBe(true);
    expect(withPort.has("CronUpdate")).toBe(true);
    expect(withPort.has("CronDelete")).toBe(true);
  });

  it("CronCreate：通过 automationPort 创建当前 workspace 的定时任务", async () => {
    const port: AutomationPort = {
      create: vi.fn(async () => automation),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    const result = await cronCreateHandler(
      {
        cron: "0 9 * * *",
        delayMinutes: null,
        prompt: "write daily report",
        title: "daily report",
      },
      createContext(port),
    );

    expect(port.create).toHaveBeenCalledWith(
      {
        cron: "0 9 * * *",
        delayMinutes: null,
        prompt: "write daily report",
        title: "daily report",
      },
      {
        model: "zai-api/GLM-5",
        sessionId: "sess-cron",
      },
    );
    expect(result).toMatchObject({
      automation: {
        automationId: "automation-1",
        cronExpr: "0 9 * * *",
      },
    });
  });

  it("CronCreate 透传 interval carrier，并在结果中保留权威 scheduleRule", async () => {
    const intervalAutomation = {
      ...automation,
      cronExpr: "49 * * * *",
      title: "每31小时的第49分提醒",
      scheduleRule: {
        unit: "hourly" as const,
        interval: 31,
        hour: 0,
        minute: 49,
        anchorAt: 1_700_000_000_000,
      },
    };
    const port: AutomationPort = {
      create: vi.fn(async () => intervalAutomation),
      list: vi.fn(async () => [intervalAutomation]),
      update: vi.fn(async () => intervalAutomation),
      delete: vi.fn(),
    };

    const created = await cronCreateHandler(
      {
        cron: "49 * * * *",
        prompt: "提醒我",
        title: "每31小时的第49分提醒",
        intervalUnit: "hourly",
        interval: 31,
      },
      createContext(port),
    );
    const updated = await cronUpdateHandler(
      {
        id: "automation-1",
        title: "每200年提醒",
        cron: "0 9 15 6 *",
        intervalUnit: "yearly",
        interval: 200,
      },
      createContext(port),
    );
    const listed = await cronListHandler({}, createContext(port));

    expect(port.create).toHaveBeenCalledWith(
      expect.objectContaining({ intervalUnit: "hourly", interval: 31 }),
      expect.anything(),
    );
    expect(port.update).toHaveBeenCalledWith(
      expect.objectContaining({ intervalUnit: "yearly", interval: 200 }),
    );
    for (const result of [created.automation, updated.automation, listed.automations[0]]) {
      expect(result).toMatchObject({
        scheduleRule: { unit: "hourly", interval: 31, minute: 49 },
      });
    }
  });

  it("CronUpdate：原地更新当前 workspace 的同一个定时任务", async () => {
    const updatedAutomation = {
      ...automation,
      title: "updated report",
      maxRuns: undefined,
    };
    const port: AutomationPort = {
      create: vi.fn(),
      list: vi.fn(),
      update: vi.fn(async () => updatedAutomation),
      delete: vi.fn(),
    };

    const result = await cronUpdateHandler(
      {
        id: "automation-1",
        title: "updated report",
        recurring: true,
        maxRuns: null,
      },
      createContext(port),
    );

    expect(port.update).toHaveBeenCalledWith({
      id: "automation-1",
      title: "updated report",
      recurring: true,
      maxRuns: null,
    });
    expect(result).toMatchObject({
      automation: {
        automationId: "automation-1",
        title: "updated report",
      },
    });
    expect(cronUpdateToolEntry.metadata.modelInstructions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CronList first"),
        expect.stringContaining("Always pass title"),
        expect.stringContaining("every 5 minutes to every 6 minutes"),
        expect.stringContaining("Do not simulate an update"),
        expect.stringContaining("brief confirmation"),
        expect.stringContaining("fenced code block"),
        expect.stringContaining("updated automation card"),
      ]),
    );
  });

  it("CronList / CronDelete：通过 automationPort 管理当前 workspace 定时任务", async () => {
    const port: AutomationPort = {
      create: vi.fn(),
      list: vi.fn(async () => [automation]),
      update: vi.fn(),
      delete: vi.fn(async () => true),
    };

    await expect(cronListHandler({}, createContext(port))).resolves.toEqual({
      automations: [automation],
    });
    await expect(
      cronDeleteHandler({ id: "automation-1" }, createContext(port)),
    ).resolves.toMatchObject({ deleted: true, id: "automation-1" });
    expect(port.delete).toHaveBeenCalledWith({ id: "automation-1" });
  });

  it("CronDelete：删除不到任务时返回失败结果，避免模型误判为已删除", async () => {
    const port: AutomationPort = {
      create: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(async () => false),
    };

    await expect(cronDeleteHandler({ id: "stale-id" }, createContext(port))).resolves.toEqual({
      deleted: false,
      id: "stale-id",
      message: "Automation stale-id was not found in the current workspace.",
    });
  });

  it("automation turn 即使绕过 provider denylist 也拒绝三个写工具", async () => {
    const port: AutomationPort = {
      create: vi.fn(async () => automation),
      list: vi.fn(async () => [automation]),
      update: vi.fn(async () => automation),
      delete: vi.fn(async () => true),
    };
    const context = { ...createContext(port), automationTurn: true };
    const mutations = [
      () =>
        cronCreateHandler(
          {
            cron: "0 9 * * *",
            delayMinutes: null,
            prompt: "write daily report",
            title: "daily report",
          },
          context,
        ),
      () => cronUpdateHandler({ id: "automation-1", title: "updated", prompt: "updated" }, context),
      () => cronDeleteHandler({ id: "automation-1" }, context),
    ];

    for (const mutation of mutations) {
      await expect(mutation()).rejects.toMatchObject({ type: CoreErrorType.PermissionDenied });
    }
    expect(port.create).not.toHaveBeenCalled();
    expect(port.update).not.toHaveBeenCalled();
    expect(port.delete).not.toHaveBeenCalled();
    await expect(cronListHandler({}, context)).resolves.toEqual({ automations: [automation] });
  });
});
