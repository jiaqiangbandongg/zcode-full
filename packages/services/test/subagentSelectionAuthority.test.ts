import { describe, expect, it } from "vitest";
import { parseSubagentMarkdown } from "../src/subagents/subagentMarkdown.js";

describe("Subagent 正式 Markdown 字段", () => {
  it.each(["null", "{}", "false"])("忽略中间字段 %s，model 是正式字段而不是 fallback", (value) => {
    const result = parseSubagentMarkdown({
      content: `---\nname: audit\ndescription: audit\nmodelSelection: ${value}\nmodel: personal:p/m\nthoughtLevel: high\n---\nAudit`,
      path: "/fixture/audit.md",
      scope: "user",
    });
    expect(result.agent?.modelSelection).toEqual({
      providerId: "personal:p",
      modelId: "m",
      options: { reasoningLevel: "high" },
    });
  });
});
