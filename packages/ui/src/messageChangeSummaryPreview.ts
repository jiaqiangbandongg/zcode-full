import type { ZCodePersistedFileChange } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { CodeViewerWorkspaceScope } from "@/lib/codeViewerWorkspaceScope.js";

export function buildChangeSummaryDiffViewerSource({
  patch,
  path,
  snapshot,
  relativePath,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
}: {
  patch?: string;
  path?: string;
  snapshot: ZCodePersistedFileChange["snapshots"][number] | undefined;
  relativePath: string;
} & CodeViewerWorkspaceScope): CodeViewerSource | undefined {
  const workspaceScope = {
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  };
  if (patch) {
    return {
      type: "patch",
      title: relativePath,
      path: path ?? snapshot?.path,
      patch,
      ...workspaceScope,
    };
  }

  if (!snapshot) {
    return undefined;
  }

  return {
    type: "multi-file-diff",
    title: relativePath,
    path: snapshot.path,
    beforeContent: snapshot.beforeContent ?? "",
    afterContent: snapshot.afterContent,
    ...workspaceScope,
  };
}

export function buildChangeSummaryFilePreviewSource(input: {
  path: string;
  relativePath: string;
  workspacePath: string;
} & CodeViewerWorkspaceScope): CodeViewerSource {
  const { path, relativePath, workspacePath, workspaceIdentity, workspaceRemoteSessionId } = input;
  return {
    type: "file",
    title: relativePath,
    path,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  };
}

export function openChangeSummaryDiffViewer(
  source: CodeViewerSource | undefined,
  onOpenCodeViewer: ((source: CodeViewerSource) => void) | undefined,
) {
  if (!source || !onOpenCodeViewer) {
    return false;
  }

  onOpenCodeViewer(source);
  return true;
}
