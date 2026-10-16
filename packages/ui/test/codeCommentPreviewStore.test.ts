import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCodeCommentPreviewBucketKey,
  useCodeCommentPreviewStore,
} from "@/store/codeCommentPreviewStore.js";
import type { CodeCommentPreview } from "@/lib/codeCommentContext.js";

const baseComment: CodeCommentPreview = {
  id: "comment-1",
  sourcePath: "/workspace/src/app.ts",
  sourceTitle: "app.ts",
  startLine: 10,
  endLine: 10,
  selectedText: "const value = 1;",
  comment: "检查这里。",
};

describe("codeCommentPreviewStore", () => {
  beforeEach(() => {
    useCodeCommentPreviewStore.setState({ commentsByBucketKey: {} });
  });

  it("keeps preview comments by workspace and file after the pane unmounts", () => {
    const params = {
      workspacePath: "/workspace",
      sourcePath: "/workspace/src/app.ts",
    };

    useCodeCommentPreviewStore.getState().addComment({
      ...params,
      comment: baseComment,
    });

    expect(useCodeCommentPreviewStore.getState().getComments(params)).toEqual([
      baseComment,
    ]);
    expect(
      useCodeCommentPreviewStore.getState().commentsByBucketKey[
        buildCodeCommentPreviewBucketKey(params)
      ],
    ).toHaveLength(1);
  });

  it("removes a source comment without requiring the original file pane to be mounted", () => {
    useCodeCommentPreviewStore.getState().addComment({
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:demo:/workspace",
      sourcePath: "/workspace/src/app.ts",
      comment: baseComment,
    });

    useCodeCommentPreviewStore.getState().removeCommentBySource({
      id: baseComment.id,
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:demo:/workspace",
    });

    expect(
      useCodeCommentPreviewStore.getState().getComments({
        workspacePath: "/workspace",
        workspaceIdentity: "remote:ssh:demo:/workspace",
        sourcePath: "/workspace/src/app.ts",
      }),
    ).toEqual([]);
  });

  it("can restore a preview comment when sending is rejected", () => {
    useCodeCommentPreviewStore.getState().restoreCommentFromAttachment({
      ...baseComment,
      id: baseComment.id,
      workspacePath: "/workspace",
      sourcePath: "/workspace/src/app.ts",
    });

    expect(
      useCodeCommentPreviewStore.getState().getComments({
        workspacePath: "/workspace",
        sourcePath: "/workspace/src/app.ts",
      }),
    ).toEqual([baseComment]);
  });
});
