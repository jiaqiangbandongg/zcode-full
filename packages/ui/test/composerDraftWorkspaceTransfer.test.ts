// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  persistV4ComposerDraft,
  rememberComposerWorkspaceScope,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import {
  captureV4ComposerDraftHandoff,
  registerV4ComposerDraftReader,
  stageV4ComposerDraftAttachments,
  consumeV4ComposerDraftAttachments,
  clearV4ComposerDraftWorkspaceTransferRequest,
  consumeV4ComposerDraftWorkspaceTransferRequest,
  requestV4ComposerDraftWorkspaceTransfer,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";

describe("composer draft workspace transfer", () => {
  it("编辑器未挂载时按当前客户端及项目读取交接正文", () => {
    localStorage.clear();
    for (const clientNamespace of ["desktop", "mobile:test"]) {
      const scope = { clientNamespace, hostId: "local", projectId: "p" };
      rememberComposerWorkspaceScope("/same", undefined, scope);
      persistV4ComposerDraft(
        "/same",
        undefined,
        V4_DRAFT_SCOPE_ROOT,
        { text: clientNamespace },
        scope,
      );
    }
    expect(captureV4ComposerDraftHandoff("/same", undefined, "mobile:test").draft.text).toBe(
      "mobile:test",
    );
    expect(captureV4ComposerDraftHandoff("/same").draft.text).toBe("desktop");
    localStorage.clear();
  });
  beforeEach(() => clearV4ComposerDraftWorkspaceTransferRequest());

  it("is consumed only by the matching source and target workspace", () => {
    requestV4ComposerDraftWorkspaceTransfer({
      sourceWorkspacePath: "/project",
      targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
    });

    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: "/other",
        targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
      }),
    ).toBe(false);
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: "/project",
        targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
      }),
    ).toBe(true);
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: "/project",
        targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
      }),
    ).toBe(false);
  });
});

it("captures live editor content and delivers attachments once to the exact target", () => {
  const attachment = {
    id: "source",
    file: new File(["data"], "draft.txt"),
    filename: "draft.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
  };
  const unregister = registerV4ComposerDraftReader("remote:source", () => ({
    draft: { text: "not yet persisted", editorStateJson: "rich-state" },
    attachments: [attachment],
  }));
  const snapshot = captureV4ComposerDraftHandoff("/same-path", "remote:source");
  expect(snapshot.draft).toEqual({ text: "not yet persisted", editorStateJson: "rich-state" });
  stageV4ComposerDraftAttachments("/same-path", "remote:target", 2, snapshot);
  expect(consumeV4ComposerDraftAttachments("/same-path", 2)).toBeNull();
  expect(consumeV4ComposerDraftAttachments("remote:target", 2)).toEqual([attachment]);
  expect(consumeV4ComposerDraftAttachments("remote:target", 2)).toBeNull();
  unregister();
});

it("同目录的新项目也交接附件，由草稿代际消费一次", () => {
  const attachment = {
    id: "same-root",
    file: new File(["data"], "draft.txt"),
    filename: "draft.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
  };
  const snapshot = {
    sourceWorkspaceKey: "/same",
    draft: { text: "draft" },
    attachments: [attachment],
  };
  stageV4ComposerDraftAttachments("/same", undefined, 2, snapshot);
  expect(consumeV4ComposerDraftAttachments("/same", 2)).toEqual([attachment]);
  expect(consumeV4ComposerDraftAttachments("/same", 2)).toBeNull();
});

it("discards a handoff after the target draft has been replaced", () => {
  stageV4ComposerDraftAttachments("/target", undefined, 2, {
    sourceWorkspaceKey: "/source",
    draft: { text: "old" },
    attachments: [],
  });
  expect(consumeV4ComposerDraftAttachments("/target", 3)).toBeNull();
  expect(consumeV4ComposerDraftAttachments("/target", 2)).toBeNull();
});
