import { describe, expect, it, vi } from "vitest";
import {
  CreateWorkflowInputSchema,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  type DynamicWorkflowRunPort,
  type ModelCatalogPort,
} from "@zcode/contracts";
import { applyPermissionInputAdjustments } from "../src/tool/executor/permission-input-adjustments.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import {
  applyWorkflowSettingsAdjustments,
  describeWorkflowSettingsAdjustment,
  withWorkflowAdjustableSettings,
} from "../src/tool/handlers/workflow-settings-adjustment.js";
import type { ToolEntry, ToolInputResolutionContext } from "../src/tool/types.js";

// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」

const PORT = { defaultConcurrency: () => 6 } as unknown as DynamicWorkflowRunPort;
const CATALOG: ModelCatalogPort = {
  listModels: () => [
    { providerId: "openai", modelId: "gpt-5", reasoningLevels: [], current: true },
  ],
};
const CONTEXT: ToolInputResolutionContext = {
  dynamicWorkflowRunPort: PORT,
  modelCatalogPort: CATALOG,
};
const OPTIONS = { errorCode: 400, schema: CreateWorkflowInputSchema };

describe("withWorkflowAdjustableSettings", () => {
  it("overwrites a block the caller supplied: forging it is inert", () => {
    const resolved = withWorkflowAdjustableSettings(
      {
        result: true,
        input: {
          script: "x",
          adjustable_settings: { subagent_model: false, concurrency_ceiling: 99 },
        },
      },
      CONTEXT,
    );
    expect(resolved).toEqual({
      result: true,
      input: { script: "x", adjustable_settings: { subagent_model: true, concurrency_ceiling: 6 } },
    });
  });

  it("writes no block when the shape raises no window, and strips a forged one", () => {
    const resolved = withWorkflowAdjustableSettings(
      { result: true, input: { run_id: "r", max_concurrency: 2, adjustable_settings: {} } },
      CONTEXT,
      (input) => input.script !== undefined,
    );
    expect(resolved).toEqual({ result: true, input: { run_id: "r", max_concurrency: 2 } });
  });

  it("passes a failure through untouched", () => {
    const failure = { result: false as const, errorCode: 400, message: "nope" };
    expect(withWorkflowAdjustableSettings(failure, CONTEXT)).toBe(failure);
  });
});

describe("applyWorkflowSettingsAdjustments", () => {
  it("ignores keys it does not know and content of the wrong shape", () => {
    const input = { script: "x", max_concurrency: 2 };
    expect(applyWorkflowSettingsAdjustments(input, { color: "red" }, CONTEXT, OPTIONS)).toEqual({
      result: true,
      input,
    });
    expect(
      applyWorkflowSettingsAdjustments(input, { max_concurrency: "four" }, CONTEXT, OPTIONS),
    ).toEqual({ result: true, input });
  });

  it("refuses a model when the host has no catalog", () => {
    const outcome = applyWorkflowSettingsAdjustments(
      { script: "x" },
      { subagent_model: "openai/gpt-5" },
      { dynamicWorkflowRunPort: PORT },
      OPTIONS,
    );
    expect(outcome).toMatchObject({ result: false, errorCode: 400 });
  });

  it("a null for a key the input never had changes nothing", () => {
    expect(
      applyWorkflowSettingsAdjustments(
        { script: "x" },
        { subagent_model: null, max_concurrency: null },
        CONTEXT,
        OPTIONS,
      ),
    ).toEqual({ result: true, input: { script: "x" } });
  });

  it("applies a bound above the default as is: the default is not a cap", () => {
    expect(
      applyWorkflowSettingsAdjustments({ script: "x" }, { max_concurrency: 40 }, CONTEXT, OPTIONS),
    ).toEqual({
      result: true,
      input: { script: "x", max_concurrency: 40 },
      applied: { max_concurrency: 40 },
    });
  });
});

describe("describeWorkflowSettingsAdjustment", () => {
  it("says the singular, and leaves the default out when it is unknown", () => {
    expect(describeWorkflowSettingsAdjustment({ max_concurrency: 1 }, undefined)).toBe(
      " Before approving, the user adjusted the settings in the confirmation window: at most 1 subagent runs at once.",
    );
  });

  it("names the default beside a bound above it, and says a null is back to the default", () => {
    expect(describeWorkflowSettingsAdjustment({ max_concurrency: 40 }, 6)).toBe(
      " Before approving, the user adjusted the settings in the confirmation window: at most 40 subagents run at once (the default is 6).",
    );
    expect(describeWorkflowSettingsAdjustment({ max_concurrency: null }, 6)).toBe(
      " Before approving, the user adjusted the settings in the confirmation window: the limit on subagents at once is back to the default.",
    );
  });

  it("says nothing when nothing changed", () => {
    expect(describeWorkflowSettingsAdjustment({}, 6)).toBe("");
  });
});

describe("applyPermissionInputAdjustments", () => {
  const toolCall = { id: createToolCallId("adj"), input: {}, name: "Probe" };
  const traceContext = createRootTraceContext({ sessionId: createSessionId("adj") });

  function deps(): { deps: ToolExecutorDeps; warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn();
    return {
      deps: {
        getWorkingDirectory: () => "/work",
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
        sessionId: createSessionId("adj"),
      } as unknown as ToolExecutorDeps,
      warn,
    };
  }

  it("passes the input through when there is nothing to apply", () => {
    const { deps: executorDeps } = deps();
    expect(
      applyPermissionInputAdjustments({
        adjustments: undefined,
        deps: executorDeps,
        entry: {} as ToolEntry,
        executionInput: { a: 1 },
        toolCall,
        traceContext,
      }),
    ).toEqual({ ok: true, executionInput: { a: 1 } });
  });

  it("runs the call as approved, and logs, when the tool does not apply adjustments", () => {
    const { deps: executorDeps, warn } = deps();
    expect(
      applyPermissionInputAdjustments({
        adjustments: { max_concurrency: 2 },
        deps: executorDeps,
        entry: {} as ToolEntry,
        executionInput: { a: 1 },
        toolCall,
        traceContext,
      }),
    ).toEqual({ ok: true, executionInput: { a: 1 } });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("turns the tool's refusal into a failed tool result", () => {
    const { deps: executorDeps } = deps();
    const outcome = applyPermissionInputAdjustments({
      adjustments: { max_concurrency: 2 },
      deps: executorDeps,
      entry: {
        applyInputAdjustments: () => ({ result: false, errorCode: 23, message: "refused" }),
      } as unknown as ToolEntry,
      executionInput: { a: 1 },
      toolCall,
      traceContext,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.result.success).toBe(false);
  });

  it("hands the tool the resolution context and returns what it applied", () => {
    const { deps: executorDeps } = deps();
    const apply = vi.fn(() => ({ result: true as const, input: { a: 2 }, applied: { a: 2 } }));
    const outcome = applyPermissionInputAdjustments({
      adjustments: { a: 2 },
      deps: executorDeps,
      entry: { applyInputAdjustments: apply } as unknown as ToolEntry,
      executionInput: { a: 1 },
      toolCall,
      traceContext,
    });
    expect(outcome).toEqual({ ok: true, executionInput: { a: 2 }, applied: { a: 2 } });
    expect(apply).toHaveBeenCalledWith(
      { a: 1 },
      { a: 2 },
      expect.objectContaining({ workingDirectory: "/work" }),
    );
  });
});
