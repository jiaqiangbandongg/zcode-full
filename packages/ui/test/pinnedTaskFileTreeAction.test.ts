import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const taskListItemSource = readFileSync(
  new URL("../src/TaskListItem.tsx", import.meta.url),
  "utf8",
);
const groupedTaskActionSource = readFileSync(
  new URL("../src/workspace-grouped-tasks/task-row-action-button.tsx", import.meta.url),
  "utf8",
);
const groupedTaskRowSource = readFileSync(
  new URL("../src/workspace-grouped-tasks/task-row.tsx", import.meta.url),
  "utf8",
);
const workspaceSidebarItemSource = readFileSync(
  new URL("../src/WorkspaceSidebarItem.tsx", import.meta.url),
  "utf8",
);

describe("pinned task file tree action", () => {
  it("复用 grouped task action，保持 hover 和 tooltip 一致", () => {
    expect(taskListItemSource).toContain(
      'import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";',
    );
    expect(taskListItemSource).toMatch(
      /<TaskRowActionButton[\s\S]*?id: "git\.action\.showTree"[\s\S]*?<ListTree/,
    );
    expect(taskListItemSource).not.toContain(
      'className="hidden shrink-0 text-foreground hover:bg-background/90 hover:text-foreground group-hover/task-item:inline-flex"',
    );
  });

  it("Pinned、Grouped、Project 的文件树 tooltip 都显示在按钮上方", () => {
    expect(groupedTaskActionSource).toContain('side="top"');
    expect(taskListItemSource).toMatch(
      /<TaskRowActionButton[\s\S]*?id: "git\.action\.showTree"[\s\S]*?showTooltip[\s\S]*?<ListTree/,
    );
    expect(workspaceSidebarItemSource).toContain(
      'import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";',
    );
    expect(workspaceSidebarItemSource).toMatch(
      /showFileTreeAction[\s\S]*?<TaskRowActionButton[\s\S]*?workspaceSidebar\.showFileTree[\s\S]*?showTooltip/,
    );
  });

  it("Project 文件树入口与两侧按钮使用相同的默认和 hover 文字颜色", () => {
    expect(workspaceSidebarItemSource).toMatch(
      /showFileTreeAction[\s\S]*?<TaskRowActionButton[\s\S]*?className="text-foreground-subtle hover:text-foreground"[\s\S]*?workspaceSidebar\.showFileTree/,
    );
  });

  it("Project task 的普通归档和文件树复用相同 hover action", () => {
    expect(taskListItemSource).toMatch(
      /isArchiveConfirming \? \([\s\S]*?variant="destructive"[\s\S]*?\) : \([\s\S]*?<TaskRowActionButton[\s\S]*?archiveLabel[\s\S]*?showTooltip/,
    );
  });

  it("Pinned task actions 使用和 Grouped 相同的紧凑间距", () => {
    expect(taskListItemSource).toContain('className="flex shrink-0 items-center gap-0.5"');
    expect(taskListItemSource).toMatch(
      /taskActionGroupNode[\s\S]*?fileTreeActionNode[\s\S]*?archiveActionNode/,
    );
  });

  it("远端 session 未就绪时不展示 Pinned 或 Grouped 文件树入口", () => {
    expect(taskListItemSource).toMatch(
      /const canOpenFileTree =[\s\S]*?!task\.workspaceIdentity\?\.trim\(\)[\s\S]*?remoteSessionId[\s\S]*?const fileTreeActionNode/,
    );
    expect(groupedTaskRowSource).toMatch(
      /const canOpenFileTree =[\s\S]*?!task\.workspaceIdentity\?\.trim\(\)[\s\S]*?remoteSessionId[\s\S]*?\{canOpenFileTree \? \(/,
    );
  });

  it("Workspaces task actions 由统一交互状态挂载", () => {
    expect(taskListItemSource).toContain("shouldMountWorkspaceTaskActions");
    expect(taskListItemSource).toContain("onFocusCapture");
    expect(taskListItemSource).toContain("isHoverNone");
    expect(taskListItemSource).not.toContain("group-hover/task-item:flex");
    expect(taskListItemSource).not.toContain("group-hover/task-item:inline-flex");
    expect(taskListItemSource).not.toContain("group-focus-within/task-item:inline-flex");
    expect(taskListItemSource).toMatch(/<li[\s\S]*?tabIndex=\{0\}/);
  });

  it("pin 和 unpin action 始终使用按钮上方 tooltip", () => {
    expect(taskListItemSource).toMatch(
      /<ControlHintTooltip[\s\S]*?taskList\.unpin[\s\S]*?taskList\.pin[\s\S]*?side="top"[\s\S]*?\{pinActionButton\}/,
    );
  });

  it("Workspace row actions 由交互状态挂载，并保留打开中的 More 菜单", () => {
    expect(workspaceSidebarItemSource).toContain("shouldMountWorkspaceRowActions");
    expect(workspaceSidebarItemSource).toContain("workspaceActionMenuOpen");
    expect(workspaceSidebarItemSource).toContain("onFocusCapture");
    expect(workspaceSidebarItemSource).toMatch(
      /<ControlHintTooltip[\s\S]*?common\.more[\s\S]*?<DropdownMenuTrigger asChild>/,
    );
    expect(workspaceSidebarItemSource).not.toContain("group-hover:opacity-100");
  });

  it("Grouped actions 由 row 交互状态挂载，不再依赖 CSS hover 显示", () => {
    expect(groupedTaskRowSource).toContain("shouldMountHoverActions");
    expect(groupedTaskRowSource).toContain("onMouseEnter");
    expect(groupedTaskRowSource).toContain("onFocusCapture");
    expect(groupedTaskRowSource).toContain("isHoverNone");
    expect(groupedTaskRowSource).not.toContain("group-hover/task-row:flex");
    expect(groupedTaskRowSource).not.toContain("group-focus-within/task-row:flex");
  });

  it("触屏 action 挂载条件不再用于隐藏 task 元信息", () => {
    expect(groupedTaskRowSource).toContain("shouldSuppressTaskMetadata");
    expect(groupedTaskRowSource).toMatch(
      /shouldSuppressTaskMetadata\s*=\s*taskRowHovered\s*\|\|\s*taskRowFocusWithin/,
    );
    expect(workspaceSidebarItemSource).not.toContain("shouldSuppressTaskMetadata");
  });
});
