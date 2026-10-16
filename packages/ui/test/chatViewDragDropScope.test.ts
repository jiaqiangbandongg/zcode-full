import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

describe("ConversationComposer drag and drop scope", () => {
  it("由 SessionPane 根节点唯一接管拖拽，并在全聊天区展示分类反馈", () => {
    const composerSource = readSource("packages/ui/src/v4/ConversationComposer.tsx");
    const sessionPaneSource = readSource("packages/ui/src/v4/SessionPane.tsx");

    expect(composerSource).toContain("onDropTargetControllerChange?.(dropTargetController)");
    expect(sessionPaneSource).toContain('data-v4-conversation-drop-target="true"');
    expect(sessionPaneSource).toContain("onDragOver={effectiveDropTargetController?.onDragOver}");
    expect(sessionPaneSource).toContain("onDrop={effectiveDropTargetController?.onDrop}");
    expect(sessionPaneSource).toContain("pointer-events-none absolute inset-0 z-50");
    expect(sessionPaneSource).toContain('event.dataTransfer.dropEffect = "none"');
  });

  it("主输入框不重复注册文件 drop 入口", () => {
    const composerSource = readSource("packages/ui/src/v4/ConversationComposer.tsx");
    const promptEditorCall = composerSource.slice(
      composerSource.indexOf("<ChatPromptEditor"),
      composerSource.indexOf("/>", composerSource.indexOf("<ChatPromptEditor")),
    );

    expect(promptEditorCall).not.toContain("enableWorkspaceFileDrop");
    expect(promptEditorCall).not.toContain("enableExternalFileDrop");
    expect(promptEditorCall).not.toContain("onDrop=");
  });

  it("保留 workspace mention 分流与嵌套编辑器的冒泡保护", () => {
    const promptEditorSource = readSource("packages/ui/src/prompt-editor/ChatPromptEditor.tsx");
    const attachmentSource = readSource("packages/ui/src/v4/composer/useComposerAttachments.ts");
    const composerSource = readSource("packages/ui/src/v4/ConversationComposer.tsx");

    expect(promptEditorSource).toContain("event.stopPropagation()");
    expect(attachmentSource).toContain('types.includes("Files")');
    expect(attachmentSource).toContain('? "workspace" : "attachment"');
    // Bugfix: v4 composer 的 workspace drop 仍由主 drop controller 消费；源码格式化可能换行，
    // 这里断言语义调用而不是固定单行文本，避免测试只因排版变化误报。
    expect(composerSource).toMatch(
      /readWorkspaceFileDragPayload\(\s*event\.dataTransfer\s*,?\s*\)/u,
    );
    expect(composerSource).toContain("usePromptEditorDragState");
    expect(composerSource).toContain("只插入 mention，绝不能进入上传队列");
  });

  it("New Task 标题栏复用主草稿 controller，而不是另建附件入口", () => {
    const workspaceShellSource = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
    const workspaceHeaderSource = readSource("packages/ui/src/WorkspaceHeader.tsx");

    expect(workspaceShellSource).toContain("draftDropTargetController={");
    expect(workspaceShellSource).toContain("draftHeaderDropTargetController");
    expect(workspaceHeaderSource).toContain('data-testid="new-task-draft-drop-mask"');
    expect(workspaceHeaderSource).not.toContain(
      "onDragOver={draftDropTargetController?.onDragOver}",
    );
    expect(workspaceHeaderSource).toContain("onDragOver={draftDropTargetController.onDragOver}");
    expect(workspaceHeaderSource).toContain("onDrop={draftDropTargetController.onDrop}");
    expect(workspaceShellSource).toContain("onPrimaryDraftDropTargetControllerChange");
  });

  it("使用 Drop to 动作文案并区分附件与工作区条目", () => {
    const englishLocale = readSource("packages/ui/src/i18n/locales/en-US.ts");

    expect(englishLocale).toContain('"chat.attachments.dragHint": "Drop to add attachments"');
    expect(englishLocale).toContain(
      '"chat.composer.workspaceFileDragHint": "Drop to mention this file or folder"',
    );
  });
});
