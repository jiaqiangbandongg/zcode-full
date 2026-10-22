import { describe, expect, it } from "vitest";
import { amendWorkflowToolEntry } from "../../src/tool/handlers/amend-workflow.js";
import { listModelsToolEntry } from "../../src/tool/handlers/list-models.js";
import { fillWorkflowHoleToolEntry } from "../../src/tool/handlers/fill-workflow-hole.js";
import { createToolRegistry } from "../../src/tool/registry.js";
import {
  AmendWorkflowInputSchema,
  ListModelsInputSchema,
  FillWorkflowHoleInputSchema,
  type WorkflowToolEntrypoints,
} from "../../src/tool/workflow-entrypoints/contract.js";

const entries: WorkflowToolEntrypoints = {
  amendWorkflow: amendWorkflowToolEntry,
  listModels: listModelsToolEntry,
  fillWorkflowHole: fillWorkflowHoleToolEntry,
};

describe("Workflow 工具入口契约", () => {
  it("向同一目录注册原工具入口，不改变 deferred 分类和审批要求", () => {
    const registry = createToolRegistry();
    registry.register(entries.amendWorkflow);
    registry.register(entries.listModels);
    registry.register(entries.fillWorkflowHole);
    expect(registry.get("AmendWorkflow")).toBe(entries.amendWorkflow);
    expect(registry.get("ListModels")).toBe(entries.listModels);
    expect(registry.get("FillWorkflowHole")).toBe(entries.fillWorkflowHole);
    expect(entries.amendWorkflow.metadata.shouldDefer).toBe(true);
    expect(entries.listModels.metadata.shouldDefer).toBe(true);
    expect(entries.fillWorkflowHole.metadata.shouldDefer).toBe(true);
    expect(entries.amendWorkflow.permission?.alwaysAsk).toBe(true);
    expect(entries.listModels.permission?.needsApproval).toBe(false);
  });

  it("留白填充保留同一参数契约与审批边界", () => {
    expect(entries.fillWorkflowHole.runtimeInputSchema).toBe(FillWorkflowHoleInputSchema);
    expect(FillWorkflowHoleInputSchema.safeParse({}).success).toBe(false);
    expect(entries.fillWorkflowHole.metadata.readOnly).toBe(false);
    expect(entries.fillWorkflowHole.metadata.concurrentSafe).toBe(true);
    expect(entries.fillWorkflowHole.permission?.alwaysAsk).toBe(true);
  });

  it("模型目录查询仍只接受空参数", () => {
    expect(entries.listModels.runtimeInputSchema).toBe(ListModelsInputSchema);
    expect(ListModelsInputSchema.safeParse({}).success).toBe(true);
    expect(ListModelsInputSchema.safeParse({ model: "example/model" }).success).toBe(false);
  });

  it("修订必须指定前驱，省略脚本保留继承语义", () => {
    expect(entries.amendWorkflow.runtimeInputSchema).toBe(AmendWorkflowInputSchema);
    expect(AmendWorkflowInputSchema.safeParse({}).success).toBe(false);
    expect(
      AmendWorkflowInputSchema.parse({ run_id: "run-example", max_concurrency: null }),
    ).toEqual({
      run_id: "run-example",
      max_concurrency: null,
    });
  });
});
