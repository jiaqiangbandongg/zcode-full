import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// 共享焦点测试证明 Host 行为；此清单核对不可恢复的业务入口确实提交破坏性意图，
// 防止旧调用只写删除文案，却绕过取消默认焦点与键盘保护。
const destructiveEntries = [
  ["BotsDialog.tsx", "bots.deleteConfirmTitle"],
  ["project-sidebar/useArchiveManagement.ts", "archives.deleteTitle"],
  // V2 已移除刷新配对入口；无刷新按钮由 webRemoteControlDialogLayout 回归覆盖。
  ["settings/CommandsSection.tsx", "settings.commands.delete.title"],
  ["settings/AutomationsSection.tsx", "offPeak.delete.title"],
  [
    "settings/model-provider-section/modelProviderActions.ts",
    "settings.modelProvider.deleteConfirmTitle",
  ],
  ["onboarding/OnboardingDialog.tsx", "onboarding.agentsFile.confirmTitle"],
  ["settings/ShortcutSettingsSection.tsx", "settings.shortcuts.resetAllConfirmTitle"],
  ["settings/HooksSection.tsx", "settings.hooks.delete"],
  ["settings/SkillsSection.tsx", "settings.skills.delete.title"],
  ["settings/SubagentsSection.tsx", "settings.subagents.delete.title"],
  ["settings/McpSettingsSection.tsx", "settings.mcp.deleteConfirmTitle"],
] as const;

describe("全应用破坏性确认入口", () => {
  it.each(destructiveEntries)("%s 的 %s 声明不可恢复意图", async (path, titleId) => {
    const source = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const requests: ts.ObjectLiteralExpression[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        /(?:confirmDialog|requestConfirmation|confirm)$/.test(node.expression.getText(file))
      ) {
        const request = node.arguments[0];
        if (
          request &&
          ts.isObjectLiteralExpression(request) &&
          request.properties.some(
            (property) =>
              property.name?.getText(file) === "title" && property.getText(file).includes(titleId),
          )
        )
          requests.push(request);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    expect(requests).toHaveLength(1);
    const variant = requests[0]?.properties.find(
      (property) => property.name?.getText(file) === "confirmVariant",
    );
    expect(
      variant && ts.isPropertyAssignment(variant) && ts.isStringLiteral(variant.initializer)
        ? variant.initializer.text
        : undefined,
    ).toBe("destructive");
  });
});
