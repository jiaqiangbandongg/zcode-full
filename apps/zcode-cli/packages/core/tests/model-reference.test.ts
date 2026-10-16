import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "@zcode/contracts";
import {
  describeWorkflowSubagentModel,
  formatModelCatalogId,
  parseWorkflowSubagentModel,
  resolveModelReference,
} from "../src/tool/handlers/model-reference.js";

/**
 * 目录条目的最小构造器。`reasoningLevels` 与 `current` 在端口契约上是**必填**（空数组与
 * false 各有意义），所以这里给的是默认值而不是让它们缺席。
 */
function entry(
  providerId: string,
  modelId: string,
  extra: Partial<ModelCatalogEntry> = {},
): ModelCatalogEntry {
  return { providerId, modelId, reasoningLevels: [], current: false, ...extra };
}

function expectOk(resolution: ReturnType<typeof resolveModelReference>) {
  expect(resolution.ok).toBe(true);
  if (!resolution.ok) throw new Error(`expected a resolution, got ${resolution.reason}`);
  return resolution;
}

function expectFailure(resolution: ReturnType<typeof resolveModelReference>) {
  expect(resolution.ok).toBe(false);
  if (resolution.ok) throw new Error("expected a failure");
  return resolution;
}

describe("resolveModelReference — 三档匹配", () => {
  it("第 1 档：全称精确命中，哪怕裸名在别处也唯一", () => {
    const entries = [entry("zhipu", "glm-4.6"), entry("openai", "glm-4.6")];
    const resolved = expectOk(resolveModelReference("openai/glm-4.6", entries));
    expect(resolved.canonical).toBe("openai/glm-4.6");
    expect(resolved.selection).toEqual({ providerId: "openai", modelId: "glm-4.6" });
    expect(resolved.entry).toBe(entries[1]);
  });

  it("第 2 档：裸模型名只挂在一个 provider 下就直接命中", () => {
    const entries = [entry("zhipu", "glm-4.6"), entry("openai", "gpt-5")];
    expect(expectOk(resolveModelReference("gpt-5", entries)).canonical).toBe("openai/gpt-5");
  });

  it("第 3 档：裸名撞多个 provider 时，当前会话那一条胜出", () => {
    const entries = [
      entry("zhipu", "glm-4.6"),
      entry("bigmodel", "glm-4.6", { current: true }),
      entry("openrouter", "glm-4.6"),
    ];
    const resolved = expectOk(resolveModelReference("glm-4.6", entries));
    expect(resolved.canonical).toBe("bigmodel/glm-4.6");
  });

  it("第 3 档无当前项：回 ambiguous 并列出撞上的全部全称", () => {
    const entries = [entry("zhipu", "glm-4.6"), entry("openrouter", "glm-4.6")];
    const failed = expectFailure(resolveModelReference("glm-4.6", entries));
    expect(failed.reason).toBe("ambiguous");
    expect(failed.message).toContain("zhipu/glm-4.6");
    expect(failed.message).toContain("openrouter/glm-4.6");
    expect(failed.message).toContain("providerId/modelId");
    expect(failed.candidates).toHaveLength(2);
  });

  it("三档比较一律大小写不敏感，且规范形用注册表自己的拼写", () => {
    const entries = [entry("BigModel", "GLM-4.6")];
    // 用户打什么大小写都行；回填进 `subagent_model` 的那一个必须是目录里的原样拼写。
    expect(expectOk(resolveModelReference("bigmodel/glm-4.6", entries)).canonical).toBe(
      "BigModel/GLM-4.6",
    );
    expect(expectOk(resolveModelReference("GLM-4.6", entries)).canonical).toBe("BigModel/GLM-4.6");
    expect(expectOk(resolveModelReference("  glm-4.6  ", entries)).canonical).toBe(
      "BigModel/GLM-4.6",
    );
  });
});

describe("resolveModelReference — 禁用条目", () => {
  it("只匹配到禁用条目时回 disabled，并把每条的理由说出来", () => {
    const entries = [entry("zhipu", "glm-4.6", { disabledReason: "no API key configured" })];
    const failed = expectFailure(resolveModelReference("glm-4.6", entries));
    expect(failed.reason).toBe("disabled");
    expect(failed.message).toContain("no API key configured");
    expect(failed.message).toContain("zhipu/glm-4.6");
    expect(failed.candidates).toEqual(entries);
  });

  it("禁用条目绝不参与第 3 档的歧义：同名的可用条目照常胜出", () => {
    const entries = [
      entry("zhipu", "glm-4.6", { disabledReason: "disabled by policy" }),
      entry("bigmodel", "glm-4.6"),
    ];
    // 只有一条可用，所以不需要 current 兜底也不该是 ambiguous。
    expect(expectOk(resolveModelReference("glm-4.6", entries)).canonical).toBe("bigmodel/glm-4.6");
  });

  it("not_found 的清单里不出现禁用条目：挑了也用不了的名字只会换来第二次失败", () => {
    const entries = [
      entry("zhipu", "glm-4.6", { disabledReason: "no API key configured" }),
      entry("openai", "gpt-5"),
    ];
    const failed = expectFailure(resolveModelReference("claude-opus-5", entries));
    expect(failed.message).toContain("openai/gpt-5");
    expect(failed.message).not.toContain("zhipu/glm-4.6");
    expect(failed.candidates).toEqual([entries[1]]);
  });
});

describe("resolveModelReference — not_found 的文案", () => {
  it("点名给的那个字符串、列出可用 id 并标出当前项，末尾给出 ListModels 这条路", () => {
    const entries = [entry("zhipu", "glm-4.6", { current: true }), entry("openai", "gpt-5")];
    const failed = expectFailure(resolveModelReference("gemini-3", entries));
    expect(failed.reason).toBe("not_found");
    expect(failed.message).toContain("`gemini-3`");
    expect(failed.message).toContain("zhipu/glm-4.6 [current]");
    expect(failed.message).toContain("openai/gpt-5");
    expect(failed.message).not.toContain("openai/gpt-5 [current]");
    expect(failed.message).toContain("Pass one of these ids, or call ListModels.");
  });

  it("目录本身为空时说「这台机器没配模型」，而不是给一份空清单", () => {
    const failed = expectFailure(resolveModelReference("gpt-5", []));
    expect(failed.reason).toBe("not_found");
    expect(failed.message).toContain("No models are configured on this host.");
    expect(failed.candidates).toEqual([]);
  });

  it("清单封顶在 40 行，余下的换成一句可以拿到全量的话", () => {
    const entries = Array.from({ length: 60 }, (_, index) => entry("p", `m-${index}`));
    const failed = expectFailure(resolveModelReference("nope", entries));
    const listed = failed.message.split("\n").filter((line) => line.startsWith("p/m-"));
    expect(listed).toHaveLength(40);
    expect(failed.message).toContain("… and 20 more.");
    // candidates 不截断：它是给调用方的结构化事实，截断的只有面向模型的那份文案。
    expect(failed.candidates).toHaveLength(60);
  });
});

describe("resolveModelReference — $reasoningLevel", () => {
  const LEVELED = entry("bigmodel", "glm-4.6", {
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "high",
  });

  it("给了合法档位就带进选型，并用注册表的拼写", () => {
    const resolved = expectOk(resolveModelReference("bigmodel/glm-4.6$LOW", [LEVELED]));
    expect(resolved.selection.options).toEqual({ reasoningLevel: "low" });
    expect(resolved.canonical).toBe("bigmodel/glm-4.6$low");
  });

  it("裸名加档位同样走第 2 档", () => {
    expect(expectOk(resolveModelReference("glm-4.6$medium", [LEVELED])).canonical).toBe(
      "bigmodel/glm-4.6$medium",
    );
  });

  it("档位不认识时回 reasoning_level_unknown，并列出这个模型的档位与默认档", () => {
    const failed = expectFailure(resolveModelReference("glm-4.6$ultra", [LEVELED]));
    expect(failed.reason).toBe("reasoning_level_unknown");
    expect(failed.message).toContain("`ultra`");
    expect(failed.message).toContain("low, medium, high");
    expect(failed.message).toContain("Omit the suffix to use high.");
    // 整张目录不进这条文案：模型名是认对的，错的只有档位。
    expect(failed.candidates).toEqual([LEVELED]);
  });

  it("给没有档位的模型接 `$` 时说清该模型根本没有档位", () => {
    const failed = expectFailure(resolveModelReference("gpt-5$high", [entry("openai", "gpt-5")]));
    expect(failed.reason).toBe("reasoning_level_unknown");
    expect(failed.message).toContain("has no reasoning levels");
  });

  it("不给档位时用注册表默认档", () => {
    expect(expectOk(resolveModelReference("glm-4.6", [LEVELED])).selection.options).toEqual({
      reasoningLevel: "high",
    });
  });

  it("模型没有档位时不造 options", () => {
    const resolved = expectOk(resolveModelReference("gpt-5", [entry("openai", "gpt-5")]));
    expect(resolved.selection.options).toBeUndefined();
    expect(resolved.canonical).toBe("openai/gpt-5");
  });

  it("有档位但注册表没给默认档时同样不造 options：没有可用的那一个就不猜", () => {
    const noDefault = entry("openai", "o5", { reasoningLevels: ["low", "high"] });
    expect(expectOk(resolveModelReference("o5", [noDefault])).selection.options).toBeUndefined();
  });
});

describe("规范形的读写", () => {
  it("describeWorkflowSubagentModel 只在设了模型时出现，并说明主代理没换", () => {
    expect(describeWorkflowSubagentModel(undefined)).toBe("");
    expect(describeWorkflowSubagentModel("bigmodel/glm-4.6$high")).toBe(
      " Subagents run on bigmodel/glm-4.6$high (the main agent stays on the session model).",
    );
  });

  it("parseWorkflowSubagentModel 把规范形拆回选型，缺席即缺席", () => {
    expect(parseWorkflowSubagentModel(undefined)).toBeUndefined();
    expect(parseWorkflowSubagentModel("bigmodel/glm-4.6$high")).toEqual({
      providerId: "bigmodel",
      modelId: "glm-4.6",
      options: { reasoningLevel: "high" },
    });
  });

  it("parseWorkflowSubagentModel 对没归一化过的字符串喊出来，而不是静默丢掉用户要的模型", () => {
    // 走到 handler 的字符串一定过了 resolveInput，所以这里的失败是接线故障。
    expect(() => parseWorkflowSubagentModel("glm-4.6")).toThrow(/un-canonicalised/u);
  });

  it("formatModelCatalogId 不带档位：id 是可以逐字抄进 subagent_model 的那一半", () => {
    expect(formatModelCatalogId(entry("bigmodel", "glm-4.6", { reasoningLevels: ["high"] }))).toBe(
      "bigmodel/glm-4.6",
    );
  });
});
