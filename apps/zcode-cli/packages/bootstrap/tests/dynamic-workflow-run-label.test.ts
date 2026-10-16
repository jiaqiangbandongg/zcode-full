/**
 * run 展示标签的兜底链（docs/dynamic-workflow/launch.md「`ListWorkflowRuns`」）。
 *
 * 被测对象是一个纯函数，且它**刻意住在自己的模块里**：列表面与详情面必须用同一条链
 * （同一个 run 在两处显示不同名字是最难被抓住、最直接损害信任的那类不一致），而纯函数
 * 单独成模块才能被这条测试直接 import——run service 本身拖着一整条 AgentRuntime 依赖链。
 */

import { describe, expect, it } from "vitest";
import {
  DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS,
  resolveDynamicWorkflowRunLabel,
} from "../src/app/dynamic-workflow-run-label.js";

const RUN_ID = "dwfrun-0f2a";

describe("resolveDynamicWorkflowRunLabel", () => {
  it("name 命中即用它，labelSource 为 name", () => {
    expect(
      resolveDynamicWorkflowRunLabel({ runId: RUN_ID, name: "nightly triage", scriptText: "return 1;" }),
    ).toEqual({ label: "nightly triage", labelSource: "name" });
  });

  it("name 缺席时取脚本的首个非空行，labelSource 为 script", () => {
    expect(
      resolveDynamicWorkflowRunLabel({
        runId: RUN_ID,
        scriptText: "\n\n   // triage the failing tests   \nconst a = agent(\"worker\");",
      }),
    ).toEqual({ label: '// triage the failing tests', labelSource: "script" });
  });

  it("首行按 80 字符截断", () => {
    const line = "x".repeat(200);
    const { label } = resolveDynamicWorkflowRunLabel({ runId: RUN_ID, scriptText: line });
    expect(label).toHaveLength(DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS);
    expect(label).toBe("x".repeat(DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS));
  });

  // 脚本文本是模型写的外部输入，字符串字面量里可以有 emoji。截断落在代理对中间时宁可少一个
  // 码元——孤立代理项既不是合法文本，也会让下游 JSON 编解码在某些运行时上报错
  // （与 create-workflow 的 boundGraphText、端口载荷有界化同一处理）。
  it("截断不留下孤立代理项", () => {
    const line = `${"a".repeat(DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS - 1)}😀tail`;
    const { label } = resolveDynamicWorkflowRunLabel({ runId: RUN_ID, scriptText: line });
    expect(label).toBe("a".repeat(DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS - 1));
    expect(JSON.parse(JSON.stringify(label))).toBe(label);
  });

  it("空白 name 视为没起名，退回脚本首行", () => {
    expect(
      resolveDynamicWorkflowRunLabel({ runId: RUN_ID, name: "   ", scriptText: "return 7;" }),
    ).toEqual({ label: "return 7;", labelSource: "script" });
  });

  // 理论上不发生（submit 必带 scriptText），但读面绝不能因此给出空标签：裸 runId 至少是
  // 可定位的，而空字符串在列表里就是一行不可点的空白。
  it("name 与脚本都缺席时退回 runId，labelSource 仍是 script", () => {
    expect(resolveDynamicWorkflowRunLabel({ runId: RUN_ID })).toEqual({
      label: RUN_ID,
      labelSource: "script",
    });
    expect(
      resolveDynamicWorkflowRunLabel({ runId: RUN_ID, scriptText: "  \n\t\n " }),
    ).toEqual({ label: RUN_ID, labelSource: "script" });
  });
});
