import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSidebarTaskGroupTogglePresentation } from "@/WorkspaceSidebar/taskGroupTogglePresentation.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

function readWorkspaceSidebarSource(): string {
  return readFileSync(resolve(process.cwd(), "packages/ui/src/WorkspaceSidebar.tsx"), "utf8");
}

describe("WorkspaceSidebar task view switcher", () => {
  it("renders grouped before project while keeping project as the fallback default", () => {
    const source = readWorkspaceSidebarSource();
    const groupedTriggerIndex = source.indexOf('value="grouped"');
    const workspaceTriggerIndex = source.indexOf('value="workspace"');

    expect(groupedTriggerIndex).toBeGreaterThan(-1);
    expect(workspaceTriggerIndex).toBeGreaterThan(-1);
    expect(groupedTriggerIndex).toBeLessThan(workspaceTriggerIndex);
    expect(source).toMatch(
      /const activePrimaryTaskMode: PrimaryTaskMode =\s*!isWebRemoteControlSidebar && taskOrganizeBy === "grouped"\s*\? "grouped"\s*: "workspace";/,
    );
  });

  it("keeps the pill shell at h-7 in the active horizontal tabs state", () => {
    const source = readWorkspaceSidebarSource();

    expect(source).toContain(
      "relative h-7 w-fit overflow-hidden rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-7",
    );
  });

  it("keeps pinned tasks visible above the grouped task body", () => {
    const source = readWorkspaceSidebarSource();
    const pinnedVisibilityStart = source.indexOf("const shouldShowPinnedTasks");
    const pinnedVisibilityEnd = source.indexOf("const workspaceScrollRef", pinnedVisibilityStart);
    const pinnedSectionIndex = source.indexOf("<WorkspacePinnedTasksSection");
    const groupedSectionIndex = source.indexOf("<WorkspaceGroupedTasksSection");

    expect(pinnedVisibilityStart).toBeGreaterThan(-1);
    expect(pinnedVisibilityEnd).toBeGreaterThan(pinnedVisibilityStart);
    expect(source.slice(pinnedVisibilityStart, pinnedVisibilityEnd)).toContain(
      'taskViewMode === "grouped"',
    );
    expect(pinnedSectionIndex).toBeGreaterThan(-1);
    expect(groupedSectionIndex).toBeGreaterThan(pinnedSectionIndex);
  });

  it("keeps the previous expand-all button presentation while the next task view hydrates", () => {
    const previousPresentation = {
      canToggle: true,
      areAllExpanded: true,
      messageId: "workspaceSidebar.collapseAllGroups" as const,
    };

    const presentation = resolveSidebarTaskGroupTogglePresentation({
      previous: previousPresentation,
      current: {
        visible: true,
        canToggle: false,
        areAllExpanded: false,
        transitionPending: true,
      },
    });

    expect(presentation).toEqual(previousPresentation);
  });

  it("uses the current expand-all button presentation after the task view hydrates", () => {
    const presentation = resolveSidebarTaskGroupTogglePresentation({
      previous: {
        canToggle: true,
        areAllExpanded: true,
        messageId: "workspaceSidebar.collapseAllGroups",
      },
      current: {
        visible: true,
        canToggle: false,
        areAllExpanded: false,
        transitionPending: false,
      },
    });

    expect(presentation).toEqual({
      canToggle: false,
      areAllExpanded: false,
      messageId: "workspaceSidebar.expandAllGroups",
    });
  });

  it("guards grouped collapsed preferences from transient empty hydration snapshots", () => {
    const source = readWorkspaceSidebarSource();

    expect(source).toContain("nextGroupIds.length === 0");
    expect(source).toContain("!groupedTaskGroupIdsHydrated");
    expect(source).toContain("lastNonEmptyGroupedTaskGroupIds.length > 0");
    expect(source).toContain("collapsedGroupedTaskGroupIds.size > 0");
    expect(source).toContain("重启后首进 Group");
    expect(source).toContain("不能当成“所有 group 已删除”");
  });

  it("Idle-time 收敛后由 grouped 树承载，侧栏不再独立渲染系统分组（D48-A）", () => {
    const source = readWorkspaceSidebarSource();

    expect(source).not.toContain("OffPeakSidebarGroup");
    expect(source).not.toContain("data-workspace-grouped-system-stack");
    // 闲时组头「+」路由到 Automations：Section 通过该 prop 拿到入口。
    expect(source).toContain("onOpenAutomations={handleOpenAutomationsMain}");
    expect(source).toContain("onClick={handleOpenPluginStoreMain}");
    expect(source).not.toContain("handleOpenPluginsSettings");
  });

  it("project view separates task-purpose rows and renders sections from persisted order", () => {
    const source = readWorkspaceSidebarSource();
    const projectSectionIndex = source.indexOf('id: "workspaceSidebar.projectsSection"');
    const conversationSectionIndex = source.indexOf('id: "workspaceSidebar.conversationsSection"');

    expect(source).toContain("partitionWorkspaceTabsByPurpose(workspaceTabs)");
    expect(projectSectionIndex).toBeGreaterThan(-1);
    expect(conversationSectionIndex).toBeGreaterThan(-1);
    expect(source).toContain("purposeSectionPreferences.sectionOrder.map(");
    expect(source).toContain("items={purposeSectionPreferences.sectionOrder}");
    expect(source).toContain("handlePurposeSectionDragEnd");
    expect(source).toContain("sortableKeyboardCoordinates");
    expect(source).toContain("workspaceTabs={conversationWorkspaceTabs}");
    expect(source).toContain("groupByDate={false}");
    expect(source).toContain('taskRowVariant="default"');
    expect(source).toContain("projectWorkspaceTabs.map((tab)");
    expect(source).not.toContain("workspaceTabs.length === 0 ? (");
  });

  it("conversation and project section actions use dedicated callbacks", () => {
    const source = readWorkspaceSidebarSource();

    expect(source).toContain("onCreateConversationTask");
    expect(source).toContain("onOpenFolderFromWorkspaceMenu");
    expect(source).toContain("onOpenRemoteWorkspace");
  });

  it("labels the conversation-purpose section as tasks in both shipped locales", () => {
    expect(enUS["workspaceSidebar.conversationsSection"]).toBe("Tasks");
    expect(enUS["workspaceSidebar.newConversation"]).toBe("New task");
    expect(enUS["workspaceSidebar.noConversations"]).toBe("No tasks yet");
    expect(zhCN["workspaceSidebar.conversationsSection"]).toBe("任务");
    expect(zhCN["workspaceSidebar.newConversation"]).toBe("新建任务");
    expect(zhCN["workspaceSidebar.noConversations"]).toBe("还没有任务");
  });

  it("persists independent purpose sections and includes projects in expand-all", () => {
    const source = readWorkspaceSidebarSource();

    expect(source).toContain("readSidebarPurposeSectionPreferences");
    expect(source).toContain("handleProjectSectionOpenChange");
    expect(source).toContain("handleConversationSectionOpenChange");
    expect(source).toContain("reorderSidebarPurposeSections");
    expect(source).toContain("purposeSectionPreferences.projectsExpanded &&");
    expect(source).toContain("areAllWorkspaceGroupsExpanded");
    expect(source).toContain("handleProjectSectionOpenChange(false)");
    expect(source).toContain("handleProjectSectionOpenChange(true)");
  });
});
