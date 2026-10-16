// 中枢发往对话的三段文案（docs/dynamic-workflow/launch.md「Create and revise in chat」）。
import { describe, expect, it } from "vitest";
import {
  buildSavedWorkflowCreatePrompt,
  buildSavedWorkflowPromotePrompt,
  buildSavedWorkflowRevisePrompt,
} from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";

describe("revise / create prompts", () => {
  it("修订文案带名字与路径，且以冒号结尾等用户接着写", () => {
    expect(
      buildSavedWorkflowRevisePrompt({
        name: "x",
        path: "/repo/.zcode/workflows/x.dwf.ts",
        locale: "zh-CN",
      }),
    ).toBe("请修订已保存的工作流「x」（/repo/.zcode/workflows/x.dwf.ts）：");
    expect(buildSavedWorkflowRevisePrompt({ name: "x", path: "/p", locale: "en-US" })).toBe(
      'Please revise the saved workflow "x" (/p): ',
    );
  });

  it("全局档修订追加「保持 scope: global」；项目档不加", () => {
    const zh = buildSavedWorkflowRevisePrompt({
      name: "x",
      path: "/p",
      locale: "zh-CN",
      scope: "global",
    });
    expect(zh).toContain('它是全局工作流，保存时保持 scope: "global"。');
    const en = buildSavedWorkflowRevisePrompt({
      name: "x",
      path: "/p",
      locale: "en-US",
      scope: "global",
    });
    expect(en).toContain('keep scope: "global" when saving');
    // 项目档逐字不变。
    expect(
      buildSavedWorkflowRevisePrompt({ name: "x", path: "/p", locale: "zh-CN", scope: "project" }),
    ).toBe(buildSavedWorkflowRevisePrompt({ name: "x", path: "/p", locale: "zh-CN" }));
  });

  it("创建文案双语", () => {
    expect(buildSavedWorkflowCreatePrompt("zh-CN")).toContain("保存到本项目");
    expect(buildSavedWorkflowCreatePrompt("en-US")).toContain("save it to this project");
  });

  it("全局档创建文案说保存为全局工作流；项目档缺省不变", () => {
    expect(buildSavedWorkflowCreatePrompt("zh-CN", "global")).toContain(
      '保存为全局工作流（scope: "global"）',
    );
    expect(buildSavedWorkflowCreatePrompt("en-US", "global")).toContain(
      'save it as a global workflow (scope: "global")',
    );
    expect(buildSavedWorkflowCreatePrompt("zh-CN", "project")).toBe(
      buildSavedWorkflowCreatePrompt("zh-CN"),
    );
  });
});

// 「提升为全局」（docs/dynamic-workflow/launch.md「Promote to global」）：自动发送的完整指令。
describe("promote prompt", () => {
  const input = { name: "release-check", path: "/repo/.zcode/workflows/release-check.dwf.ts" };

  it("中文：带名字与路径、要求 scope global、允许改名、不动原文件、可拒绝", () => {
    const zh = buildSavedWorkflowPromotePrompt({ ...input, locale: "zh-CN" });
    expect(zh).toContain("「release-check」（/repo/.zcode/workflows/release-check.dwf.ts）");
    expect(zh).toContain('scope: "global"');
    expect(zh).toContain("`args`");
    expect(zh).toContain("名字可以沿用，也可以取一个更贴切的名字");
    expect(zh).toContain("不要改动原来的项目工作流文件");
    expect(zh).toContain("说明原因并停下，不要保存");
    // 不内嵌脚本：模型自己读文件。
    expect(zh).not.toContain("export default");
  });

  it("英文：同一清单", () => {
    const en = buildSavedWorkflowPromotePrompt({ ...input, locale: "en-US" });
    expect(en).toContain('"release-check" (/repo/.zcode/workflows/release-check.dwf.ts)');
    expect(en).toContain('scope: "global"');
    expect(en).toContain("Keep the name or pick a better one");
    expect(en).toContain("Do not modify the original project workflow file");
    expect(en).toContain("stop without saving");
  });
});
