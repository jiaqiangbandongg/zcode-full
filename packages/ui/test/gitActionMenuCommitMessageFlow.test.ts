import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readGitActionMenuSource(): string {
  return readFileSync("packages/ui/src/GitActionMenu.tsx", "utf8");
}

function readV4ChatPaneSource(): string {
  return readFileSync("packages/ui/src/v4/V4ChatPane.tsx", "utf8");
}

function readSessionPaneSource(): string {
  return readFileSync("packages/ui/src/v4/SessionPane.tsx", "utf8");
}

function readConversationStatusPanelSource(): string {
  return readFileSync("packages/ui/src/v4/ConversationStatusPanel.tsx", "utf8");
}

function readWorkspaceShellLayoutSource(): string {
  return readFileSync("packages/ui/src/app-shell/WorkspaceShellLayout.tsx", "utf8");
}

function sliceSourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("GitActionMenu commit message flow", () => {
  it("generates a missing message before commit submission", () => {
    const source = readGitActionMenuSource();
    const generateBlock = sliceSourceBlock(
      source,
      "const handleGenerateCommitMessage",
      "const pushCurrentBranch",
    );
    const submitBlock = sliceSourceBlock(
      source,
      "const handleCommitAction",
      "const handlePushSubmit",
    );
    const commitDialogContentBlock = sliceSourceBlock(
      source,
      "showCloseButton={false}",
      "{loading ?",
    );

    expect(generateBlock).toContain("await generateCommitMessage(");
    expect(generateBlock).toContain("commitIncludeUnstaged");
    expect(submitBlock).toContain("await generateCommitMessage(");
    expect(submitBlock).toContain("getCommitDialogStagePaths");
    expect(submitBlock).toContain("const pathsToStage = includeUnstaged ? stagePaths : []");
    expect(submitBlock).toContain("pushAfterCommit");
    expect(source).toContain("git.actionMenu.commitDialog.includeUnstaged");
    expect(source).toContain("git.actionMenu.commitDialog.action.commitAndPush");
    expect(source).not.toContain("showOverlay={false}");
    expect(commitDialogContentBlock).toContain("max-w-md");
    expect(commitDialogContentBlock).not.toContain("max-w-lg");
    expect(commitDialogContentBlock).not.toContain("max-w-xl");
    expect(source).toContain("min-h-28");
    expect(source).toContain("SparklesIcon");
    expect(source).not.toContain("MoreHorizontalIcon");
    expect(source).toContain('formatCommandShortcutLabel("⏎")');
    expect(source).not.toContain("/ENTER/g");
    expect(source).not.toContain('"↵"');
    expect(source).not.toContain('type="checkbox"');
    expect(source).toContain('role="checkbox"');
    expect(source).toContain("aria-checked={includeUnstaged}");
    expect(source).toContain("onIncludeUnstagedChange(!includeUnstaged)");
    expect(source).toContain("CheckIcon");
    expect(source).toContain("flex size-4 items-center justify-center rounded-sm border");
    expect(source).toContain("border-primary bg-primary text-primary-foreground");
    expect(source).toContain("border-border bg-background text-transparent");
    expect(source).toContain("<Command");
    expect(source).toContain("<CommandList");
    expect(source).toContain("<CommandItem");
    expect(source).toContain("<CommandShortcut");
    expect(source).not.toContain("data-checked={selected");
    expect(source).toContain("selectedActionId");
    expect(source).toContain("setSelectedActionId");
    expect(source).toContain("triggerSelectedAction");
    expect(source).toContain("TID_GIT_ACTION_TRIGGER");
    expect(source).toContain("TID_GIT_COMMIT_DIALOG");
    expect(source).toContain("TID_GIT_COMMIT_MESSAGE_INPUT");
    expect(source).toContain("TID_GIT_COMMIT_GENERATE_BUTTON");
    expect(source).toContain("TID_GIT_COMMIT_INCLUDE_UNSTAGED");
    expect(source).toContain("TID_GIT_COMMIT_ACTION_COMMAND");
    expect(source).toContain("TID_GIT_COMMIT_ACTION_ITEM");
    expect(source).toContain("messageTextareaRef");
    expect(source).toContain("messageInputFocusedOnOpenRef");
    expect(source).toContain("window.requestAnimationFrame");
    expect(source).toContain("messageTextareaRef.current?.focus()");
    expect(source).toContain("onOpenAutoFocus");
    expect(source).toContain("event.preventDefault()");
    expect(source).toContain("ref={messageTextareaRef}");
    expect(source).toContain("GIT_COMMIT_MESSAGE_TEXTAREA_ID");
    expect(source).toContain("isCommitMessageTextAreaTarget");
    expect(source).toContain("selectAdjacentAction");
    expect(source).toContain("handleActionCommandKeyDown");
    expect(source).toContain('event.key !== "ArrowDown" && event.key !== "ArrowUp"');
    expect(source).toContain("isCommitMessageTextAreaTarget(event.target)");
    expect(source).toContain("tabIndex={0}");
    expect(source).toContain("onKeyDownCapture={handleDialogKeyDown}");
    expect(source).toContain("onKeyDown={handleActionCommandKeyDown}");
    expect(source).toContain("matchesPrimaryShortcut(event, \"Enter\")");
    expect(source).not.toContain("<CommitActionRow");
    expect(source).toContain("<GitBranchSwitcher");
    expect(source).toContain("showFooterActions={false}");
    expect(source).toContain("onRefreshGit={refreshCommitDialogAfterBranchChange}");
    expect(source).toContain("const refreshResult = await gitService.refresh");
    expect(source).toContain("refreshResult.unstagedChanges");
    expect(source).toContain("filterCommitPreviewFilesByCurrentSession");
    expect(source).toContain("const displayChangeSummary = state?.activeTaskChangeSummary");
    expect(source).toContain("displayChangeSummary?.added ?? totalAdded");
    expect(source).toContain("displayChangeSummary?.removed ?? totalRemoved");
    expect(source).toContain("getCurrentSessionFilePaths");
    expect(source).toContain("currentSessionFilePaths");
    expect(source).toContain("commitMessageConversationContext?: GitCommitMessageConversationContext");
    expect(source).toContain("conversationContext: commitMessageConversationContext");
    expect(source).toContain("paths: stagePaths");

    const includeUnstagedPosition = source.indexOf(
      "git.actionMenu.commitDialog.includeUnstaged",
    );
    const actionSeparatorPosition = source.indexOf(
      "border-t border-border/50 px-2.5 py-2",
    );
    expect(includeUnstagedPosition).toBeGreaterThanOrEqual(0);
    expect(actionSeparatorPosition).toBeGreaterThan(includeUnstagedPosition);
  });

  it("passes the active task context into the commit dialog stats and generation", () => {
    const actionMenuSource = readGitActionMenuSource();
    const v4ChatPaneSource = readV4ChatPaneSource();
    const sessionPaneSource = readSessionPaneSource();
    const statusPanelSource = readConversationStatusPanelSource();
    const shellLayoutSource = readWorkspaceShellLayoutSource();

    expect(actionMenuSource).toContain("activeTaskChangeSummary?: ZCodeTaskChangeSummary");
    expect(actionMenuSource).toContain("activeTaskChangeSummary,");
    expect(v4ChatPaneSource).toContain(
      "activeTaskChangeSummary={activeTaskChangeSummary}",
    );
    expect(sessionPaneSource).toContain(
      "activeTaskChangeSummary={activeTaskChangeSummary}",
    );
    expect(statusPanelSource).toContain(
      "activeTaskChangeSummary={activeTaskChangeSummary ?? null}",
    );
    expect(shellLayoutSource).toContain(
      "activeTaskChangeSummary={activeTaskChangeSummary}",
    );
    expect(actionMenuSource).toContain(
      "conversationMessageCount:",
    );
    expect(actionMenuSource).toContain(
      "currentSessionFileCount:",
    );
  });

  it("removes the auxiliary dropdown menu from the trigger", () => {
    const source = readGitActionMenuSource();

    expect(source).toContain('id: "git.actionMenu.trigger"');
    expect(source).not.toContain("DropdownMenu");
    expect(source).not.toContain("git.actionMenu.menuTitle");
    expect(source).not.toContain("git.actionMenu.createBranch");
  });
});
