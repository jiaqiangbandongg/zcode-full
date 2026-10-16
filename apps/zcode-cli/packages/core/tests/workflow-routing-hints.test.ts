import { describe, expect, it } from "vitest";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import { FACADE_DTS } from "@zcode/dynamic-workflow";
import { AMEND_WORKFLOW_TOOL_DESCRIPTION } from "../src/tool/handlers/amend-workflow-description.js";
import { CREATE_WORKFLOW_TOOL_DESCRIPTION } from "../src/tool/handlers/create-workflow-description.js";
import { EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION } from "../src/tool/handlers/eval-workflow-snippet-description.js";
import { SAVE_WORKFLOW_TOOL_DESCRIPTION } from "../src/tool/handlers/save-workflow-description.js";
import { agentToolEntry } from "../src/tool/handlers/agent.js";
import { amendWorkflowToolEntry } from "../src/tool/handlers/amend-workflow.js";
import { createToolRegistry } from "../src/tool/registry.js";

// 2026-09-21（docs/dynamic-workflow/authoring.md「The authoring surface」）：四个创作工具的描述
// 收短到几百 token，facade 与写作规则搬进 dynamic-workflows 技能，由 resolveInput 上的技能门
// 保证读过。描述只剩三件常驻的事——它是什么、何时（不）用、先读技能。这里的断言按关键词
// 而非逐字：文案可以润色，路由信号不能丢，体量不能长回去。
const DESCRIPTIONS = {
  AmendWorkflow: AMEND_WORKFLOW_TOOL_DESCRIPTION,
  CreateWorkflow: CREATE_WORKFLOW_TOOL_DESCRIPTION,
  EvalWorkflowSnippet: EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION,
  SaveWorkflow: SAVE_WORKFLOW_TOOL_DESCRIPTION,
} as const;

/** 常驻描述的体量上限（字符）。此前 CreateWorkflow 一家就是 3.4 万字符；现在四家合计要在这之内。 */
const MAX_DESCRIPTION_CHARS = 2_200;

describe("authoring tool descriptions stay short and point at the skill", () => {
  for (const [name, description] of Object.entries(DESCRIPTIONS)) {
    it(`${name}: no facade, no rule book, a skill pointer, under budget`, () => {
      expect(description.length).toBeLessThan(MAX_DESCRIPTION_CHARS);
      // facade 的 ambient 声明与写作规则清单都不再随每次请求重发。
      expect(description).not.toContain("declare ");
      expect(description).not.toContain("Authoring rules");
      expect(description).not.toContain("noUncheckedIndexedAccess");
      // 每一家都点名技能与 Skill 工具，并说明门会拒绝。
      expect(description).toContain(`\`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill`);
      expect(description).toContain("Skill tool");
      expect(description).toContain("refused until");
    });
  }
});

// 桌面实测：用户明说「工作流」，模型仍然去调 Agent。根因是描述性谎言的组合——
// CreateWorkflow 自述「placeholder / does NOT run anything」（引擎接线后从未更新），
// 而 Agent 自荐「complex, multi-step tasks」，模型的理性选择就是 Agent。
describe("CreateWorkflow tool description", () => {
  it("不再自称 placeholder / 不执行", () => {
    const lowered = CREATE_WORKFLOW_TOOL_DESCRIPTION.toLowerCase();
    expect(lowered).not.toContain("placeholder");
    expect(lowered).not.toContain("does not run");
    expect(lowered).not.toContain("not executed");
  });

  it("描述真实执行路径：typecheck → 确认 → 后台 run → 通知", () => {
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("typechecked");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("confirm");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("background");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("notified");
  });

  it("给出 when-to-use，并把「点名即绑定」写进去", () => {
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("When to use");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("工作流");
    // 简单委派仍归 Agent——形状助推的另一半，防止过度触发。
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("Agent");
  });

  it("点名即绑定是强制的：列出「use a workflow / 使用 workflow」这类措辞，并禁止以「太小」为由改道", () => {
    // docs/dynamic-workflow/launch.md「Run introspection tools」的追记（2026-09-07）：原句只说
    // 「use this tool」，模型仍会把小任务判成不值得开工作流而改走 Agent 或直接做。这里钉三个
    // 信号：强制语气、用户会真正说出口的措辞、以及「大小只决定规模不决定是否」。
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("mandatory");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("use a workflow");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("使用 workflow");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("too small");
  });

  // 用户裁决 2026-09-16：工作流只能由 `/workflow` 或明确请求发起，模型不得自行决定开一条。
  it("只按点名路由：没有编排场景那一条，有明确的否定规则和替代动作", () => {
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).not.toContain("Multi-subagent orchestration");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).not.toContain("deterministic control flow");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain(
      "Without such an explicit request, do not start a workflow",
    );
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain(
      "delegate with the Agent tool or do the work yourself",
    );
  });

  // 路由规则留在描述里、不进技能：它决定的是「要不要调这个工具」，在技能加载之前就得被读到。
  // 三条来源与「改文件再 path 回传」的回路也留一句——那是这个特性要消灭的重贴脚本代价
  // （docs/dynamic-workflow/launch.md「Script files」），不能等到技能加载之后才知道。
  it("留下三条来源、path 回路与 AmendWorkflow 的指路，说明 saved 免技能", () => {
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("exactly one source");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("`saved`");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("resubmit with `path`");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("never paste the script again");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain("call AmendWorkflow instead");
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).toContain(
      "running a saved workflow by name is exempt",
    );
    expect(CREATE_WORKFLOW_TOOL_DESCRIPTION).not.toContain("resume_from");
  });
});

// docs/dynamic-workflow/launch.md「What the model is told」：修订的路由（修、扩、跑到一半就改、只改
// 设定、恢复归 Resume）留在描述里；缓存、三态字段、script_unchanged 与确认规则在技能里。
describe("AmendWorkflow tool description", () => {
  it("说清何时修订而不是重建、不要先停不要等、只改设定不带脚本、恢复归 ResumeWorkflowRun", () => {
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain("supersedes the old one");
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain(
      "Never rewrite the workflow from scratch with CreateWorkflow",
    );
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain("Do not TaskStop it first");
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain("neither `path` nor `script`");
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain("ResumeWorkflowRun");
    // 门的边界写在描述里：只有带脚本的修订才需要技能。
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).toContain("a settings-only call is not");
    expect(AMEND_WORKFLOW_TOOL_DESCRIPTION).not.toContain("in flight starts again");
  });

  // 第 4 环（docs/design/v2/tool/00-tool-change-chain.md）：provider-visible 的那一份必须真的
  // 经 ToolRegistry.toContracts() 投影出去，否则改了描述模型也看不见。
  it("经 ToolRegistry.toContracts() 投影给模型", () => {
    const registry = createToolRegistry();
    registry.register(amendWorkflowToolEntry);
    const contract = registry.toContracts().find((entry) => entry.name === "AmendWorkflow");
    expect(contract?.description).toContain("Do not TaskStop it first");
    expect(contract?.description).toContain(`\`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill`);
  });
});

// docs/dynamic-workflow/launch.md「`SaveWorkflow`」：唯一一条必须在决定调不调之前就看见的规则——
// 绝不主动保存——留在描述里。
describe("SaveWorkflow tool description", () => {
  it("常驻「绝不主动保存」，并点名 script_path 是不重吐脚本的那条路", () => {
    expect(SAVE_WORKFLOW_TOOL_DESCRIPTION).toContain("NEVER call this tool unsolicited");
    expect(SAVE_WORKFLOW_TOOL_DESCRIPTION).toContain("suggest saving it in one sentence and wait");
    expect(SAVE_WORKFLOW_TOOL_DESCRIPTION).toContain("`script_path`");
  });
});

describe("facade prose", () => {
  it("不再把 declare 措辞写成作者指引", () => {
    // facade 散文曾写「an interface declared in this script」，和上方那些 ambient
    // `declare` 一起构成比旧 RULES 措辞更强的诱导。散文可改，关键字不可改。
    expect(FACADE_DTS).not.toContain("declared in");
    expect(FACADE_DTS).toContain("an interface you define in");
    expect(FACADE_DTS).toContain('no "declare" modifier');
  });

  it("ambient declare 关键字仍然完整（编译器要的真 d.ts）", () => {
    // 散文改写不得动关键字：这些是 facade 作为 .d.ts 被 createWorkflowProgram
    // 喂进虚拟 host 的前提，少一个就是编译期 API 缺失。
    //
    // 期望数量由下面这份清单**推导**，不是一个魔法数字。原先写死的 8 会在每次新增原语时
    // 变成一处必须同步的编辑，而它要防的其实是「散文改写把某个 declare 弄丢了」——
    // 推导出来的数量照样防得住，还多防一条：清单里漏登记一个新声明也会被抓到。
    const declarations = [
      "declare interface Node<T>",
      "declare interface AgentPersona",
      "declare interface Agent",
      "declare function agent(",
      "declare const args",
      "declare function log(",
      "declare function report(",
      // docs/dynamic-workflow/authoring.md「Declaring a dashboard」：内容成员 + 四种预置看板的 spec。
      "declare interface ArtifactRef",
      "declare interface ArtifactOptions",
      "declare interface ArtifactFileOptions",
      "declare interface ArtifactField",
      "declare interface ChartSpec",
      "declare interface TableSpec",
      "declare interface MetricsSpec",
      "declare interface BoardSpec",
      "declare const artifact",
      "declare function phase(",
      "declare interface GrepMatch",
      "declare const files",
      "declare interface GitStatus",
      "declare interface GitCommit",
      "declare const git",
      "declare interface WorldRunResult",
      "declare const world",
      // docs/dynamic-workflow/authoring.md「Streams: `channel` and `future`」：facade/dts-stream.ts 段。
      "declare interface Channel<T>",
      "declare function channel<T>(",
      "declare function future<T>(",
      // docs/dynamic-workflow/authoring.md「Choosing a model per subagent」：facade/dts-model.ts 段。
      "declare class ModelRef",
      "declare function model(",
      // docs/dynamic-workflow/authoring.md「Holes: `hole<T>()`」：三个重载（提示 / 函数体 / 两者）。
      "declare function hole<T>(name: string, prompt?: string): Promise<T>;",
      "declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;",
      "declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;",
    ];
    const keywords = FACADE_DTS.match(/^declare /gm) ?? [];
    expect(keywords).toHaveLength(declarations.length);
    for (const decl of declarations) {
      expect(FACADE_DTS).toContain(decl);
    }
  });
});

describe("Agent tool description", () => {
  it("在 When to use 里交叉指向 CreateWorkflow", () => {
    const description = agentToolEntry.metadata.description ?? "";
    expect(description).toContain("When to use");
    expect(description).toContain("工作流");
    expect(description).toContain("CreateWorkflow");
    // 反向指路同样是强制语气：Agent 不能以任务小为由接下点名工作流的请求。
    expect(description).toContain("mandatory");
    expect(description).toContain("use a workflow");
  });
});

// 原先这里还断言 task-behavior 系统提示段里同样带路由规则。上游 4eea9c1d00
// （align provider-visible prompt content）整段删掉了本地自撰的 task-behavior /
// communication-style / risk-actions 等 section，并在 context-builder.test.ts 里反向断言
// `not.toContain("# Task Behavior")`——那个落点已经不存在，也不允许重建。路由信号现在只
// 由上面两个工具描述承载（CreateWorkflow 自述 + Agent 的反向指路），两处都在本文件里断言。
