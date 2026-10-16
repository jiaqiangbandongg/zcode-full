import { describe, expect, it } from "vitest";
import { botCurrentOptionsSchema, botDraftOptionsSchema } from "../src/bots.js";

describe("Bot 旧 agent provider 兼容解析", () => {
  it("历史第三方 CLI provider 归一到 glm，不让整份状态文件解析失败", () => {
    for (const provider of ["codex", "claude", "opencode", "gemini", "glm"]) {
      expect(botDraftOptionsSchema.parse({ provider }).provider).toBe("glm");
      expect(botCurrentOptionsSchema.parse({ cli: provider }).cli).toBe("glm");
    }
  });

  it("未知 provider 仍按损坏数据拒绝", () => {
    expect(() => botDraftOptionsSchema.parse({ provider: "unknown" })).toThrow();
    expect(() => botCurrentOptionsSchema.parse({ cli: "unknown" })).toThrow();
  });
});
