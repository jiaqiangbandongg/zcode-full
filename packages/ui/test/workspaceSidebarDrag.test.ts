import { readSourceText } from "./readSourceText.js";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  resolveWorkspaceDragGlobalIndices,
  resolveWorkspaceDragExpanded,
  resolveWorkspaceDragSiblingDisplacement,
  workspaceVerticalListSortingStrategy,
} from "@/lib/workspaceSidebarDrag.js";

function tab(id: string, purpose?: "conversation"): WorkspaceTabState {
  return {
    id,
    kind: "workspace",
    label: id,
    workspacePath: `/${id}`,
    ...(purpose ? { workspacePurpose: purpose } : {}),
  };
}

describe("workspace sidebar drag", () => {
  it("moves siblings by the collapsed row height instead of expanded height", () => {
    expect(
      resolveWorkspaceDragSiblingDisplacement({
        activeIndex: 1,
        index: 0,
        itemGap: 8,
        overIndex: 0,
      }),
    ).toBe(40);
    expect(
      resolveWorkspaceDragSiblingDisplacement({
        activeIndex: 0,
        index: 1,
        itemGap: 8,
        overIndex: 1,
      }),
    ).toBe(-40);

    const transform = workspaceVerticalListSortingStrategy({
      activeIndex: 1,
      activeNodeRect: null,
      index: 0,
      overIndex: 0,
      rects: [
        { top: 280, bottom: 508, left: 8, right: 337, width: 329, height: 228 },
        { top: 516, bottom: 744, left: 8, right: 337, width: 329, height: 228 },
      ],
    });
    expect(transform).toMatchObject({ y: 40, scaleX: 1, scaleY: 1 });
  });

  it("uses the requested workspace preview sizing", () => {
    const workspaceSource = readSourceText(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebar.tsx"),
      "utf8",
    );
    const workspacePreviewSizing =
      "h-8 px-2.5 gap-2 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0";

    expect(workspaceSource).toContain("border-border bg-background");
    expect(workspaceSource).toContain("text-ui-base text-foreground shadow-lg");
    expect(workspaceSource).toContain("cursor-grabbing");
    expect(workspaceSource).toContain(workspacePreviewSizing);
  });

  it("keeps native workbench dragging enabled inside project rows", () => {
    const workspaceItemSource = readSourceText(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarItem.tsx"),
      "utf8",
    );
    const taskListItemSource = readSourceText(
      resolve(process.cwd(), "packages/ui/src/TaskListItem.tsx"),
      "utf8",
    );

    expect(workspaceItemSource).not.toContain("allowWorkbenchDrag");
    expect(taskListItemSource).not.toContain("allowWorkbenchDrag");
    expect(taskListItemSource).toContain(
      "const canDragToWorkbench =\n    !workspaceActionsDisabled",
    );
  });

  it("temporarily collapses only the expanded active workspace", () => {
    expect(
      resolveWorkspaceDragExpanded({
        activeDragId: "a",
        expanded: true,
        tabId: "a",
      }),
    ).toBe(false);
    expect(
      resolveWorkspaceDragExpanded({
        activeDragId: "a",
        expanded: true,
        tabId: "b",
      }),
    ).toBe(true);
    expect(
      resolveWorkspaceDragExpanded({
        activeDragId: "a",
        expanded: false,
        tabId: "a",
      }),
    ).toBe(false);
  });

  it("maps visible project order back to global workspace indices", () => {
    const conversation = tab("conversation", "conversation");
    const projectA = tab("a");
    const projectB = tab("b");
    expect(
      resolveWorkspaceDragGlobalIndices({
        activeId: "b",
        overId: "a",
        projectTabs: [projectA, projectB],
        workspaceTabs: [conversation, projectA, projectB],
      }),
    ).toEqual({ fromIndex: 2, toIndex: 1 });
  });
});
