import { describe, expect, it } from "vitest";
import { importSubagentStateSelections } from "../src/subagent-state-migration.js";

describe("Subagent 内置 state 单向导入", () => {
  const pluginId = "plugin:document-skills@zcode-plugins-official:judge";
  const pluginLegacy = {
    pluginAgentModelOverrides: { [pluginId]: "custom:builtin%3Azai-coding-plan:GLM" },
    pluginAgentThoughtLevelOverrides: { [pluginId]: "high" },
  };
  it("staging 插件双map仅在存储边界离线导入，保留来源记录且再次导入幂等", () => {
    const next = importSubagentStateSelections(pluginLegacy);
    expect(next.pluginAgentModelSelectionOverrides).toEqual({
      [pluginId]: {
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM",
        options: { reasoningLevel: "high" },
      },
    });
    expect(next).toMatchObject(pluginLegacy);
    expect(importSubagentStateSelections(next)).toEqual(next);
  });
  it.each([{}, null, { [pluginId]: "custom:p/m" }, { [pluginId]: { modelId: "bad" } }])(
    "插件正式map %j 存在时不回读旧map",
    (current) => {
      expect(
        importSubagentStateSelections({
          ...pluginLegacy,
          pluginAgentModelSelectionOverrides: current,
        }).pluginAgentModelSelectionOverrides,
      ).toEqual({});
    },
  );
  it("插件正式model-only覆盖不回填旧档位/不继续迁移旧Provider中间身份", () => {
    const selection = { providerId: "builtin:zai-coding-plan", modelId: "GLM" };
    expect(
      importSubagentStateSelections({
        ...pluginLegacy,
        pluginAgentModelSelectionOverrides: { [pluginId]: selection },
      }).pluginAgentModelSelectionOverrides,
    ).toEqual({ [pluginId]: selection });
  });

  const legacy = {
    builtInModelOverrides: { Explore: "custom:builtin%3Azai-coding-plan:m" },
    builtInThoughtLevelOverrides: { Explore: "high" },
    disabledAgentIds: ["a"],
    extra: "keep",
  };
  it("旧双 map 在明确导入边界转换，保留回滚数据", () => {
    const next = importSubagentStateSelections(legacy);
    expect(next).toMatchObject(legacy);
    expect(next.builtInModelSelectionOverrides).toEqual({
      Explore: {
        providerId: "account:zai-individual-coding-plan",
        modelId: "m",
        options: { reasoningLevel: "high" },
      },
    });
    expect(importSubagentStateSelections(next)).toEqual(next);
  });
  it.each([
    {},
    null,
    { Explore: null },
    { Explore: "custom:p/m" },
    { Explore: { modelId: "bad" } },
  ])("已有正式字段 %j 不回读旧双 map", (current) => {
    expect(
      importSubagentStateSelections({ ...legacy, builtInModelSelectionOverrides: current })
        .builtInModelSelectionOverrides,
    ).toEqual({});
  });
  it.each([undefined, "low"])("正式选择的档位 %s 不从旧 high 补值", (reasoningLevel) => {
    const selection = {
      providerId: "p",
      modelId: "m",
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    };
    expect(
      importSubagentStateSelections({
        ...legacy,
        builtInModelSelectionOverrides: { Explore: selection },
      }).builtInModelSelectionOverrides.Explore,
    ).toEqual(selection);
  });
  it("正式 map 不兼容未发布的旧身份中间产物", () => {
    const selection = { providerId: "builtin:zai-coding-plan", modelId: "m" };
    expect(
      importSubagentStateSelections({
        ...legacy,
        builtInModelSelectionOverrides: { Explore: selection },
      }).builtInModelSelectionOverrides.Explore,
    ).toEqual(selection);
  });
});
