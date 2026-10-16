import { describe, expect, it, vi } from "vitest";
import { getTurnTools } from "../src/runtime/methods/turn-tool-visibility.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createToolRegistry, registerBuiltInTools } from "../src/tool/index.js";
import {
  offPeakCreateHandler,
  offPeakCreateToolEntry,
  offPeakListHandler,
} from "../src/tool/handlers/off-peak.js";
import {
  OFF_PEAK_MUTATION_TOOL_NAMES,
  isOffPeakCreateRestrictedTurn,
  type RegularTurnLoopState,
} from "../src/runtime/methods/turn-loop-state.js";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";
import { workflowToolEntry } from "../src/tool/handlers/workflow.js";
import { CoreErrorType, type OffPeakPort, type TraceId } from "@zcode/contracts";
import type { ToolExecutionContext } from "../src/tool/types.js";

function createContext(port?: OffPeakPort): ToolExecutionContext {
  return {
    toolCallId: "tool-offpeak",
    traceId: "trace-offpeak" as TraceId,
    abortSignal: new AbortController().signal,
    offPeakPort: port,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionId: "sess-offpeak" as never,
  };
}

const task = {
  offPeakTaskId: "offpeak-1",
  title: "重构 utils",
  status: "queued" as const,
  queuePosition: 3,
  createdAt: 1_700_000_000_000,
};

function createPort(overrides?: Partial<OffPeakPort>): OffPeakPort {
  return {
    create: vi.fn(async () => ({ ok: true as const, task })),
    list: vi.fn(async () => [task]),
    ...overrides,
  };
}

describe("off-peak tools", () => {
  it("OffPeakCreate 向模型说明闲时语义、与 CronCreate 的分工和禁止递归", () => {
    expect(offPeakCreateToolEntry.metadata.description).toContain("unattended");
    expect(offPeakCreateToolEntry.metadata.description).toContain("THIS session");
    expect(offPeakCreateToolEntry.metadata.description).not.toContain("fresh session");
    expect(offPeakCreateToolEntry.metadata.modelInstructions.join("\n")).not.toMatch(
      /NEW session|self-contained/,
    );
    expect(offPeakCreateToolEntry.metadata.description).toContain("no guaranteed start time");
    expect(offPeakCreateToolEntry.metadata.description).toContain(
      "must never ask the run to create",
    );
    expect(offPeakCreateToolEntry.metadata.modelInstructions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Choose CronCreate instead"),
        // D50：绑定会话执行，文案不得再宣称新会话/自包含（机审 CR-01）。
        expect.stringContaining("continues THIS conversation"),
        expect.stringContaining("full-automatic mode"),
        expect.stringContaining("Never call OffPeakCreate from within an idle-time task run"),
      ]),
    );
    // D49-7：创建消耗取号额度，必须走审批门（cron 同款）。
    expect(offPeakCreateToolEntry.metadata.needsApproval).toBe(true);
  });

  it("registerBuiltInTools：只有 includeOffPeak 时才暴露 OffPeak 工具（与 automation 门独立）", () => {
    const withoutFlag = createToolRegistry();
    registerBuiltInTools(withoutFlag, { includeAutomation: true });
    expect(withoutFlag.has("OffPeakCreate")).toBe(false);
    expect(withoutFlag.has("OffPeakList")).toBe(false);

    const withFlag = createToolRegistry();
    registerBuiltInTools(withFlag, { includeOffPeak: true });
    expect(withFlag.has("OffPeakCreate")).toBe(true);
    expect(withFlag.has("OffPeakList")).toBe(true);
    expect(withFlag.has("CronCreate")).toBe(false);
  });

  it("OffPeakCreate：透传可选参数并只携带 sessionId 归因上下文", async () => {
    const port = createPort();
    const result = await offPeakCreateHandler(
      {
        title: "重构 utils",
        prompt: "Refactor the utils directory and keep tests green.",
        permissionMode: "build",
        model: "GLM-5.2",
        thoughtLevel: "high",
      },
      createContext(port),
    );

    expect(port.create).toHaveBeenCalledWith(
      {
        title: "重构 utils",
        prompt: "Refactor the utils directory and keep tests green.",
        permissionMode: "build",
        model: "GLM-5.2",
        thoughtLevel: "high",
      },
      { sessionId: "sess-offpeak" },
    );
    expect(result).toMatchObject({
      task: { offPeakTaskId: "offpeak-1", queuePosition: 3 },
      message: expect.stringContaining("#3 in queue"),
    });
  });

  it("闲时派发轮拒绝 OffPeakCreate，但 OffPeakList 只读保留（D49-2）", async () => {
    const port = createPort();
    const context = { ...createContext(port), offPeakTurn: true };

    await expect(offPeakCreateHandler({ title: "t", prompt: "p" }, context)).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
    });
    expect(port.create).not.toHaveBeenCalled();
    await expect(offPeakListHandler({}, context)).resolves.toEqual({ tasks: [task] });
  });

  it("automation 派发轮放行 OffPeakCreate（D49-3 组合玩法，勿照抄 cron 的防御方向）", async () => {
    const port = createPort();
    const context = { ...createContext(port), automationTurn: true };

    await expect(
      offPeakCreateHandler({ title: "定时派生", prompt: "run nightly digest" }, context),
    ).resolves.toMatchObject({ task: { offPeakTaskId: "offpeak-1" } });
    expect(port.create).toHaveBeenCalledTimes(1);
  });

  it("ok:false 判别联合按分类翻译为稳定错误，分类进入错误上下文", async () => {
    const port = createPort({
      create: vi.fn(async () => ({
        ok: false as const,
        failureStage: "ticket_request" as const,
        errorCategory: "quota_3103" as const,
        errorCode: "3103",
      })),
    });

    await expect(
      offPeakCreateHandler({ title: "t", prompt: "p" }, createContext(port)),
    ).rejects.toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      recoverable: false,
      context: expect.objectContaining({ errorCategory: "quota_3103", errorCode: "3103" }),
    });
  });

  it("缺少 offPeakPort 时报 ConfigurationError", async () => {
    await expect(
      offPeakCreateHandler({ title: "t", prompt: "p" }, createContext()),
    ).rejects.toMatchObject({ type: CoreErrorType.ConfigurationError });
    await expect(offPeakListHandler({}, createContext())).rejects.toMatchObject({
      type: CoreErrorType.ConfigurationError,
    });
  });
});

describe("闲时轮拒绝 SendMessage / Workflow（D52，ZCT-2099408932463325184）", () => {
  const sendMessageInput = { to: "agent_1", summary: "s", message: "continue" };
  const workflowInput = { scriptPath: "review.workflow.js" };

  it("denylist 常量同时覆盖 OffPeakCreate、SendMessage、Workflow，且哨兵仍是 OffPeakCreate", () => {
    expect([...OFF_PEAK_MUTATION_TOOL_NAMES]).toEqual(["OffPeakCreate", "SendMessage", "Workflow"]);
    expect(OFF_PEAK_MUTATION_TOOL_NAMES[0]).toBe("OffPeakCreate");
  });

  it("SendMessage 在闲时轮抛 PermissionDenied（recoverable，提示改用前台 Agent），不触达端口", async () => {
    const sendMessage = vi.fn();
    const context = {
      ...createContext(),
      offPeakTurn: true,
      subagentPort: { sendMessage } as never,
    };
    await expect(sendMessageToolEntry.handler(sendMessageInput, context)).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
      recoverable: true,
      message: expect.stringContaining("Spawn a new foreground Agent"),
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("Workflow 在闲时轮抛 PermissionDenied，不触达 WorkflowPort", async () => {
    const start = vi.fn();
    const context = {
      ...createContext(),
      offPeakTurn: true,
      workflowPort: { start } as never,
    };
    await expect(workflowToolEntry.handler(workflowInput, context)).rejects.toMatchObject({
      type: CoreErrorType.PermissionDenied,
      recoverable: true,
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("普通轮与 automation 轮不受影响（D49-3 方向：cron 轮照旧放行）", async () => {
    const sendMessage = vi.fn(async () => ({ status: "success", messageId: "m1" }));
    const start = vi.fn(async () => ({ status: "backgrounded", runId: "wf_1", response: "ok" }));
    for (const extra of [{}, { automationTurn: true }]) {
      const context = {
        ...createContext(),
        ...extra,
        subagentPort: { sendMessage } as never,
        workflowPort: { start } as never,
      };
      await expect(sendMessageToolEntry.handler(sendMessageInput, context)).resolves.toBeDefined();
      await expect(workflowToolEntry.handler(workflowInput, context)).resolves.toBeDefined();
    }
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe("isOffPeakCreateRestrictedTurn", () => {
  function stateOf(partial: {
    offPeakTaskId?: string;
    automationId?: string;
    queryId?: string;
    toolDisallowlist?: readonly string[];
  }): RegularTurnLoopState {
    return {
      ...(partial.offPeakTaskId ? { offPeakTaskId: partial.offPeakTaskId } : {}),
      ...(partial.automationId ? { automationId: partial.automationId } : {}),
      toolDisallowlist: partial.toolDisallowlist,
      turnTraceContext: { queryId: partial.queryId },
    } as unknown as RegularTurnLoopState;
  }

  it("显式 offPeakTaskId 是主信号", () => {
    const state = stateOf({ offPeakTaskId: "offpeak-1" });
    expect(isOffPeakCreateRestrictedTurn(state)).toBe(true);
    const tools = ["OffPeakCreate", "OffPeakList", "Agent"].map((name) => ({ name }));
    const runtime = { getTools: () => tools } as unknown as AgentRuntimeInternal;
    expect(getTurnTools(runtime, state).map((tool) => tool.name)).toEqual(["OffPeakList", "Agent"]);
  });

  it("resume 段 queryId 前缀是兜底信号（首段 traceId 无固定前缀）", () => {
    expect(isOffPeakCreateRestrictedTurn(stateOf({ queryId: "offpeak-1:resume:abc" }))).toBe(true);
  });

  it("turn denylist 含 OffPeakCreate 时同样限制（busy 合并路径）", () => {
    expect(isOffPeakCreateRestrictedTurn(stateOf({ toolDisallowlist: ["OffPeakCreate"] }))).toBe(
      true,
    );
  });

  it("automation 轮不触发闲时限制（D49-3 反向断言）", () => {
    expect(
      isOffPeakCreateRestrictedTurn(
        stateOf({
          automationId: "automation-1",
          queryId: "automation-1:run:abc",
          toolDisallowlist: ["CronCreate", "CronUpdate", "CronDelete"],
        }),
      ),
    ).toBe(false);
  });

  it("普通用户轮不受限", () => {
    expect(isOffPeakCreateRestrictedTurn(stateOf({ queryId: "user-input-1" }))).toBe(false);
  });
});
