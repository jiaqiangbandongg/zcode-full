import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("settings form actions", () => {
  // 各资源页的头部 New 按钮已统一由 SettingsResourceHeaderActions 渲染，尺寸约束随之
  // 移到该共享组件；这里改为在真实位置断言尺寸，并确认子智能体页确实走同一组件。
  it("列表头部 New 按钮统一由共享组件渲染", () => {
    const actions = readSource("src/settings/SettingsResourceHeaderActions.tsx");
    expect(actions).toMatch(
      /size="default"\s+className="rounded-lg"\s+data-settings-create-action=\{newActionId\}\s+aria-label=\{newLabel\}/,
    );
    expect(readSource("src/settings/SubagentsSection.tsx")).toContain(
      "<SettingsResourceHeaderActions",
    );
  });

  it.each([
    "McpServerForm.tsx",
    "CommandForm.tsx",
    "HookForm.tsx",
    "SubagentsSection.tsx",
  ])("统一 %s 的删除、保存、取消布局", (file) => {
    const source = readSource(`src/settings/${file}`);
    expect(source).toContain("<SettingsFormActions");
    expect(source.lastIndexOf('id: "common.cancel"')).toBeGreaterThan(
      source.lastIndexOf('id: "common.save"'),
    );
  });

  // Bugfix 回归：CommandForm 曾因迁移 SettingsFormActions 后又插入一个按钮而渲染两个
  // 完全相同的保存按钮；只断言顺序无法发现重复，必须断言数量。
  it.each([
    "McpServerForm.tsx",
    "CommandForm.tsx",
    "HookForm.tsx",
    "SubagentsSection.tsx",
  ])("%s 只渲染一个保存按钮", (file) => {
    const source = readSource(`src/settings/${file}`);
    expect(source.split('id: "common.save"').length - 1).toBe(1);
  });

  it("新建和编辑 MCP 都使用保存文案", () => {
    const source = readSource("src/settings/McpServerForm.tsx");
    expect(source).toContain('id: "common.save"');
    expect(source).not.toContain('id: "settings.mcp.form.add"');
  });

  it("操作栏始终把取消与保存放到右侧", () => {
    const source = readSource("src/settings/SettingsFormActions.tsx");
    expect(source).toContain("sm:ml-auto");
    expect(source).toContain("justify-end");
  });

  it.each([
    "McpServerForm.tsx",
    "CommandForm.tsx",
    "HookForm.tsx",
    "SubagentsSection.tsx",
  ])("统一 %s 的保存可用状态", (file) => {
    const source = readSource(`src/settings/${file}`);
    expect(source).toContain("const canSave =");
    expect(source).toMatch(/disabled=\{[^}]*!canSave/);
  });

  it("子智能体的保存判定属于编辑表单", () => {
    const source = readSource("src/settings/SubagentsSection.tsx");
    const formSource = source.slice(source.indexOf("function SubagentForm("));
    expect(formSource).toContain("const canSave =");
    expect(formSource).toContain("disabled={!canSave || saving}");
  });
});
