import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("file path action surfaces", () => {
  it.each([
    "packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowView.tsx",
    "packages/ui/src/PreviewPane.tsx",
    "packages/ui/src/OpenSplitButton.tsx",
    "packages/ui/src/components/ai-elements/message.tsx",
    "packages/ui/src/GitPaneChangeCard.tsx",
  ])("%s 同时提供绝对路径和相对路径复制入口", (path) => {
    const source = readSource(path);

    expect(source).toContain("copyAbsolutePath");
    expect(source).toContain("copyRelativePath");
  });

  it("文件树远程文件打开不再被统一禁用，并传递文件类型和远程目标", () => {
    const source = readSource("packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowView.tsx");

    expect(source).not.toMatch(/isRemoteWorkspaceFileTree\s*\|\|\s*installedEditors/u);
    expect(source).toContain('pathKind: isDirectory ? "directory" : "file"');
    expect(source).toContain("remoteTarget");
  });

  it("WSL 文件树的资源管理器入口复用打开方式中的 Explorer", () => {
    const rowSource = readSource(
      "packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowView.tsx",
    );
    const treeSource = readSource(
      "packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx",
    );

    expect(rowSource).toContain("resolveWorkspaceFileManagerEditor");
    expect(rowSource).toContain("await handleOpenInEditor(wslFileManagerEditor)");
    expect(treeSource).toContain("resolveWorkspaceFileManagerEditor");
    expect(treeSource).toContain('pathKind: "directory"');
  });

  it("Git 变更为绝对路径时仍从工作区根计算相对路径", () => {
    const source = readSource("packages/ui/src/GitPane.tsx");

    expect(source).toContain(
      "getWorkspaceFileRelativePath(workspacePath, resolveChangePath(change))",
    );
  });

  it("Git 审查区仅为精确匹配的 WSL target 开放 Explorer", () => {
    const paneSource = readSource("packages/ui/src/GitPane.tsx");
    const actionSource = readSource(
      "packages/ui/src/hooks/useFileContextActions.ts",
    );

    expect(paneSource).toContain("useWorkspaceOpenInEditorTarget");
    expect(paneSource).toContain("workspaceIdentity");
    expect(actionSource).toContain('remoteTarget?.kind === "wsl"');
    expect(actionSource).toContain('platform.openInEditor("explorer", openPath');
    expect(actionSource).toContain('pathKind: "directory"');
  });

  it("任务右键透传 workspace identity，避免同路径远程目标串线", () => {
    const source = readSource("packages/ui/src/TaskListItem.tsx");

    expect(source).toContain("workspaceIdentity: task.workspaceIdentity");
  });

  it("同一路径匹配多个远程工作区时保持远程失败关闭", () => {
    const source = readSource(
      "packages/ui/src/hooks/useWorkspaceOpenInEditorTarget.ts",
    );

    expect(source).toContain("matches.some");
    expect(source).toContain("isRemoteWorkspace: hasRemoteMatch");
  });
});
