import { describe, expect, it } from "vitest";
import type { VirtualItem } from "@tanstack/react-virtual";
import type { IGitService } from "@zcode/services";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/workspace-file-tree/constants.js";
import { loadWorkspaceFileTreeGitStatus } from "@/workspace-file-tree/gitStatus.js";
import { sortInstalledEditorsForFileTree } from "@/workspace-file-tree/helpers.js";
import {
  addDeletedGitStatusRowsToWorkspaceFileTree,
  areWorkspaceFilePathsEqual,
  buildWorkspaceFileGitStatusByPath,
  buildWorkspaceFileIgnoredPathSet,
  createCodeViewerSourceForWorkspaceFile,
  filterWorkspaceFileTreeRows,
  flattenWorkspaceFileTreeRows,
  getWorkspaceDirectoryGitStatuses,
  getWorkspaceFileGitStatus,
  getWorkspaceFileAncestorDirectories,
  getWorkspaceFileDirectoryChildDepth,
  getWorkspaceFileParentDirectory,
  getWorkspaceFileRelativePath,
  isWorkspaceFileTreeGitStatusAvailable,
  isWorkspaceFileTreeDeletedFile,
  isWorkspaceFileGitIgnored,
  type WorkspaceFileTreeNode,
  type WorkspaceFileTreeRow,
  isWorkspaceFilePathInside,
} from "@/workspace-file-tree/model.js";
import {
  createWorkspaceFileTreeHtmlBrowserUrl,
  isWorkspaceFileTreeHtmlFile,
} from "@/workspace-file-tree/helpers.js";
import {
  getWorkspaceFileTreeBlockingRootError,
  getWorkspaceFileTreeDirectoryLoadDepth,
} from "@/workspace-file-tree/WorkspaceFileTree.js";
import {
  getWorkspaceFileGitStatusDotClassName,
  getWorkspaceFileGitStatusIndicatorClassName,
  getWorkspaceFileGitStatusTextClassName,
  getWorkspaceFileTreeRowDisplayGitStatus,
} from "@/workspace-file-tree/statusStyles.js";
import { getWorkspaceFileTreeStickyFolders } from "@/workspace-file-tree/useWorkspaceFileTreeStickyFolders.js";
import { getWorkspaceFileTreeListMaskStyle } from "@/workspace-file-tree/WorkspaceFileTreeList.js";
import {
  createWorkspaceFileTreeRowsFromSearchEntries,
  getWorkspaceFileSearchDirectoryRevealPaths,
} from "@/workspace-file-tree/searchRows.js";
import { getWorkspaceFileTreeRefreshDirectoryPaths } from "@/workspace-file-tree/refreshDirectories.js";
import { getWorkspaceFileTreeHierarchyGuideStyle } from "@/workspace-file-tree/hierarchyGuides.js";

function node(
  path: string,
  type: WorkspaceFileTreeNode["type"],
  depth: number,
): WorkspaceFileTreeNode {
  return {
    path,
    name: path.split("/").pop() ?? path,
    type,
    depth,
  };
}

function row(
  path: string,
  type: WorkspaceFileTreeNode["type"],
  depth: number,
  expanded = false,
): WorkspaceFileTreeRow {
  return {
    ...node(path, type, depth),
    expanded,
    loaded: true,
    loading: false,
    error: null,
  };
}

function virtualItem(index: number): VirtualItem {
  const start = index * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
  return {
    key: index,
    index,
    start,
    end: start + WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
    size: WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
    lane: 0,
  };
}

describe("workspace file tree helpers", () => {
  it("用物理路径计算 compact folder 后代的目录加载深度", () => {
    expect(
      getWorkspaceFileTreeDirectoryLoadDepth(
        "/workspace",
        "/workspace/docs/api/architecture/chat",
      ),
    ).toBe(4);
    expect(
      getWorkspaceFileTreeDirectoryLoadDepth(
        "C:\\workspace",
        "C:\\workspace\\docs\\api\\architecture\\chat",
      ),
    ).toBe(4);
  });

  it("只为嵌套文件树行生成按层级重复的竖向引导线", () => {
    expect(getWorkspaceFileTreeHierarchyGuideStyle(0)).toBeNull();
    expect(getWorkspaceFileTreeHierarchyGuideStyle(-1)).toBeNull();
    expect(getWorkspaceFileTreeHierarchyGuideStyle(1)).toEqual({
      width: "calc(1 * 0.75rem)",
      backgroundImage:
        "repeating-linear-gradient(to right, transparent 0 calc(0.375rem - 1px), var(--color-border) calc(0.375rem - 1px) 0.375rem, transparent 0.375rem 0.75rem)",
    });
    expect(getWorkspaceFileTreeHierarchyGuideStyle(3)).toEqual({
      width: "calc(3 * 0.75rem)",
      backgroundImage:
        "repeating-linear-gradient(to right, transparent 0 calc(0.375rem - 1px), var(--color-border) calc(0.375rem - 1px) 0.375rem, transparent 0.375rem 0.75rem)",
    });
  });

  it("keeps QSpace next to Finder in local open-with menus", () => {
    const iconDataUrl = "data:image/png;base64,AA==";

    expect(
      sortInstalledEditorsForFileTree([
        { id: "vscode", name: "VS Code", iconDataUrl },
        { id: "finder", name: "Finder", iconDataUrl },
        { id: "qspace", name: "QSpace", iconDataUrl },
        { id: "qspace-pro", name: "QSpace Pro", iconDataUrl },
        { id: "cursor", name: "Cursor", iconDataUrl },
      ]).map((editor) => editor.id),
    ).toEqual(["finder", "qspace", "qspace-pro", "vscode", "cursor"]);
  });

  it("only treats Git status as available inside a Git repository", () => {
    expect(
      isWorkspaceFileTreeGitStatusAvailable({
        isGitAvailable: true,
        isRepository: true,
      }),
    ).toBe(true);
    expect(
      isWorkspaceFileTreeGitStatusAvailable({
        isGitAvailable: true,
        isRepository: false,
      }),
    ).toBe(false);
    expect(
      isWorkspaceFileTreeGitStatusAvailable({
        isGitAvailable: false,
        isRepository: false,
      }),
    ).toBe(false);
  });

  it("loads an unavailable Git status state outside Git repositories", async () => {
    const gitService = {
      refresh: async () => ({
        summary: {
          workspacePath: "/workspace",
          repoRoot: "/workspace",
          workspaceInRepoPath: ".",
          autoRefreshWatchPaths: [],
          branchName: null,
          trackingBranchName: null,
          headRefType: "branch" as const,
          ahead: 0,
          behind: 0,
          isDirty: false,
          isGitAvailable: true,
          isRepository: false,
        },
        identity: null,
        unstagedChanges: [],
        stagedChanges: [],
        branchComparison: null,
      }),
    } as Pick<IGitService, "refresh"> as IGitService;

    await expect(
      loadWorkspaceFileTreeGitStatus({
        gitService,
        workspacePath: "/workspace",
      }),
    ).resolves.toEqual({
      available: false,
      statusByPath: new Map(),
    });
  });

  it("detects HTML files that can open in the built-in browser", () => {
    expect(
      isWorkspaceFileTreeHtmlFile(row("/workspace/index.html", "file", 0)),
    ).toBe(true);
    expect(
      isWorkspaceFileTreeHtmlFile(row("/workspace/preview.HTM", "file", 0)),
    ).toBe(true);
    expect(
      isWorkspaceFileTreeHtmlFile(row("/workspace/src", "directory", 0)),
    ).toBe(false);
    expect(
      isWorkspaceFileTreeHtmlFile(row("/workspace/readme.md", "file", 0)),
    ).toBe(false);
  });

  it("creates file URLs for HTML browser opening", () => {
    expect(
      createWorkspaceFileTreeHtmlBrowserUrl(
        row("/workspace/demo page.html", "file", 0),
      ),
    ).toBe("file:///workspace/demo%20page.html");
    expect(
      createWorkspaceFileTreeHtmlBrowserUrl(
        row("C:\\workspace\\index.html", "file", 0),
      ),
    ).toBe("file:///C:/workspace/index.html");
    expect(
      createWorkspaceFileTreeHtmlBrowserUrl(
        row("/workspace/index.ts", "file", 0),
      ),
    ).toBe(null);
  });

  it("flattens only visible expanded rows", () => {
    const childrenByDirectory = new Map<string, WorkspaceFileTreeNode[]>([
      [
        "/workspace",
        [
          node("/workspace/src", "directory", 0),
          node("/workspace/README.md", "file", 0),
        ],
      ],
      ["/workspace/src", [node("/workspace/src/index.ts", "file", 1)]],
    ]);

    expect(
      flattenWorkspaceFileTreeRows({
        rootPath: "/workspace",
        childrenByDirectory,
        expandedPaths: new Set(),
        loadedDirectoryPaths: new Set(["/workspace"]),
        loadingDirectoryPaths: new Set(),
        errorByDirectory: new Map(),
      }).map((row) => row.path),
    ).toEqual(["/workspace/src", "/workspace/README.md"]);

    expect(
      flattenWorkspaceFileTreeRows({
        rootPath: "/workspace",
        childrenByDirectory,
        expandedPaths: new Set(["/workspace/src"]),
        loadedDirectoryPaths: new Set(["/workspace", "/workspace/src"]),
        loadingDirectoryPaths: new Set(),
        errorByDirectory: new Map(),
      }).map((row) => row.path),
    ).toEqual([
      "/workspace/src",
      "/workspace/src/index.ts",
      "/workspace/README.md",
    ]);
  });

  it("刷新文件树会覆盖已加载和已展开的子目录", () => {
    const refreshPaths = getWorkspaceFileTreeRefreshDirectoryPaths({
      workspacePath: "/workspace",
      expandedPaths: new Set(["/workspace/src", "/workspace/src/app"]),
      loadedDirectoryPaths: new Set([
        "/workspace",
        "/workspace/src",
        "/workspace/docs",
        "/outside",
      ]),
    });

    expect(refreshPaths).toEqual([
      "/workspace",
      "/workspace/src",
      "/workspace/docs",
      "/workspace/src/app",
    ]);
  });

  it("根目录已有缓存时，刷新错误不会阻塞旧文件树渲染", () => {
    const error = new Error("remote host disconnected");

    expect(
      getWorkspaceFileTreeBlockingRootError({
        rootLoaded: true,
        rootError: error,
      }),
    ).toBeNull();
    expect(
      getWorkspaceFileTreeBlockingRootError({
        rootLoaded: false,
        rootError: error,
      }),
    ).toBe(error);
  });

  it("flattens loaded empty directory chains", () => {
    const childrenByDirectory = new Map<string, WorkspaceFileTreeNode[]>([
      ["/workspace", [node("/workspace/src", "directory", 0)]],
      ["/workspace/src", [node("/workspace/src/features", "directory", 1)]],
      [
        "/workspace/src/features",
        [node("/workspace/src/features/auth", "directory", 2)],
      ],
      [
        "/workspace/src/features/auth",
        [node("/workspace/src/features/auth/index.ts", "file", 3)],
      ],
    ]);

    const rows = flattenWorkspaceFileTreeRows({
      rootPath: "/workspace",
      childrenByDirectory,
      expandedPaths: new Set(["/workspace/src"]),
      loadedDirectoryPaths: new Set([
        "/workspace",
        "/workspace/src",
        "/workspace/src/features",
        "/workspace/src/features/auth",
      ]),
      loadingDirectoryPaths: new Set(),
      errorByDirectory: new Map(),
      flattenEmptyDirectories: true,
    });

    expect(
      rows.map((row) => ({ path: row.path, name: row.name, depth: row.depth })),
    ).toEqual([
      {
        path: "/workspace/src/features/auth",
        name: "src/features/auth",
        depth: 0,
      },
      {
        path: "/workspace/src/features/auth/index.ts",
        name: "index.ts",
        depth: 1,
      },
    ]);
    expect(rows[0]?.compactedPaths).toEqual([
      "/workspace/src",
      "/workspace/src/features",
      "/workspace/src/features/auth",
    ]);
  });

  it("does not flatten directories that contain files", () => {
    const childrenByDirectory = new Map<string, WorkspaceFileTreeNode[]>([
      ["/workspace", [node("/workspace/src", "directory", 0)]],
      [
        "/workspace/src",
        [
          node("/workspace/src/features", "directory", 1),
          node("/workspace/src/index.ts", "file", 1),
        ],
      ],
    ]);

    expect(
      flattenWorkspaceFileTreeRows({
        rootPath: "/workspace",
        childrenByDirectory,
        expandedPaths: new Set(["/workspace/src"]),
        loadedDirectoryPaths: new Set(["/workspace", "/workspace/src"]),
        loadingDirectoryPaths: new Set(),
        errorByDirectory: new Map(),
        flattenEmptyDirectories: true,
      }).map((row) => row.path),
    ).toEqual([
      "/workspace/src",
      "/workspace/src/features",
      "/workspace/src/index.ts",
    ]);
  });

  it("does not flatten through symlink directories", () => {
    const symlinkDirectory = {
      ...node("/workspace/src/linked-dir", "directory", 1),
      isSymbolicLink: true,
    } as WorkspaceFileTreeNode;
    const childrenByDirectory = new Map<string, WorkspaceFileTreeNode[]>([
      ["/workspace", [node("/workspace/src", "directory", 0)]],
      ["/workspace/src", [symlinkDirectory]],
      [
        "/workspace/src/linked-dir",
        [node("/workspace/src/linked-dir/index.ts", "file", 2)],
      ],
    ]);

    const rows = flattenWorkspaceFileTreeRows({
      rootPath: "/workspace",
      childrenByDirectory,
      expandedPaths: new Set(["/workspace/src"]),
      loadedDirectoryPaths: new Set([
        "/workspace",
        "/workspace/src",
        "/workspace/src/linked-dir",
      ]),
      loadingDirectoryPaths: new Set(),
      errorByDirectory: new Map(),
      flattenEmptyDirectories: true,
    });

    expect(
      rows.map((row) => ({
        path: row.path,
        name: row.name,
        compactedPaths: row.compactedPaths,
      })),
    ).toEqual([
      {
        path: "/workspace/src",
        name: "src",
        compactedPaths: undefined,
      },
      {
        path: "/workspace/src/linked-dir",
        name: "linked-dir",
        compactedPaths: undefined,
      },
    ]);
  });

  it("uses workspace-relative paths for local and Windows separators", () => {
    expect(
      getWorkspaceFileRelativePath("/workspace", "/workspace/src/index.ts"),
    ).toBe("src/index.ts");
    expect(
      getWorkspaceFileRelativePath("C:\\repo", "C:\\repo\\src\\index.ts"),
    ).toBe("src/index.ts");
  });

  it("builds ancestor directories for revealing active side pane files", () => {
    expect(
      getWorkspaceFileAncestorDirectories(
        "/workspace",
        "/workspace/src/app/index.tsx",
      ),
    ).toEqual(["/workspace/src", "/workspace/src/app"]);
    expect(
      getWorkspaceFileAncestorDirectories(
        "C:\\repo",
        "C:\\repo\\src\\app\\index.tsx",
      ),
    ).toEqual(["C:\\repo\\src", "C:\\repo\\src\\app"]);
    expect(
      getWorkspaceFileAncestorDirectories("/workspace", "/outside/index.ts"),
    ).toEqual([]);
  });

  it("resolves directory refresh depth and parents across separators", () => {
    expect(
      getWorkspaceFileDirectoryChildDepth("/workspace", "/workspace"),
    ).toBe(0);
    expect(
      getWorkspaceFileDirectoryChildDepth("/workspace", "/workspace/src"),
    ).toBe(1);
    expect(
      getWorkspaceFileDirectoryChildDepth("/workspace", "/workspace/src/app"),
    ).toBe(2);
    expect(
      getWorkspaceFileDirectoryChildDepth("C:\\repo", "C:\\repo\\src\\app"),
    ).toBe(2);

    expect(
      getWorkspaceFileParentDirectory("/workspace", "/workspace/src/app"),
    ).toBe("/workspace/src");
    expect(
      getWorkspaceFileParentDirectory("/workspace", "/workspace/src"),
    ).toBe("/workspace");
    expect(
      getWorkspaceFileParentDirectory("/workspace", "/workspace"),
    ).toBeNull();
    expect(
      getWorkspaceFileParentDirectory("C:\\repo", "C:\\repo\\src\\app"),
    ).toBe("C:\\repo\\src");
  });

  it("compares paths across Windows and POSIX separators", () => {
    expect(
      areWorkspaceFilePathsEqual(
        "C:\\repo\\src\\app.tsx",
        "C:/repo/src/app.tsx",
      ),
    ).toBe(true);
    expect(
      areWorkspaceFilePathsEqual("/repo/src/app.tsx", "/repo/src/other.tsx"),
    ).toBe(false);
  });

  it("detects paths inside a workspace across separators", () => {
    expect(
      isWorkspaceFilePathInside("/workspace", "/workspace/src/index.ts"),
    ).toBe(true);
    expect(isWorkspaceFilePathInside("C:\\repo", "C:/repo/src/index.ts")).toBe(
      true,
    );
    expect(
      isWorkspaceFilePathInside("/workspace", "/workspace-other/index.ts"),
    ).toBe(false);
  });

  it("opens raster images as image previews but keeps svg as file preview", () => {
    expect(
      createCodeViewerSourceForWorkspaceFile("/workspace/logo.png"),
    ).toEqual({
      type: "image",
      title: "logo.png",
      path: "/workspace/logo.png",
      mediaType: "image/png",
    });
    expect(
      createCodeViewerSourceForWorkspaceFile("/workspace/logo.svg"),
    ).toEqual({
      type: "file",
      title: "logo.svg",
      path: "/workspace/logo.svg",
    });
  });

  it("keeps pdf as file preview and relies on preview pane lazy upgrade", () => {
    // pdf 的类型升级收口在 PreviewPane 的 resolvePreviewPanePdfSource，
    // 文件树保持 file，让所有入口的 tab key 都是 file:{path}，避免同一文件开出两个 tab。
    expect(
      createCodeViewerSourceForWorkspaceFile("/workspace/report.pdf"),
    ).toEqual({
      type: "file",
      title: "report.pdf",
      path: "/workspace/report.pdf",
    });
  });

  it("maps Git changes to file tree status indicators", () => {
    const statusByPath = buildWorkspaceFileGitStatusByPath([
      {
        path: "/workspace/src/index.ts",
        section: "unstaged",
        isUntracked: false,
        kind: "modified",
      },
      {
        path: "/workspace/src/new.ts",
        section: "untracked",
        isUntracked: true,
        kind: "added",
      },
      {
        path: "C:\\repo\\src\\app.tsx",
        section: "staged",
        isUntracked: false,
        kind: "modified",
      },
      {
        path: "/workspace/src/staged-new.ts",
        section: "staged",
        isUntracked: false,
        kind: "added",
      },
      {
        path: "/workspace/src/removed.ts",
        section: "unstaged",
        isUntracked: false,
        kind: "deleted",
      },
      {
        path: "/workspace/src/moved.ts",
        section: "staged",
        isUntracked: false,
        kind: "renamed",
      },
    ]);

    expect(
      getWorkspaceFileGitStatus(statusByPath, "/workspace/src/index.ts"),
    ).toBe("modified");
    expect(
      getWorkspaceFileGitStatus(statusByPath, "/workspace/src/new.ts"),
    ).toBe("untracked");
    expect(getWorkspaceFileGitStatus(statusByPath, "C:/repo/src/app.tsx")).toBe(
      "modified",
    );
    expect(
      getWorkspaceFileGitStatus(statusByPath, "/workspace/src/staged-new.ts"),
    ).toBe("added");
    expect(
      getWorkspaceFileGitStatus(statusByPath, "/workspace/src/removed.ts"),
    ).toBe("deleted");
    expect(
      getWorkspaceFileGitStatus(statusByPath, "/workspace/src/moved.ts"),
    ).toBe("renamed");
    expect(
      getWorkspaceFileGitStatus(statusByPath, "/workspace/src/clean.ts"),
    ).toBeNull();
  });

  it("keeps the strongest Git status when staged and unstaged entries share a path", () => {
    const statusByPath = buildWorkspaceFileGitStatusByPath([
      {
        path: "/workspace/src/index.ts",
        section: "unstaged",
        isUntracked: false,
        kind: "modified",
      },
      {
        path: "/workspace/src/index.ts",
        section: "staged",
        isUntracked: false,
        kind: "added",
      },
    ]);

    expect(
      getWorkspaceFileGitStatus(statusByPath, "/workspace/src/index.ts"),
    ).toBe("added");
  });

  it("maps Git file tree statuses to dedicated color tokens", () => {
    expect(getWorkspaceFileGitStatusTextClassName("modified")).toBe(
      "text-git-modified",
    );
    expect(getWorkspaceFileGitStatusTextClassName("added")).toBe(
      "text-git-added",
    );
    expect(getWorkspaceFileGitStatusTextClassName("deleted")).toBe(
      "text-git-deleted",
    );
    expect(getWorkspaceFileGitStatusTextClassName("renamed")).toBe(
      "text-git-renamed",
    );
    expect(getWorkspaceFileGitStatusTextClassName("untracked")).toBe(
      "text-git-untracked",
    );
    expect(getWorkspaceFileGitStatusTextClassName("ignored")).toBe(
      "text-git-ignored",
    );
    expect(getWorkspaceFileGitStatusIndicatorClassName("untracked")).toBe(
      "text-git-untracked/70",
    );
    expect(getWorkspaceFileGitStatusDotClassName()).toBe(
      "bg-git-descendant/60",
    );
  });

  it("uses the resolved descendant priority for directory text color", () => {
    expect(
      getWorkspaceFileTreeRowDisplayGitStatus({
        gitStatus: null,
        directoryGitStatuses: ["modified", "untracked"],
      }),
    ).toBe("modified");
    expect(
      getWorkspaceFileTreeRowDisplayGitStatus({
        gitStatus: "deleted",
        directoryGitStatuses: ["modified", "untracked"],
      }),
    ).toBe("deleted");
  });

  it("treats deleted file tree rows as non-openable virtual files", () => {
    expect(
      isWorkspaceFileTreeDeletedFile(
        row("/workspace/src/removed.ts", "file", 1),
        "deleted",
      ),
    ).toBe(true);
    expect(
      isWorkspaceFileTreeDeletedFile(
        row("/workspace/src/index.ts", "file", 1),
        "modified",
      ),
    ).toBe(false);
    expect(
      isWorkspaceFileTreeDeletedFile(
        row("/workspace/src", "directory", 0),
        "deleted",
      ),
    ).toBe(false);
  });

  it("aggregates Git statuses for directories", () => {
    const statusByPath = buildWorkspaceFileGitStatusByPath([
      {
        path: "/workspace/src/index.ts",
        section: "unstaged",
        isUntracked: false,
        kind: "modified",
      },
      {
        path: "/workspace/src/new.ts",
        section: "untracked",
        isUntracked: true,
        kind: "added",
      },
      {
        path: "/workspace/src/deleted.ts",
        section: "staged",
        isUntracked: false,
        kind: "deleted",
      },
      {
        path: "/workspace/docs/readme.md",
        section: "unstaged",
        isUntracked: false,
        kind: "modified",
      },
    ]);

    expect(
      getWorkspaceDirectoryGitStatuses(statusByPath, "/workspace/src"),
    ).toEqual(["modified", "untracked", "deleted"]);
    expect(
      getWorkspaceDirectoryGitStatuses(statusByPath, "/workspace/docs"),
    ).toEqual(["modified"]);
    expect(
      getWorkspaceDirectoryGitStatuses(statusByPath, "/workspace/empty"),
    ).toEqual([]);
  });

  it("matches ignored paths across separators without treating them as changed descendants", () => {
    const ignoredPathSet = buildWorkspaceFileIgnoredPathSet([
      "C:\\repo\\dist\\bundle.js",
      "/workspace/build/output.txt",
    ]);

    expect(
      isWorkspaceFileGitIgnored(ignoredPathSet, "C:/repo/dist/bundle.js"),
    ).toBe(true);
    expect(
      isWorkspaceFileGitIgnored(ignoredPathSet, "/workspace/build/output.txt"),
    ).toBe(true);
    expect(
      isWorkspaceFileGitIgnored(ignoredPathSet, "/workspace/src/index.ts"),
    ).toBe(false);
  });

  it("adds deleted Git rows under loaded directories", () => {
    const childrenByDirectory = new Map<string, WorkspaceFileTreeNode[]>([
      ["/workspace", [node("/workspace/src", "directory", 0)]],
      ["/workspace/src", [node("/workspace/src/index.ts", "file", 1)]],
    ]);
    const statusByPath = new Map([
      ["/workspace/src/deleted.ts", "deleted" as const],
      ["/workspace/unloaded/deleted.ts", "deleted" as const],
    ]);

    const nextChildrenByDirectory = addDeletedGitStatusRowsToWorkspaceFileTree({
      rootPath: "/workspace",
      childrenByDirectory,
      statusByPath,
    });

    expect(
      nextChildrenByDirectory.get("/workspace/src")?.map((child) => child.path),
    ).toEqual(["/workspace/src/deleted.ts", "/workspace/src/index.ts"]);
    expect(nextChildrenByDirectory.get("/workspace/unloaded")).toBeUndefined();
    expect(
      childrenByDirectory.get("/workspace/src")?.map((child) => child.path),
    ).toEqual(["/workspace/src/index.ts"]);
  });

  it("creates flat file tree rows from workspace search entries", () => {
    const rows = createWorkspaceFileTreeRowsFromSearchEntries([
      {
        name: "UserProfileService.java",
        path: "/workspace/src/main/java/com/example/user/UserProfileService.java",
        relativePath: "src/main/java/com/example/user/UserProfileService.java",
        type: "file",
      },
      {
        name: "user",
        path: "/workspace/src/main/java/com/example/user",
        relativePath: "src/main/java/com/example/user",
        type: "directory",
      },
    ]);

    expect(rows).toEqual([
      {
        path: "/workspace/src/main/java/com/example/user/UserProfileService.java",
        name: "src/main/java/com/example/user/UserProfileService.java",
        type: "file",
        depth: 0,
        expanded: false,
        loaded: false,
        loading: false,
        error: null,
      },
      {
        path: "/workspace/src/main/java/com/example/user",
        name: "src/main/java/com/example/user",
        type: "directory",
        depth: 0,
        expanded: false,
        loaded: false,
        loading: false,
        error: null,
      },
    ]);
  });

  it("builds the lazy tree reveal chain for directory search results", () => {
    expect(
      getWorkspaceFileSearchDirectoryRevealPaths({
        workspacePath: "/workspace",
        directoryPath: "/workspace/src/main/java/com/example/user",
      }),
    ).toEqual([
      "/workspace/src",
      "/workspace/src/main",
      "/workspace/src/main/java",
      "/workspace/src/main/java/com",
      "/workspace/src/main/java/com/example",
      "/workspace/src/main/java/com/example/user",
    ]);
  });

  it("does not reveal directory search results outside the workspace", () => {
    expect(
      getWorkspaceFileSearchDirectoryRevealPaths({
        workspacePath: "/workspace",
        directoryPath: "/outside/src",
      }),
    ).toEqual([]);
  });

  it("filters file tree rows by filename while keeping visible ancestors", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/app", "directory", 1, true),
      row("/workspace/src/app/index.ts", "file", 2),
      row("/workspace/src/app/view.tsx", "file", 2),
      row("/workspace/docs", "directory", 0, true),
      row("/workspace/docs/readme.md", "file", 1),
    ];

    expect(
      filterWorkspaceFileTreeRows({
        rows,
        searchQuery: "index",
        changedOnly: false,
        statusByPath: new Map(),
      }).map((item) => item.path),
    ).toEqual([
      "/workspace/src",
      "/workspace/src/app",
      "/workspace/src/app/index.ts",
    ]);
  });

  it("filters file tree rows to changed files and changed descendant directories", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/app", "directory", 1, true),
      row("/workspace/src/app/index.ts", "file", 2),
      row("/workspace/src/app/view.tsx", "file", 2),
      row("/workspace/docs", "directory", 0, false),
      row("/workspace/README.md", "file", 0),
    ];
    const statusByPath = new Map([
      ["/workspace/src/app/view.tsx", "modified" as const],
      ["/workspace/docs/readme.md", "added" as const],
    ]);

    expect(
      filterWorkspaceFileTreeRows({
        rows,
        searchQuery: "",
        changedOnly: true,
        statusByPath,
      }).map((item) => item.path),
    ).toEqual([
      "/workspace/src",
      "/workspace/src/app",
      "/workspace/src/app/view.tsx",
      "/workspace/docs",
    ]);
  });

  it("combines filename search with changed-only filtering", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/index.ts", "file", 1),
      row("/workspace/src/view.tsx", "file", 1),
    ];
    const statusByPath = new Map([
      ["/workspace/src/view.tsx", "modified" as const],
    ]);

    expect(
      filterWorkspaceFileTreeRows({
        rows,
        searchQuery: "index",
        changedOnly: true,
        statusByPath,
      }),
    ).toEqual([]);
  });

  it("removes sticky folders after scrolling into a closed sibling directory", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/index.ts", "file", 1),
      row("/workspace/docs", "directory", 0, false),
    ];

    expect(
      getWorkspaceFileTreeStickyFolders({
        rows,
        virtualItems: [virtualItem(2)],
        scrollDirection: "forward",
        scrollOffset: 2 * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
      }).map((item) => item.row.path),
    ).toEqual([]);
  });

  it("sticks parent folders when the first visible row is child content", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/app", "directory", 1, true),
      row("/workspace/src/app/index.ts", "file", 2),
    ];

    expect(
      getWorkspaceFileTreeStickyFolders({
        rows,
        virtualItems: [virtualItem(2)],
        scrollDirection: "forward",
        scrollOffset: 2 * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
      }).map((item) => item.row.path),
    ).toEqual(["/workspace/src", "/workspace/src/app"]);
  });

  it("sticks each nested folder when it reaches its stacked sticky boundary", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/app", "directory", 1, true),
      row("/workspace/src/app/index.ts", "file", 2),
    ];

    expect(
      getWorkspaceFileTreeStickyFolders({
        rows,
        virtualItems: [virtualItem(0), virtualItem(1), virtualItem(2)],
        scrollDirection: "forward",
        scrollOffset: 1,
      }).map((item) => item.row.path),
    ).toEqual(["/workspace/src", "/workspace/src/app"]);
  });

  it("masks the virtual list below the combined sticky container", () => {
    expect(
      getWorkspaceFileTreeListMaskStyle({
        stickyFolderCount: 2,
      }),
    ).toMatchObject({
      maskImage: "linear-gradient(to bottom, transparent 0 56px, black 56px)",
      maskPosition: "0 var(--workspace-file-tree-mask-offset)",
      maskSize: "100% calc(100% - var(--workspace-file-tree-mask-offset))",
      maskRepeat: "no-repeat",
    });
    expect(
      getWorkspaceFileTreeListMaskStyle({
        stickyFolderCount: 0,
      }),
    ).toBeUndefined();
  });

  it("does not stick an expanded folder before scrolling starts", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/index.ts", "file", 1),
    ];

    expect(
      getWorkspaceFileTreeStickyFolders({
        rows,
        virtualItems: [virtualItem(0)],
        scrollDirection: "forward",
        scrollOffset: 0,
      }).map((item) => item.row.path),
    ).toEqual([]);
  });

  it("sticks an expanded folder after scrolling it to the boundary", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/README.md", "file", 0),
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/index.ts", "file", 1),
    ];

    expect(
      getWorkspaceFileTreeStickyFolders({
        rows,
        virtualItems: [virtualItem(1)],
        scrollDirection: "forward",
        scrollOffset: WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
      }).map((item) => item.row.path),
    ).toEqual(["/workspace/src"]);
  });

  it("does not stick folders when the tree is not scrollable", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/index.ts", "file", 1),
    ];

    expect(
      getWorkspaceFileTreeStickyFolders({
        rows,
        virtualItems: [virtualItem(0)],
        scrollDirection: "forward",
        scrollOffset: 0,
        enabled: false,
      }).map((item) => item.row.path),
    ).toEqual([]);
  });

  it("unsticks a folder while scrolling backward once it crosses its sticky boundary", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/index.ts", "file", 1),
    ];

    expect(
      getWorkspaceFileTreeStickyFolders({
        rows,
        virtualItems: [virtualItem(1)],
        scrollDirection: "backward",
        scrollOffset: WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
      }).map((item) => item.row.path),
    ).toEqual(["/workspace/src"]);

    expect(
      getWorkspaceFileTreeStickyFolders({
        rows,
        virtualItems: [virtualItem(0), virtualItem(1)],
        scrollDirection: "backward",
        scrollOffset: 0,
      }).map((item) => item.row.path),
    ).toEqual([]);
  });

  it("keeps a sticky row until its original row crosses the sticky boundary", () => {
    const rows: WorkspaceFileTreeRow[] = [
      row("/workspace/README.md", "file", 0),
      row("/workspace/src", "directory", 0, true),
      row("/workspace/src/index.ts", "file", 1),
    ];

    expect(
      getWorkspaceFileTreeStickyFolders({
        rows,
        virtualItems: [virtualItem(1), virtualItem(2)],
        scrollDirection: "backward",
        scrollOffset: 2 * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX - 1,
      }).map((item) => item.row.path),
    ).toEqual(["/workspace/src"]);

    expect(
      getWorkspaceFileTreeStickyFolders({
        rows,
        virtualItems: [virtualItem(2)],
        scrollDirection: "backward",
        scrollOffset: 2 * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
      }).map((item) => item.row.path),
    ).toEqual(["/workspace/src"]);
  });
});
