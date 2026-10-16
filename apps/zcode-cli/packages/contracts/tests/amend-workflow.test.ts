import { describe, expect, it } from "vitest";
import {
  AMEND_WORKFLOW_TOOL_NAME,
  AmendWorkflowInputJsonSchema,
  AmendWorkflowInputSchema,
} from "../src/tools/amend-workflow.js";

// docs/dynamic-workflow/launch.md「The `AmendWorkflow` tool」：模型面只有 run_id 必填，其余字段省略
// 即沿用前驱（script 也不例外，见「Keeping the predecessor's script」）；`predecessor` 是 resolveInput
// 回填的事实块——运行时 schema 认它、模型面 JSON schema 不列它。
describe("AmendWorkflowInputSchema", () => {
  const SCRIPT = 'return await agent("a").ask<string>("go");';

  it("names the tool and accepts the model-facing shape", () => {
    expect(AMEND_WORKFLOW_TOOL_NAME).toBe("AmendWorkflow");
    const input = { run_id: "dwfrun-prev", script: SCRIPT };
    expect(AmendWorkflowInputSchema.parse(input)).toEqual(input);
    expect(AmendWorkflowInputSchema.parse({ ...input, name: "second pass" })).toEqual({
      ...input,
      name: "second pass",
    });
  });

  it("accepts the resolved predecessor block and rejects a malformed one", () => {
    const resolved = {
      run_id: "dwfrun-prev",
      script: SCRIPT,
      predecessor: { name: "triage", status: "running", owned_by_this_session: true },
    };
    expect(AmendWorkflowInputSchema.parse(resolved)).toEqual(resolved);
    expect(
      AmendWorkflowInputSchema.safeParse({
        ...resolved,
        predecessor: { status: "stopped", stop_reason: "superseded", owned_by_this_session: false },
      }).success,
    ).toBe(true);
    expect(
      AmendWorkflowInputSchema.safeParse({ ...resolved, predecessor: { status: "flying" } })
        .success,
    ).toBe(false);
  });

  // 省略 script 的调用经 resolveInput 回填后带着前驱的脚本与这枚 flag；flag 只有「在场即真」一种值。
  it("accepts script_inherited on the resolved predecessor, only as true", () => {
    const resolved = {
      run_id: "dwfrun-prev",
      script: SCRIPT,
      predecessor: { status: "completed", owned_by_this_session: true, script_inherited: true },
    };
    expect(AmendWorkflowInputSchema.parse(resolved)).toEqual(resolved);
    expect(
      AmendWorkflowInputSchema.safeParse({
        ...resolved,
        predecessor: { ...resolved.predecessor, script_inherited: false },
      }).success,
    ).toBe(false);
  });

  // 子代理选型的三态（docs/dynamic-workflow/launch.md）：省略 = 沿用前驱、null = 回到会话模型、
  // 字符串 = 设定。运行时 schema 三种都认——归一成一个规范形字符串是 resolveInput 的事。
  it("accepts the three states of subagent_model and rejects a blank string", () => {
    const input = { run_id: "dwfrun-prev", script: SCRIPT };
    expect(AmendWorkflowInputSchema.parse(input)).toEqual(input);
    expect(AmendWorkflowInputSchema.parse({ ...input, subagent_model: null })).toEqual({
      ...input,
      subagent_model: null,
    });
    expect(AmendWorkflowInputSchema.parse({ ...input, subagent_model: "  zhipu/glm-5.3  " })).toEqual(
      { ...input, subagent_model: "zhipu/glm-5.3" },
    );
    expect(AmendWorkflowInputSchema.safeParse({ ...input, subagent_model: "   " }).success).toBe(
      false,
    );
  });

  it("requires run_id, leaves script optional, and rejects the legacy resume_from spelling", () => {
    expect(AmendWorkflowInputSchema.safeParse({ script: SCRIPT }).success).toBe(false);
    // 省略 script = 沿用前驱的脚本：只改设定的修订不必把整份脚本再抄一遍。
    expect(AmendWorkflowInputSchema.parse({ run_id: "dwfrun-prev" })).toEqual({
      run_id: "dwfrun-prev",
    });
    expect(AmendWorkflowInputSchema.parse({ run_id: "dwfrun-prev", max_concurrency: 2 })).toEqual({
      run_id: "dwfrun-prev",
      max_concurrency: 2,
    });
    // 给了就必须是一份脚本：空串不是「省略」。
    expect(AmendWorkflowInputSchema.safeParse({ run_id: "dwfrun-prev", script: "" }).success).toBe(
      false,
    );
    expect(AmendWorkflowInputSchema.safeParse({ run_id: "", script: SCRIPT }).success).toBe(false);
    expect(
      AmendWorkflowInputSchema.safeParse({
        run_id: "dwfrun-prev",
        script: SCRIPT,
        resume_from: "x",
      }).success,
    ).toBe(false);
  });

  // docs/dynamic-workflow/launch.md「Script files」：修订脚本至多给一个（`path` 是常态，两个都
  // 不给 = 沿用前驱的脚本）。「不能两个都给」住在 `validateInput` 而不是 schema——归一化之后
  // `script` 与 `path` 同时在场是合法执行态，所以运行时 schema 必须两者皆可缺、也可同在。
  it("takes the revision either inline or as a file, and carries the resolved line offset", () => {
    const byPath = { run_id: "dwfrun-prev", path: ".zcode/workflow-drafts/x.dwf.ts" };
    expect(AmendWorkflowInputSchema.parse(byPath)).toEqual(byPath);
    // 「两个都不给」是合法的：沿用前驱的脚本（Keeping the predecessor's script）。
    expect(AmendWorkflowInputSchema.safeParse({ run_id: "dwfrun-prev" }).success).toBe(true);
    const resolved = { ...byPath, script: SCRIPT, script_line_offset: 4 };
    expect(AmendWorkflowInputSchema.parse(resolved)).toEqual(resolved);
    expect(
      AmendWorkflowInputSchema.safeParse({ ...byPath, script_line_offset: -1 }).success,
    ).toBe(false);
  });

  it("keeps predecessor out of the model-facing JSON schema", () => {
    const schema = AmendWorkflowInputJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    // `max_concurrency` 与 `subagent_model` 是模型可见的第四、第五个字段
    // （docs/dynamic-workflow/concurrency.md「Two bounds on a run」、docs/dynamic-workflow/launch.md）；
    // `predecessor` 仍由 resolveInput 覆写，不进 schema。
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "max_concurrency",
      "name",
      "path",
      "run_id",
      "script",
      "subagent_model",
    ]);
    // `run_id` 是唯一必填：来源至多一个由 validateInput 强制，schema 表达不了 refinement。
    expect(schema.required).toEqual(["run_id"]);
    expect(schema.required).not.toContain("name");
    // 回填的行偏移与 `predecessor` 同一姿态：运行时认它，模型面不列它。
    expect(Object.keys(schema.properties ?? {})).not.toContain("script_line_offset");
    expect(schema.additionalProperties).toBe(false);
  });
});
