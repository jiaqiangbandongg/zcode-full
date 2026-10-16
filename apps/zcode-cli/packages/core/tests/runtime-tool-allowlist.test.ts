import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  ESCALATE_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
} from "@zcode/contracts";
import { createSessionId } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "../src/subagent/explore-tools.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDisallowedTools,
} from "../src/runtime/helpers/tool-allowlist.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";

function config(patch: Partial<AgentRuntimeConfig>): AgentRuntimeConfig {
  return patch as AgentRuntimeConfig;
}

describe("resolveBuiltInToolAllowlist", () => {
  it("keeps RespondToCoordinator after the Explore child intersection", () => {
    expect(
      resolveBuiltInToolAllowlist(
        config({
          taskType: "subagent_child",
          toolset: "explore",
          toolAllowlist: [...EXPLORE_AGENT_ALLOWED_TOOLS, RESPOND_TO_COORDINATOR_TOOL_NAME],
        }),
      ),
    ).toContain(RESPOND_TO_COORDINATOR_TOOL_NAME);
  });

  it("does not add RespondToCoordinator to a main Explore runtime", () => {
    expect(
      resolveBuiltInToolAllowlist(
        config({
          toolset: "explore",
          toolAllowlist: [...EXPLORE_AGENT_ALLOWED_TOOLS, RESPOND_TO_COORDINATOR_TOOL_NAME],
        }),
      ),
    ).not.toContain(RESPOND_TO_COORDINATOR_TOOL_NAME);
  });

  it("adds RespondToCoordinator to a custom child allowlist", () => {
    expect(
      resolveBuiltInToolAllowlist(
        config({
          taskType: "subagent_child",
          toolset: "main",
          toolAllowlist: ["Read"],
        }),
      ),
    ).toEqual(["Read", RESPOND_TO_COORDINATOR_TOOL_NAME]);
  });

  it("keeps an unrestricted general child allowlist unrestricted", () => {
    expect(
      resolveBuiltInToolAllowlist(config({ taskType: "subagent_child", toolset: "main" })),
    ).toBeUndefined();
  });

  it("keeps an unrestricted workflow child allowlist unrestricted", () => {
    expect(
      resolveBuiltInToolAllowlist(config({ taskType: "workflow_child", toolset: "main" })),
    ).toBeUndefined();
  });

  it("does not add submit_result or escalate outside workflow children", () => {
    expect(
      resolveBuiltInToolAllowlist(config({ toolset: "main", toolAllowlist: ["Read"] })),
    ).toEqual(["Read"]);
    const subagentChild = resolveBuiltInToolAllowlist(
      config({ taskType: "subagent_child", toolset: "main", toolAllowlist: ["Read"] }),
    );
    expect(subagentChild).not.toContain(SUBMIT_RESULT_TOOL_NAME);
    expect(subagentChild).not.toContain(ESCALATE_TOOL_NAME);
  });
});

// workflow_child 强制 yolo 且交互事件不镜像到父会话，CreateWorkflow 的 alwaysAsk 会在
// child 里发出无人可见的确认请求（见 docs/dynamic-workflow/launch.md「Recorded exceptions」）。
// SaveWorkflow 因同一个根因入列：它也声明了 alwaysAsk。ResumeWorkflowRun 同根因入列
//（2026-08-29）：恢复一个 run 等于重新执行整块脚本，它的 alwaysAsk 在 child 里同样无窗可弹。
// ResolveWorkflowQuestion 是第四条，守的是另一条不变式（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：
// 升级问答里作答权只属于创建工作流的那一方，child 不得替它拍板。
describe("resolveRuntimeDisallowedTools", () => {
  it("excludes the always-ask workflow tools from workflow-child runtimes", () => {
    const disallowed = resolveRuntimeDisallowedTools(config({ taskType: "workflow_child" }));
    expect(disallowed).toEqual([
      CREATE_WORKFLOW_TOOL_NAME,
      AMEND_WORKFLOW_TOOL_NAME,
      SAVE_WORKFLOW_TOOL_NAME,
      RESUME_WORKFLOW_RUN_TOOL_NAME,
      RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
      FILL_WORKFLOW_HOLE_TOOL_NAME,
    ]);
    // 反向断言：只读 run 内省工具不在列——那条禁令的理由是无窗可弹，只读查询不适用。
    expect(disallowed).not.toContain(LIST_WORKFLOW_RUNS_TOOL_NAME);
    expect(disallowed).not.toContain(GET_WORKFLOW_RUN_TOOL_NAME);
  });

  it("merges with an existing turn disallowlist instead of replacing it", () => {
    expect(
      resolveRuntimeDisallowedTools(
        config({ taskType: "workflow_child", toolDisallowlist: ["CronCreate"] }),
      ),
    ).toEqual([
      "CronCreate",
      CREATE_WORKFLOW_TOOL_NAME,
      AMEND_WORKFLOW_TOOL_NAME,
      SAVE_WORKFLOW_TOOL_NAME,
      RESUME_WORKFLOW_RUN_TOOL_NAME,
      RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
      FILL_WORKFLOW_HOLE_TOOL_NAME,
    ]);
  });

  it("does not duplicate an already disallowed CreateWorkflow", () => {
    expect(
      resolveRuntimeDisallowedTools(
        config({ taskType: "workflow_child", toolDisallowlist: [CREATE_WORKFLOW_TOOL_NAME] }),
      ),
    ).toEqual([
      CREATE_WORKFLOW_TOOL_NAME,
      AMEND_WORKFLOW_TOOL_NAME,
      SAVE_WORKFLOW_TOOL_NAME,
      RESUME_WORKFLOW_RUN_TOOL_NAME,
      RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
      FILL_WORKFLOW_HOLE_TOOL_NAME,
    ]);
  });

  it("leaves other task types on their configured disallowlist", () => {
    expect(resolveRuntimeDisallowedTools(config({ taskType: "subagent_child" }))).toBeUndefined();
    expect(resolveRuntimeDisallowedTools(config({ toolDisallowlist: ["CronCreate"] }))).toEqual([
      "CronCreate",
    ]);
  });

  // 结构性那一半：禁令按 **taskType** 生效，因此不依赖 persona 档位是否恰好收窄掉它。
  // bootstrap 的 DEFAULT_DISALLOWED_TOOLS 是刻意重复的第二道（照 CreateWorkflow 的双列先例），
  // 只覆盖 "default" 档位；这一道覆盖全部 workflow child，将来新增 persona 档位也不会开门。
  it("keeps ResolveWorkflowQuestion out of every workflow child, whatever the persona profile", () => {
    // 无 turn 级名单（相当于收窄档位下 persona 什么都没减）时，结构性禁令仍然生效。
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      disallowedTools: resolveRuntimeDisallowedTools(config({ taskType: "workflow_child" })),
    });
    expect(registry.has(RESOLVE_WORKFLOW_QUESTION_TOOL_NAME)).toBe(false);
    // 反向断言：actor 的**提问**通道绝不能被这条禁令误伤。
    expect(resolveRuntimeDisallowedTools(config({ taskType: "workflow_child" }))).not.toContain(
      ESCALATE_TOOL_NAME,
    );
  });

  // 应答工具的身份边界（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：主会话有，actor 会话没有——
  // 升级的整个意义是把判断权交给创建工作流的那一方，让另一个 actor 顺手作答等于把它悄悄
  // 退化成 actor 之间的互相说服。actor 会话的禁令由 bootstrap 的 workflowActorToolPolicy
  // 下发（DEFAULT_DISALLOWED_TOOLS），这里断的是它落到注册表上的效果。
  it("registers ResolveWorkflowQuestion in a main runtime but not in an actor session", () => {
    const mainRegistry = createToolRegistry();
    registerBuiltInTools(mainRegistry, {
      disallowedTools: resolveRuntimeDisallowedTools(config({})),
    });
    expect(mainRegistry.has(RESOLVE_WORKFLOW_QUESTION_TOOL_NAME)).toBe(true);

    // actor 会话：persona 的 "default" 档位把它减掉（名单来自 bootstrap，这里以同一个名字模拟）。
    const actorRegistry = createToolRegistry();
    registerBuiltInTools(actorRegistry, {
      disallowedTools: resolveRuntimeDisallowedTools(
        config({
          taskType: "workflow_child",
          toolDisallowlist: [RESOLVE_WORKFLOW_QUESTION_TOOL_NAME],
        }),
      ),
    });
    expect(actorRegistry.has(RESOLVE_WORKFLOW_QUESTION_TOOL_NAME)).toBe(false);
  });

  it("keeps the tool out of the registry for a workflow child but not for a main runtime", () => {
    const childRegistry = createToolRegistry();
    registerBuiltInTools(childRegistry, {
      disallowedTools: resolveRuntimeDisallowedTools(config({ taskType: "workflow_child" })),
    });
    expect(childRegistry.has(CREATE_WORKFLOW_TOOL_NAME)).toBe(false);
    expect(childRegistry.has(RESUME_WORKFLOW_RUN_TOOL_NAME)).toBe(false);

    const mainRegistry = createToolRegistry();
    registerBuiltInTools(mainRegistry, {
      disallowedTools: resolveRuntimeDisallowedTools(config({})),
    });
    expect(mainRegistry.has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);
    expect(mainRegistry.has(RESUME_WORKFLOW_RUN_TOOL_NAME)).toBe(true);
  });
});

// docs/dynamic-workflow/launch.md「Gray release」DWG-03 / DWG-04。
const GATED_DYNAMIC_WORKFLOW_TOOL_NAMES = [
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  // 留白补全随灰度门同进同退：关闭态下没有 run 会到达留白，留着它只会指向不存在的工具。
  FILL_WORKFLOW_HOLE_TOOL_NAME,
];

describe("registerBuiltInTools：动态工作流灰度门", () => {
  const GATED_TOOL_NAMES = GATED_DYNAMIC_WORKFLOW_TOOL_NAMES;

  it("includeDynamicWorkflow:false 时十个工具一个都不注册", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeDynamicWorkflow: false });
    for (const name of GATED_TOOL_NAMES) {
      expect({ name, registered: registry.has(name) }).toEqual({ name, registered: false });
    }
  });

  // 灰度关闭只针对动态工作流：开门与关门之间的差集必须**恰好**是这十个。
  // 反向地也守住了旧 `Workflow`（/expert 脚本通道）——它的门始终只有 includeWorkflow，
  // 不因灰度多一道或少一道。
  it("关门与开门的差集恰好是十个，不多剃一件工具", () => {
    const enabled = createToolRegistry();
    registerBuiltInTools(enabled, { includeDynamicWorkflow: true, includeWorkflow: true });
    const disabled = createToolRegistry();
    registerBuiltInTools(disabled, { includeDynamicWorkflow: false, includeWorkflow: true });

    const registeredWhenDisabled = new Set(disabled.list());
    expect(
      enabled
        .list()
        .filter((name) => !registeredWhenDisabled.has(name))
        .toSorted(),
    ).toEqual([...GATED_TOOL_NAMES].toSorted());
  });

  // 缺席即全开（进程内嵌入方）；独立 CLI 的 TUI / headless 按 --workflow-mode 显式传 true/false（DWG-04）。
  it.each([{ includeDynamicWorkflow: undefined }, { includeDynamicWorkflow: true }])(
    "缺席或 true 时十个工具全部注册：%j",
    (options) => {
      const registry = createToolRegistry();
      registerBuiltInTools(registry, options);
      for (const name of GATED_TOOL_NAMES) {
        expect({ name, registered: registry.has(name) }).toEqual({ name, registered: true });
      }
    },
  );
});

// 灰度门从 runtimeConfig 走到注册表的这一跳（runtime-tools.ts）：与 off-peak 不同，
// 判据不是端口在场，而是 Host 或独立 CLI 入口写下的显式 false。
describe("AgentRuntime：dynamicWorkflowEnabled 到工具注册表", () => {
  it.each([
    { config: { dynamicWorkflowEnabled: false }, registered: false },
    { config: { dynamicWorkflowEnabled: true }, registered: true },
    // 进程内嵌入方不写这个字段，必须保留全部工具。
    { config: {}, registered: true },
  ])("config %j", ({ config: runtimeConfig, registered }) => {
    const registry = createToolRegistry();
    new AgentRuntime(createSessionId("gray-release"), runtimeConfig, {
      eventStore: createTestSessionEventStore(),
      toolRegistry: registry,
    });
    expect(registry.has(CREATE_WORKFLOW_TOOL_NAME)).toBe(registered);
    expect(registry.has(RESOLVE_WORKFLOW_QUESTION_TOOL_NAME)).toBe(registered);
  });
});

// 回归（2026-09-16）：注册面有两个入口，第二个（分支刷新）当初漏了灰度门，于是十个工具
// 在 Bash shell 快照初始化时被原样加回来。真实触发路径就是 initializeSessionShellEnvironmentIfNeeded，
// 所以这里走公开方法而不是直接调内部的 refreshBranchAwareBuiltInTools。
describe("AgentRuntime：分支刷新后灰度门仍然成立", () => {
  const CMD_SHELL_SELECTION = {
    dialect: "cmd",
    display: { name: "CMD" },
    id: "cmd",
    label: "CMD",
    path: "cmd.exe",
    source: "user-config",
  } as const;

  it.each([
    { config: { dynamicWorkflowEnabled: false }, registered: false },
    { config: { dynamicWorkflowEnabled: true }, registered: true },
    { config: {}, registered: true },
  ])("config %j", ({ config: runtimeConfig, registered }) => {
    const runtime = new AgentRuntime(createSessionId("gray-release-refresh"), runtimeConfig, {
      eventStore: createTestSessionEventStore(),
      toolRegistry: createToolRegistry(),
    });
    // 首次装配后的形态。
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(registered);

    // 第一次真实用户执行前的 shell 快照初始化，内部走 refreshBranchAwareBuiltInTools。
    expect(runtime.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);

    const registry = runtime.getToolRegistry();
    for (const name of GATED_DYNAMIC_WORKFLOW_TOOL_NAMES) {
      expect({ name, registered: registry.has(name) }).toEqual({ name, registered });
    }
    // 反向断言：刷新本身的职责（embedded search 分支下的 Glob/Grep）不受影响，
    // 普通工具面在三种取值下都还在。
    expect(registry.has("Read")).toBe(true);
  });
});

// 灰度门不止管注册面，也管**描述**（docs/dynamic-workflow/launch.md「Gray release」）：
// Agent / Task 的 provider 描述里有一条「用户点名工作流时 CreateWorkflow 是强制的」，
// 关闭时那个工具不在注册表里，留着这句话只会把模型指向一个不存在的工具。
// 两个注册入口共用 options.includeDynamicWorkflow，所以分支刷新后的描述也必须一致。
describe("Agent / Task 描述随灰度门增删工作流那一行", () => {
  function descriptionsOf(options: { includeDynamicWorkflow?: boolean }): {
    agent: string;
    task: string;
  } {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeAgent: true, ...options });
    const agent = registry.get("Agent")?.metadata.description ?? "";
    const task = registry.get("Task")?.metadata.description ?? "";
    return { agent, task };
  }

  it("关闭时 Agent 与 Task 的描述都不再提 CreateWorkflow", () => {
    const { agent, task } = descriptionsOf({ includeDynamicWorkflow: false });
    expect(agent).not.toContain("CreateWorkflow");
    expect(task).not.toContain("CreateWorkflow");
    // 反向断言：只去掉那一行，描述本体还在。
    expect(agent).toContain("Launch a new agent");
    expect(task).toContain("Claude Code-compatible alias");
  });

  it.each([{ includeDynamicWorkflow: true }, {}])("开启或缺席时那一行保留：%j", (options) => {
    const { agent, task } = descriptionsOf(options);
    expect(agent).toContain("CreateWorkflow");
    expect(task).toContain("CreateWorkflow");
  });
});
