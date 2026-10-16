// FillWorkflowHole 的常驻描述（docs/dynamic-workflow/launch.md「What the model is told」）。
//
// 与 AmendWorkflow 同一条收短原则：facade、留白的三种写法与写作规则都在 `dynamic-workflows` 技能里，
// 由技能门保证读过。这里只留决定「要不要调这个工具、怎么写函数体」的那几句：函数体只写语句、在
// 留白处编译、看得见它之前的绑定、要返回留白的类型、先在 EvalWorkflowSnippet 里排练固定逻辑、
// 一处留白只补一次（循环里的函数体每轮都跑）。

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

export const FILL_WORKFLOW_HOLE_TOOL_DESCRIPTION = [
  "Supplies the body of a hole that a RUNNING dynamic-workflow run has reached and is waiting at. Starts nothing: the run keeps its id, journal and subagents, and grows by the statements you write.",
  "",
  "- Takes run_id and hole_id — both from the hole notification (or from GetWorkflowRun's holes if that notification was lost). Only the branch parked at the hole waits; the rest of the run keeps going, and nothing times out.",
  "- Read the run's draft at the path the notification names for context: the body is compiled WHERE THE HOLE STANDS and sees every binding declared before it. Write only the statements of the hole's function — not the `hole(...)` call, not an arrow, not the script around it — and return a value of the hole's type, or end with a new tail hole named for the next step when the workflow's shape is not known yet (the skill's §15).",
  "- Rehearse fixed logic in EvalWorkflowSnippet first. A hole is filled once: a body under a loop runs on every iteration with that iteration's bindings.",
  "- On diagnostics the fill is saved to a fill file; edit that file in place and resubmit with `path` instead of pasting the body again. To change anything OUTSIDE the hole, use AmendWorkflow.",
  "",
  `Load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool before writing a body: it carries the facade the body is checked against and the hole rules. A call is refused until that skill has been loaded in this session. Pass \`script\` (the statements inline) or \`path\` (a file holding them), never both.`,
].join("\n");
