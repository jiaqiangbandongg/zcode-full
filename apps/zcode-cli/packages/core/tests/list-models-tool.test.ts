import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type ListModelsOutput,
  type ModelCatalogEntry,
  type ModelCatalogPort,
  type PermissionRequestedPayload,
  type SessionEvent,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { listModelsToolEntry } from "../src/tool/handlers/list-models.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolExecutionContext, ToolHandlerFailure } from "../src/tool/types.js";

function entry(
  providerId: string,
  modelId: string,
  extra: Partial<ModelCatalogEntry> = {},
): ModelCatalogEntry {
  return { providerId, modelId, reasoningLevels: [], current: false, ...extra };
}

interface RunOutcome {
  listCalls: number;
  permissionRequested: PermissionRequestedPayload[];
  result: ToolExecutionResult;
}

/**
 * 端口缺席（`entries === undefined`）是一等场景，不是"忘了接线"：本工具必须回结构化失败而不是
 * 空目录。计数 `listCalls` 是为了钉住「每次调用都现读活视图」那条端口约定的**调用侧**一半。
 */
async function run(name: string, entries: ModelCatalogEntry[] | undefined): Promise<RunOutcome> {
  const sessionId = createSessionId(name);
  const turnId = createTurnId(name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];
  let listCalls = 0;

  const registry = createToolRegistry();
  registry.register(listModelsToolEntry);

  const modelCatalogPort: ModelCatalogPort | undefined =
    entries === undefined
      ? undefined
      : {
          listModels() {
            listCalls += 1;
            return entries;
          },
        };

  const executor = createToolExecutor({
    emitEvent: async (event) => {
      events.push(event);
    },
    ...(modelCatalogPort === undefined ? {} : { modelCatalogPort }),
    mode: "build",
    permissionBroker: {
      async requestPermission() {
        return { decision: "allow" as const };
      },
    },
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
    workingDirectory: "/workspace/never-read",
  });

  const result = await executor.execute(
    { id: createToolCallId(name), input: {}, name: "ListModels" },
    { traceContext },
  );

  return {
    listCalls,
    permissionRequested: events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => event.payload as PermissionRequestedPayload),
    result,
  };
}

describe("ListModels", () => {
  it("lists the catalog without asking for permission, and marks the session's model", async () => {
    const outcome = await run("list-models-basic", [
      entry("bigmodel", "glm-4.6", {
        providerLabel: "BigModel",
        reasoningLevels: ["low", "high"],
        defaultReasoningLevel: "high",
        contextWindow: 200_000,
        current: true,
      }),
      entry("openai", "gpt-5", { providerLabel: "OpenAI" }),
    ]);

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
    expect(outcome.listCalls).toBe(1);

    const output = outcome.result.output as ListModelsOutput;
    expect(output.current).toBe("bigmodel/glm-4.6");
    expect(output.models).toHaveLength(2);
    // `id` 是可以逐字抄进 `subagent_model` 的那一半：不带档位。
    expect(output.models[0]).toEqual({
      id: "bigmodel/glm-4.6",
      providerId: "bigmodel",
      modelId: "glm-4.6",
      providerLabel: "BigModel",
      reasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
      contextWindow: 200_000,
    });
    // 没有档位的模型给空数组（读侧据此知道接 `$` 是错的），其余可选字段整个缺席。
    expect(output.models[1]!.reasoningLevels).toEqual([]);
    expect("defaultReasoningLevel" in output.models[1]!).toBe(false);
    expect("disabledReason" in output.models[1]!).toBe(false);
  });

  it("projects one line per model with its levels, the current marker and the disabled reason", async () => {
    const outcome = await run("list-models-projection", [
      entry("bigmodel", "glm-4.6", {
        providerLabel: "BigModel",
        reasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "high",
        current: true,
      }),
      entry("openai", "gpt-5", {
        providerLabel: "OpenAI",
        disabledReason: "no API key configured",
      }),
    ]);

    const modelContent = String(outcome.result.modelContent ?? "");
    expect(modelContent).toContain('<models count="2">');
    expect(modelContent).toContain(
      "bigmodel/glm-4.6 — BigModel; levels: low,medium,high (default high) [current]",
    );
    expect(modelContent).toContain("openai/gpt-5 — OpenAI [disabled: no API key configured]");
    // 只有一条能是当前项，禁用那条不该跟着被标上。
    expect(modelContent).not.toContain("openai/gpt-5 — OpenAI [current]");
  });

  it("omits `current` when nothing in the catalog is the session's model", async () => {
    const outcome = await run("list-models-no-current", [entry("openai", "gpt-5")]);
    const output = outcome.result.output as ListModelsOutput;
    expect("current" in output).toBe(false);
  });

  it("says so in a sentence when the host has no models configured", async () => {
    const outcome = await run("list-models-empty", []);
    expect((outcome.result.output as ListModelsOutput).models).toEqual([]);
    const modelContent = String(outcome.result.modelContent ?? "");
    expect(modelContent).toContain("No models are configured on this host.");
    expect(modelContent).toContain("subagent_model");
  });

  /**
   * 端口缺席绝不退化成空目录：那会让模型把「这个会话读不到目录」说成「你一个模型都没有」，
   * 而用户正在用一个（`workflow_introspection_unavailable` 同款理由）。
   */
  it("fails as a business error, not an empty list, when the host wired no catalog", async () => {
    const outcome = await run("list-models-unavailable", undefined);
    expect(outcome.result.success).toBe(false);

    // 判别键在 message 前缀（`workflow_introspection_unavailable` 同规），所以读 handler 的
    // 原始返回而不是 executor 投影后的错误对象。
    const failure = (await listModelsToolEntry.handler(
      {},
      { workingDirectory: "/workspace/never-read" } as unknown as ToolExecutionContext,
    )) as ToolHandlerFailure;
    expect(failure.result).toBe(false);
    expect(failure.message).toContain("model_catalog_unavailable");
    expect(failure.message).toContain("capability gap");
    expect(failure.message).toContain("subagent_model");
  });

  it("is read-only, needs no approval and is safe to run alongside other tools", () => {
    expect(listModelsToolEntry.metadata.readOnly).toBe(true);
    expect(listModelsToolEntry.metadata.needsApproval).toBe(false);
    expect(listModelsToolEntry.metadata.concurrentSafe).toBe(true);
    expect(listModelsToolEntry.metadata.sideEffectScope).toBe("none");
    expect(listModelsToolEntry.permission?.needsApproval).toBe(false);
    expect(listModelsToolEntry.resultBudget?.maxModelBytes).toBe(24_000);
  });

  /**
   * 描述是模型唯一的读者，而这个工具最容易被误读成「切换我自己的模型」的入口——那会换来一次
   * 向用户报告的、根本没发生过的模型切换。
   */
  it("tells the model the id pastes into subagent_model and that the session model does not move", () => {
    const description = listModelsToolEntry.metadata.description ?? "";
    expect(description).toContain("subagent_model");
    expect(description).toContain("does NOT change the model you are running on");
    expect(description).toContain("[current]");
    expect(description).toContain("$<level>");
  });

  it("rejects any input: the catalog is one table and has no knobs", async () => {
    const sessionId = createSessionId("list-models-strict");
    const turnId = createTurnId("list-models-strict");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    registry.register(listModelsToolEntry);
    const executor = createToolExecutor({
      emitEvent: async () => {},
      modelCatalogPort: { listModels: () => [] },
      mode: "build",
      permissionBroker: {
        async requestPermission() {
          return { decision: "allow" as const };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
      workingDirectory: "/workspace/never-read",
    });

    const result = await executor.execute(
      {
        id: createToolCallId("list-models-strict"),
        input: { providerId: "openai" },
        name: "ListModels",
      },
      { traceContext },
    );
    expect(result.success).toBe(false);
  });
});
