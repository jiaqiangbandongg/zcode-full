import { describe, expect, it } from "vitest";
import {
  parseSubagentMarkdownSelection,
  formatSubagentMarkdownModel,
  migrateSubagentMarkdownProvider,
} from "../src/subagent-markdown-selection.js";

describe("Subagent 正式 Markdown 字段和单向文本迁移", () => {
  it("只读取 model/thoughtLevel，不读取未发布中间字段或结构化 model", () => {
    expect(
      parseSubagentMarkdownSelection({ modelSelection: { providerId: "p", modelId: "m" } }),
    ).toBeUndefined();
    expect(
      parseSubagentMarkdownSelection({ model: { providerId: "p", modelId: "m" } }),
    ).toBeUndefined();
    expect(
      parseSubagentMarkdownSelection({
        model: "p/m",
        thoughtLevel: "high",
        modelSelection: { providerId: "wrong", modelId: "wrong" },
      }),
    ).toEqual({ providerId: "p", modelId: "m", options: { reasoningLevel: "high" } });
  });
  it.each(["plain", "vendor/model", "model$variant", "模型:% /x"])(
    "模型 ID 无损往返 %s",
    (modelId) => {
      const selection = {
        providerId: "account:bigmodel-individual-coding-plan",
        modelId,
        options: { reasoningLevel: "high" },
      };
      expect(
        parseSubagentMarkdownSelection({
          model: formatSubagentMarkdownModel(selection),
          thoughtLevel: "high",
        }),
      ).toEqual(selection);
    },
  );
  it("普通读取不替换范围外的旧账号身份", () => {
    expect(
      parseSubagentMarkdownSelection({ model: "builtin:bigmodel-coding-plan/GLM" })?.providerId,
    ).toBe("builtin:bigmodel-coding-plan");
  });
  it.each(["custom:my-provider", "vendor/provider"])("Provider ID 无损往返 %s", (providerId) => {
    const selection = { providerId, modelId: "model" };
    expect(
      parseSubagentMarkdownSelection({ model: formatSubagentMarkdownModel(selection) }),
    ).toEqual(selection);
  });
  it.each([
    ["builtin:zai-start-plan/glm-5.3-flash", "account:zai-start-plan/GLM-5.3-Flash"],
    [
      "custom:builtin%3Abigmodel-coding-plan:glm-5.3",
      "custom:account%3Abigmodel-individual-coding-plan:GLM-5.3",
    ],
    [
      "builtin:bigmodel-coding-plan/glm-5.3$high",
      "account:bigmodel-individual-coding-plan/GLM-5.3$high",
    ],
    [
      "builtin:bigmodel-coding-plan/GLM/vendor",
      "account:bigmodel-individual-coding-plan/GLM/vendor",
    ],
    [
      "custom:builtin%3Azai-coding-plan:model%24variant",
      "custom:account%3Azai-individual-coding-plan:model%24variant",
    ],
    [
      "custom:builtin:bigmodel-coding-plan:GLM%2Fx",
      "custom:account%3Abigmodel-individual-coding-plan:GLM%2Fx",
    ],
  ])("迁移仅改变身份，不改正文、档位和注释：%s", (before, after) => {
    const content = `\uFEFF---\r\nname: helper\r\n# 备注\r\nmodel: '${before}' # 保留\r\nthoughtLevel: high\r\nextra: 123\r\n---\r\n正文 ${before}\r\n`;
    const expected = content.replace(`model: '${before}'`, `model: '${after}'`);
    expect(migrateSubagentMarkdownProvider(content)).toBe(expected);
    expect(migrateSubagentMarkdownProvider(expected)).toBe(expected);
  });
  it("无 frontmatter、仅中间字段、继承、未知旧身份不改写", () => {
    for (const content of [
      "model: builtin:bigmodel-coding-plan/GLM",
      '---\nmodelSelection: {"providerId":"builtin:bigmodel-coding-plan","modelId":"GLM"}\n---\nbody',
      "---\nmodel: inherit\n---\nbody",
      "---\nmodel: builtin:unknown/GLM\n---\nbody",
    ])
      expect(migrateSubagentMarkdownProvider(content)).toBe(content);
  });
});
