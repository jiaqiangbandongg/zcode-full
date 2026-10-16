// ============================================================
// 「历史里加载过某个技能吗」（agent/loaded-skills.ts）
// ============================================================
// 技能门的探针读的是 provider 可见历史：成功的 Skill 调用才算，只发出没结果、结果出错、别的技能
// 都不算；compaction 换掉历史后答案随之变回否。

import { describe, expect, it } from "vitest";
import { sessionHasLoadedSkill } from "../src/agent/loaded-skills.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";

const SKILL = "dynamic-workflows";

function historyWith(steps: (history: MessageHistoryImpl) => void): MessageHistoryImpl {
  const history = new MessageHistoryImpl();
  history.init("system");
  history.addUser("/workflow ship it");
  steps(history);
  return history;
}

describe("sessionHasLoadedSkill", () => {
  it("is true after a completed Skill call for that skill", () => {
    const history = historyWith((h) => {
      h.addAssistant("", [{ id: "call_1", name: "Skill", input: { skill: SKILL } }]);
      h.addToolResult(
        "call_1",
        "Skill",
        '<skill_content name="dynamic-workflows">…</skill_content>',
        true,
      );
    });
    expect(sessionHasLoadedSkill(history.borrowReadOnlyRuntimeEntries(), SKILL)).toBe(true);
  });

  it("accepts the legacy { name } input shape", () => {
    const history = historyWith((h) => {
      h.addAssistant("", [{ id: "call_1", name: "Skill", input: { name: SKILL } }]);
      h.addToolResult("call_1", "Skill", "ok", true);
    });
    expect(sessionHasLoadedSkill(history.borrowReadOnlyRuntimeEntries(), SKILL)).toBe(true);
  });

  it("is false while the call has no result, when the result is an error, or for another skill", () => {
    const pending = historyWith((h) => {
      h.addAssistant("", [{ id: "call_1", name: "Skill", input: { skill: SKILL } }]);
    });
    expect(sessionHasLoadedSkill(pending.borrowReadOnlyRuntimeEntries(), SKILL)).toBe(false);

    const failed = historyWith((h) => {
      h.addAssistant("", [{ id: "call_1", name: "Skill", input: { skill: SKILL } }]);
      h.addToolResult("call_1", "Skill", "Skill not found", false);
    });
    expect(sessionHasLoadedSkill(failed.borrowReadOnlyRuntimeEntries(), SKILL)).toBe(false);

    const other = historyWith((h) => {
      h.addAssistant("", [
        { id: "call_1", name: "Skill", input: { skill: "zcode-configuration-guide" } },
      ]);
      h.addToolResult("call_1", "Skill", "ok", true);
      h.addAssistant("", [{ id: "call_2", name: "Read", input: { file_path: "SKILL.md" } }]);
      h.addToolResult("call_2", "Read", "…", true);
    });
    expect(sessionHasLoadedSkill(other.borrowReadOnlyRuntimeEntries(), SKILL)).toBe(false);
  });

  it("forgets the load once compaction replaces the history", () => {
    const history = historyWith((h) => {
      h.addAssistant("", [{ id: "call_1", name: "Skill", input: { skill: SKILL } }]);
      h.addToolResult("call_1", "Skill", "ok", true);
    });
    expect(sessionHasLoadedSkill(history.borrowReadOnlyRuntimeEntries(), SKILL)).toBe(true);
    // compact-active 用摘要替换 provider 可见历史；技能正文随之离场，门要重新关上。
    history.replaceMessages([
      { role: "system", content: "system" },
      { role: "user", content: "[summary] the user asked for a workflow" },
    ]);
    expect(sessionHasLoadedSkill(history.borrowReadOnlyRuntimeEntries(), SKILL)).toBe(false);
  });
});
