import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sourceUrl = (name: string) =>
  new URL(`../src/workspace-file-tree/${name}`, import.meta.url);

describe("workspace file tree sticky layout", () => {
  it("renders all sticky folders in one zero-height list container", async () => {
    const [treeSource, stickySource, rowSource] = await Promise.all([
      readFile(sourceUrl("WorkspaceFileTree.tsx"), "utf8"),
      readFile(sourceUrl("WorkspaceFileTreeStickyFolders.tsx"), "utf8"),
      readFile(sourceUrl("WorkspaceFileTreeRowView.tsx"), "utf8"),
    ]);

    expect(stickySource).toContain(
      'className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible px-1"',
    );
    expect(stickySource).toContain(
      'className="pointer-events-auto overflow-hidden rounded-lg"',
    );
    expect(stickySource).not.toContain("bg-sidebar");
    expect(stickySource).toContain('layout="static"');
    expect(rowSource).toContain('layout?: "absolute" | "static"');
    expect(rowSource).not.toContain('layout === "sticky"');
    expect(rowSource).toContain(
      'className="pointer-events-none absolute -inset-y-px left-2.5"',
    );
    expect(rowSource).not.toContain("-inset-y-0.5");

    const scrollContents = treeSource.slice(
      treeSource.indexOf("ref={scrollRef}"),
    );
    expect(
      scrollContents.indexOf("<WorkspaceFileTreeStickyFolders"),
    ).toBeLessThan(scrollContents.indexOf("<WorkspaceFileTreeList"));
  });

  it("does not migrate sticky rows or rewrite the scroll offset", async () => {
    const [treeSource, hookSource, listSource] = await Promise.all([
      readFile(sourceUrl("WorkspaceFileTree.tsx"), "utf8"),
      readFile(sourceUrl("useWorkspaceFileTreeStickyFolders.ts"), "utf8"),
      readFile(sourceUrl("WorkspaceFileTreeList.tsx"), "utf8"),
    ]);

    expect(hookSource).not.toContain("onScrollToOffset");
    expect(hookSource).not.toContain("useLayoutEffect");
    expect(treeSource).not.toContain("onScrollToOffset");
    expect(listSource).not.toContain('layout: "sticky"');
  });

  it("updates the list mask directly from the native scroll event", async () => {
    const [treeSource, listSource] = await Promise.all([
      readFile(sourceUrl("WorkspaceFileTree.tsx"), "utf8"),
      readFile(sourceUrl("WorkspaceFileTreeList.tsx"), "utf8"),
    ]);

    expect(treeSource).toContain(".style.setProperty(");
    expect(treeSource).toContain("WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY");
    expect(treeSource).toContain("`${scrollNode.scrollTop}px`");
    expect(listSource).toContain(
      "const maskPosition = `0 var(${WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY})`",
    );
  });
});
