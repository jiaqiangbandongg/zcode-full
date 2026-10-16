import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("new task draft header action layout", () => {
  it("reuses WorkspaceHeader with the draft variant instead of a second lightweight header", () => {
    const layoutSource = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
    const headerSource = readSource("packages/ui/src/WorkspaceHeader.tsx");

    expect(layoutSource).toContain('variant={activeTaskId === null ? "draft" : "task"}');
    expect(layoutSource).toContain("draftDropTargetController={");
    expect(layoutSource).not.toContain("shouldRenderDraftHeader");
    expect(layoutSource).not.toContain("shouldRenderDraftCaptionMenu");
    expect(layoutSource).not.toContain("WorkspaceHelpMenuButton");
    expect(layoutSource).not.toContain("WorkspaceTerminalToggleButton");
    expect(layoutSource).not.toContain("WorkspaceSidePaneToggleButton");
    expect(headerSource).toContain("data-workspace-header-variant={variant}");
    expect(headerSource).toContain('data-testid="new-task-draft-drop-mask"');
    // 草稿分隔线已改为始终透明，旧源码断言误报且导致 Windows 被跳过；样式由 workspaceHeader.test.ts 的渲染测试覆盖。
    expect(headerSource).toContain('variant === "task" ? (');
  });

  it("reuses the same side pane toggle in full and draft headers", () => {
    const actionSource = readSource(
      "packages/ui/src/WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx",
    );
    const toggleSource = readSource("packages/ui/src/WorkspaceSidePaneToggleButton.tsx");

    expect(actionSource).toContain("WorkspaceSidePaneToggleButton");
    expect(actionSource).not.toContain("PanelRightClose");
    expect(actionSource).not.toContain("PanelRightOpen");
    expect(toggleSource).toContain("TID_SIDE_PANE_TOGGLE");
    expect(toggleSource).toContain('id: isSidePaneOpen ? "sidePane.collapse" : "sidePane.expand"');
  });
});
