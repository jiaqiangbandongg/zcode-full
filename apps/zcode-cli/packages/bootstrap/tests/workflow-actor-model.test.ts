/**
 * actor 模型面的 driver 侧解析与落库。见 dynamic-workflow/docs/execution-engine.md 的
 * 「Subagent model (resolved model pin)」。
 *
 * 2026-09-11 起 persona 没有模型档位（docs/dynamic-workflow/authoring.md），所以
 * 这里只剩两层：
 *   1. `workflowActorModelPolicy` —— journal pin → AgentRuntimeConfig 的模型面切片（纯函数）；
 *   2. `journalActorResolvedModel` —— 实际用上的模型 → dwf_actor 记录（读改写，不整条覆盖）。
 *
 * 为什么独立成文件而不并入 dynamic-workflow-run-service.test.ts：那份用例在运行时 import
 * `@zcode/core`（真实 AgentRuntime），本仓当前环境下会被 `@zcode/zcode-cua` 卡住。这两层都
 * 只依赖类型，所以能单独跑——而它们恰是这个特性里唯一有分支的逻辑。
 */

import { describe, expect, it } from "vitest";
import type { ModelSelection } from "@zcode/contracts";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import {
  WorkflowActorModelUnboundError,
  WorkflowActorPinnedModelError,
  resolveActorPersonaModel,
  workflowActorModelPolicy,
} from "../src/app/workflow-actor-model.js";
import { workflowActorToolPolicy } from "../src/app/workflow-actor-tools.js";
import {
  journalActorResolvedModel,
  pinnedActorModel,
} from "../src/app/dynamic-workflow-run-launch.js";

function selection(providerId: string, modelId: string): ModelSelection {
  return { providerId, modelId };
}

const PARENT = selection("anthropic", "sonnet");
const OTHER = selection("anthropic", "haiku");
/** run 级选择带档位：`subagent_model` 的 `$level` 是选择的一部分，绝不能在策略里掉。 */
const RUN_CHOICE: ModelSelection = {
  providerId: "zhipu",
  modelId: "glm-5.3-flash",
  options: { reasoningLevel: "high" },
};

describe("workflowActorModelPolicy", () => {
  it("overrides nothing without a pin: the child inherits the parent session's current model", () => {
    // 空切片即「不覆盖」：回落由 child runtime 的基线完成（父会话当前模型），这里不需要任何
    // 分支——persona 里已经没有会改变模型的成员。
    expect(workflowActorModelPolicy({ parentSelection: PARENT }).configOverrides).toEqual({});
  });

  it("works without a parent selection at all (parent session not yet bound to a model)", () => {
    expect(workflowActorModelPolicy({}).configOverrides).toEqual({});
  });

  it("shares no config keys with the tool policy", () => {
    // create-app 把两个策略展开进**同一个** configOverrides 对象。键一旦相交，后展开的那个
    // 会静默吃掉前一个——一个 actor 会安静地丢掉自己的工具档位或模型 pin。
    const model = workflowActorModelPolicy({ parentSelection: PARENT }, "anthropic/haiku");
    const overlap = Object.keys(workflowActorToolPolicy()).filter(
      (key) => key in model.configOverrides,
    );
    expect(overlap).toEqual([]);
  });
});

// ── 本 run 的子代理模型（docs/dynamic-workflow/launch.md）──────────────────────────────
// 优先级：本 run 的 subagentModel > resume pin > 父会话当前模型。省略即继承，显式值即替换：
// pin 只守**隐式缺省**（没有 run 选择时「上次实际跑的模型」），run 选择在场时它无话可说。
describe("workflowActorModelPolicy (run-level subagent model)", () => {
  it("no pin + a run selection: overrides with the whole selection, reasoning level included", () => {
    // 判别用例：按身份覆盖会把 `$high` 悄悄丢掉，而档位正是用户说出口的那一半。
    const policy = workflowActorModelPolicy({ parentSelection: PARENT, runSelection: RUN_CHOICE });
    expect(policy.configOverrides).toEqual({ modelSelection: RUN_CHOICE });
  });

  it("no pin + no run selection: overrides nothing (the child inherits the session model)", () => {
    expect(workflowActorModelPolicy({ parentSelection: PARENT }).configOverrides).toEqual({});
    expect(workflowActorModelPolicy({}).configOverrides).toEqual({});
  });

  it("the run selection applies even when the parent session has no model of its own", () => {
    expect(workflowActorModelPolicy({ runSelection: RUN_CHOICE }).configOverrides).toEqual({
      modelSelection: RUN_CHOICE,
    });
  });

  it("a pin with the run selection's identity yields the run selection, not the pin", () => {
    // resume：pin 记的是身份两段（journal 只存这两段），run 选择带着档位。两者同一个模型时
    // 采用**更完整**的那一份——否则一次 resume 会静默把 `$high` 降级成模型的默认档位。
    const policy = workflowActorModelPolicy(
      { parentSelection: PARENT, runSelection: RUN_CHOICE },
      "zhipu/glm-5.3-flash",
    );
    expect(policy.configOverrides).toEqual({ modelSelection: RUN_CHOICE });
  });

  it("a pin with the parent's identity and no run selection overrides nothing", () => {
    const policy = workflowActorModelPolicy({ parentSelection: PARENT }, "anthropic/sonnet");
    expect(policy.configOverrides).toEqual({});
  });

  it("the run selection wins over a differing pin (the amend asked for the switch)", () => {
    // 回归用例（2026-09-17 testfield）：前驱的子代理跑在 pin 上，用户 AmendWorkflow 带
    // `subagent_model` 换成别的模型，确认窗与工具输出都说「Subagents run on Z」——结果 driver
    // 仍按 pin 造会话。pin 防的是**静默**换模型；一次带 `subagent_model` 的 amend 恰是那个
    // 显式、用户看得见的决定，pin 无权压过它。
    const policy = workflowActorModelPolicy(
      { parentSelection: PARENT, runSelection: RUN_CHOICE },
      "openai/gpt-x",
    );
    expect(policy.configOverrides).toEqual({ modelSelection: RUN_CHOICE });
  });

  it("a pin equal to the parent model still yields the run selection", () => {
    // 事故的原形：前驱没设 subagent_model，子代理跑在会话模型上（pin = 父模型），amend 给了
    // 新选择。run 选择在场时 pin 与谁相等都无关——它只在没有 run 选择时才是缺省。
    const policy = workflowActorModelPolicy(
      { parentSelection: PARENT, runSelection: RUN_CHOICE },
      "anthropic/sonnet",
    );
    expect(policy.configOverrides).toEqual({ modelSelection: RUN_CHOICE });
  });

  it("with a run selection a malformed pin is never parsed: the run selection applies, no throw", () => {
    // pin 在 run 选择面前无关，所以也不去解析它——畸形 pin 的大声失败只属于「没有 run 选择、
    // 只能靠 pin 回答」那条路径（见下面的 resume pin 用例）。
    const policy = workflowActorModelPolicy(
      { parentSelection: PARENT, runSelection: RUN_CHOICE },
      "haiku",
    );
    expect(policy.configOverrides).toEqual({ modelSelection: RUN_CHOICE });
  });
});

// docs/dynamic-workflow/authoring.md「Choosing a model per subagent」：persona 点名的模型经本 run 的
// 绑定表解析，排在 run 选择与 pin 之上。
describe("workflowActorModelPolicy (persona model)", () => {
  const ACTOR_CHOICE: ModelSelection = {
    providerId: "zhipu",
    modelId: "GLM-5.3",
    options: { reasoningLevel: "low" },
  };

  it("the persona's model wins over the run selection and a differing pin, whole", () => {
    expect(
      workflowActorModelPolicy(
        { parentSelection: PARENT, runSelection: RUN_CHOICE, actorSelection: ACTOR_CHOICE },
        "anthropic/haiku",
      ).configOverrides,
    ).toEqual({ modelSelection: ACTOR_CHOICE });
  });

  it("a malformed pin is never parsed when the persona names a model", () => {
    expect(() =>
      workflowActorModelPolicy({ actorSelection: ACTOR_CHOICE }, "no-provider-segment"),
    ).not.toThrow();
  });

  it("without a persona model the run selection still applies (the default for the rest)", () => {
    expect(
      workflowActorModelPolicy({ parentSelection: PARENT, runSelection: RUN_CHOICE })
        .configOverrides,
    ).toEqual({ modelSelection: RUN_CHOICE });
  });
});

describe("resolveActorPersonaModel", () => {
  const BINDINGS = { "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash", "GLM-5.3$low": "zhipu/GLM-5.3$low" };

  it("looks the name up verbatim and returns the whole selection", () => {
    expect(resolveActorPersonaModel("GLM-5.3$low", BINDINGS)).toEqual({
      providerId: "zhipu",
      modelId: "GLM-5.3",
      options: { reasoningLevel: "low" },
    });
    expect(resolveActorPersonaModel("GLM-5.3-Flash", BINDINGS)).toEqual({
      providerId: "zhipu",
      modelId: "GLM-5.3-Flash",
    });
  });

  it("a persona without a model resolves to nothing (the run selection, pin or parent decide)", () => {
    expect(resolveActorPersonaModel(undefined, BINDINGS)).toBeUndefined();
    expect(resolveActorPersonaModel(undefined, undefined)).toBeUndefined();
  });

  it("an unbound name fails loudly, naming it and what the run did bind", () => {
    // 只有绕过 9010 的类型断言走得到这里；悄悄退回 run 的模型就是跑一个没人批准过的模型。
    expect(() => resolveActorPersonaModel("glm-5.3-flash", BINDINGS)).toThrow(
      WorkflowActorModelUnboundError,
    );
    expect(() => resolveActorPersonaModel("x", undefined)).toThrow(/the script named no models/);
    expect(() => resolveActorPersonaModel("x", BINDINGS)).toThrow(
      /"GLM-5.3-Flash", "GLM-5.3\$low"/,
    );
  });
});

describe("workflowActorModelPolicy (resume pin)", () => {
  // pin 是 persona 冻结不变式的持久化那一半：没有 run 选择时，resume 重建的 actor 必须跑在
  // 上一次实际跑的模型上，而不是父会话此刻漂到的模型上。

  it("pin equal to the current parent model overrides nothing", () => {
    // 不覆盖是更强的表达：child runtime 的基线连 reasoning 选项一起继承；按身份覆盖会把
    // 选项换成一个少了 options 的等价物。
    const policy = workflowActorModelPolicy({ parentSelection: PARENT }, "anthropic/sonnet");
    expect(policy.configOverrides).toEqual({});
  });

  it("pin comparison ignores the parent's reasoning options (identity is provider/model)", () => {
    const policy = workflowActorModelPolicy(
      { parentSelection: { ...PARENT, options: { reasoningLevel: "high" } } },
      "anthropic/sonnet",
    );
    expect(policy.configOverrides).toEqual({});
  });

  it("pins a model that is not the current parent model (no run selection: the pin is the default)", () => {
    // 判别用例：父会话在两次 run 之间换了主模型。没有 pin，这个 actor 会悄悄挪到新模型上——
    // 正是 pin 要防的静默身份变更。
    const policy = workflowActorModelPolicy({ parentSelection: PARENT }, "openai/gpt-x");
    expect(policy.configOverrides.modelSelection).toEqual({
      providerId: "openai",
      modelId: "gpt-x",
    });
    expect(workflowActorModelPolicy({}, "anthropic/haiku").configOverrides).toEqual({
      modelSelection: OTHER,
    });
  });

  it("a malformed pin fails loudly instead of falling back to the parent model", () => {
    // 缺 provider 段的 pin 不是本机写出的格式：拿父会话 provider 去补等于猜出一个新身份。
    // 宁可大声失败（v1 的 pin-miss 策略），绝不静默回退。
    expect(() => workflowActorModelPolicy({ parentSelection: PARENT }, "haiku")).toThrow(
      WorkflowActorPinnedModelError,
    );
  });
});

describe("pinnedActorModel", () => {
  const RUN = "dwfrun-pin";
  const ACTOR = { siteId: "actor#1", ordinal: 1 };

  it("returns the journaled resolvedModel when a previous run recorded one", () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({
      runId: RUN,
      siteId: ACTOR.siteId,
      ordinal: ACTOR.ordinal,
      persona: { name: "judge" },
      resolvedModel: "anthropic/haiku",
    });
    expect(pinnedActorModel({ actor: ACTOR, journal, runId: RUN })).toBe("anthropic/haiku");
  });

  it("is undefined for a fresh actor record and for a missing record", () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    // 全新 run：引擎刚落了 persona，宿主还没造会话——runtime 工厂此刻读到的必须是缺席。
    journal.putActor({
      runId: RUN,
      siteId: ACTOR.siteId,
      ordinal: ACTOR.ordinal,
      persona: { name: "judge" },
    });
    expect(pinnedActorModel({ actor: ACTOR, journal, runId: RUN })).toBeUndefined();
    expect(
      pinnedActorModel({ actor: { siteId: "actor#9", ordinal: 1 }, journal, runId: RUN }),
    ).toBeUndefined();
  });
});

describe("journalActorResolvedModel", () => {
  const RUN = "dwfrun-1";
  const ACTOR = { siteId: "actor#1", ordinal: 1 };

  function journalWithActor() {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    // 引擎在 createActor 时同步落下的那条记录：冻结 persona，还没有模型记录。
    journal.putActor({
      runId: RUN,
      siteId: ACTOR.siteId,
      ordinal: ACTOR.ordinal,
      name: "judge",
      persona: { name: "judge" },
    });
    return journal;
  }

  it("records the model the runtime actually got, without touching the frozen persona", () => {
    const journal = journalWithActor();
    journalActorResolvedModel({ actor: ACTOR, journal, selection: OTHER, runId: RUN });

    expect(journal.getActor(RUN, ACTOR.siteId, ACTOR.ordinal)).toEqual({
      runId: RUN,
      siteId: ACTOR.siteId,
      ordinal: ACTOR.ordinal,
      name: "judge",
      persona: { name: "judge" },
      resolvedModel: "anthropic/haiku",
    });
  });

  it("records the parent model verbatim on the no-override path", () => {
    // 「不覆盖」在记录里不是空白，而是父模型本身——run 的成本因此可审计，而 resume 能看出
    // 上一次究竟跑在哪个模型上。
    const journal = journalWithActor();
    journalActorResolvedModel({ actor: ACTOR, journal, selection: PARENT, runId: RUN });

    expect(journal.getActor(RUN, ACTOR.siteId, ACTOR.ordinal)?.resolvedModel).toBe(
      "anthropic/sonnet",
    );
  });

  it("keeps a sessionId written earlier by the driver", () => {
    // putActor 是整条记录的替换，而这条记录有两个 driver 侧作者（会话 id 与模型记录）。
    const journal = journalWithActor();
    const existing = journal.getActor(RUN, ACTOR.siteId, ACTOR.ordinal)!;
    journal.putActor({ ...existing, sessionId: "ses_actor" });
    journalActorResolvedModel({ actor: ACTOR, journal, selection: OTHER, runId: RUN });

    expect(journal.getActor(RUN, ACTOR.siteId, ACTOR.ordinal)).toMatchObject({
      sessionId: "ses_actor",
      resolvedModel: "anthropic/haiku",
      persona: { name: "judge" },
    });
  });
});
