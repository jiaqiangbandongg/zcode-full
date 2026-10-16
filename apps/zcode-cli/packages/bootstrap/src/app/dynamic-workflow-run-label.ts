// ============================================================
// workflow run 的展示标签（读时派生，绝不回写 dwf_run.name）
// ============================================================
//
// 独立模块的两个理由：
//   1. **两条读面共用同一条链**。列表（ListWorkflowRuns）与详情（GetWorkflowRun）各拼一次
//      兜底，就会在某个分支上漂移，而症状是同一个 run 在两处显示不同的名字。
//   2. **可被直接单测**。run service 拖着 AgentRuntime / 引擎 / journal 一整条依赖链；
//      一个纯函数不该为了被断言而付那份代价。

import type { DynamicWorkflowRunSummary } from "@zcode/contracts";

/**
 * 脚本派生标签的字符上限。80 是一行列表能读完的长度；派生值是启发式，越长越不像标签。
 */
export const DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS = 80;

/**
 * 派生 run 的展示标签：`name` → 脚本首个非空行（trim 后截 80）→ runId。
 *
 * 刻意不做「更聪明」的提取（首个注释、正则找标题、抽 agent 名）：首行是**诚实的**
 * （「脚本以此开头」），而启发式每多一条就多一种在别人的脚本上给出误导标签的方式。
 *
 * 派生结果**绝不回写** `dwf_run.name`：落库等于把一个展示启发式固化成数据，此后连
 * 「这个 run 到底有没有名字」都答不上来。
 */
export function resolveDynamicWorkflowRunLabel(input: {
  runId: string;
  name?: string;
  scriptText?: string;
}): Pick<DynamicWorkflowRunSummary, "label" | "labelSource"> {
  // 全空白的 name 与没起名等价：它在列表里就是一行不可点的空白，而不是一个标签。
  const name = input.name?.trim();
  if (name !== undefined && name.length > 0) return { label: name, labelSource: "name" };

  const firstLine = firstNonEmptyLine(input.scriptText);
  if (firstLine !== undefined) {
    return { label: boundLabel(firstLine), labelSource: "script" };
  }

  // 理论上不发生（submit 必带 scriptText）。labelSource 仍报 "script"——工具面要区分的只有
  // 「用户起的名字」与「我们派生的」两种，为一个不该发生的分支再加一个来源值只会让消费方
  // 多写一个永不命中的判断。
  return { label: input.runId, labelSource: "script" };
}

/** 首个非空行（已 trim）。整段皆空白时返回 undefined。 */
function firstNonEmptyLine(scriptText: string | undefined): string | undefined {
  if (scriptText === undefined) return undefined;
  for (const line of scriptText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * 截到上限，且绝不留下孤立代理项（lone surrogate）。脚本是模型写的外部输入，字符串字面量
 * 里可以有 emoji；半个代理对既不是合法文本，也会让下游 JSON 编解码在某些运行时上报错
 * （与 create-workflow 的 boundGraphText、端口载荷有界化同一处理）。
 */
function boundLabel(value: string): string {
  if (value.length <= DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS) return value;
  const cut = value.slice(0, DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}
