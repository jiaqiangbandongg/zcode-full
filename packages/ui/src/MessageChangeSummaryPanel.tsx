import { useMemo, useState, type CSSProperties } from "react";
import type {
  ZCodePersistedFileChange,
  ZCodeTaskChangeSummary,
  ZCodeTurnFileState,
} from "@zcode/shared";
import { TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON, testId } from "@zcode/shared";
import { ChevronRightIcon, Undo2 } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { buildTurnChangeSummary, toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { Button } from "@/components/ui/button.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";
import { cn } from "@/components/lib/utils.js";
import {
  buildChangeSummaryDiffViewerSource,
  buildChangeSummaryFilePreviewSource,
  openChangeSummaryDiffViewer,
} from "@/messageChangeSummaryPreview.js";
export {
  buildChangeSummaryDiffViewerSource,
  buildChangeSummaryFilePreviewSource,
  openChangeSummaryDiffViewer,
} from "@/messageChangeSummaryPreview.js";

interface MessageChangeSummaryPanelProps {
  summary: ZCodeTaskChangeSummary;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  changeDetails?: ZCodePersistedFileChange | null;
  readonlyDiffPatchesByPath?: ReadonlyMap<string, string>;
  fileState?: ZCodeTurnFileState;
  messageId?: string;
  compactForRemoteControl?: boolean;
  animationDelayMs?: number;
  // M5 ③-4：onPreviewFilesRewind/onApplyFilesRewind 已随 session/previewFileRewind、
  // session/applyFileRewind 旧协议词删除（全仓无 caller 传入）；文件撤销回退只剩
  // onToggleFiles 回调（数据面与协议无关）。
  onToggleFiles?: () => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}

export function MessageChangeSummaryPanel({
  summary,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  changeDetails,
  readonlyDiffPatchesByPath,
  fileState = "applied",
  messageId,
  compactForRemoteControl = false,
  animationDelayMs = 0,
  onToggleFiles,
  onOpenCodeViewer,
}: MessageChangeSummaryPanelProps) {
  const { intl } = useZCodeIntl();
  const [isFileListOpen, setIsFileListOpen] = useState(false);

  const turnSummary = useMemo(() => {
    // Bugfix: 某些链路传进来的 summary 可能还是 task/session 级汇总。
    // 面板已经拿到了当前轮 changeDetails，优先从单轮快照重算，避免历史轮次文件混进当前消息。
    return buildTurnChangeSummary(changeDetails) ?? summary;
  }, [changeDetails, summary]);

  const filesChangedLabel = intl.formatMessage(
    {
      id:
        turnSummary.fileCount === 1
          ? "chat.changeSummary.filesChanged.one"
          : "chat.changeSummary.filesChanged.other",
    },
    { count: String(turnSummary.fileCount) },
  );

  // Bugfix: 变更摘要以前只有聚合计数，文件行点击后拿不到对应的 before/after。
  // 这里按 path 建索引，把同一轮持久化快照重新接回 UI，文件列表才能展开真正的 diff。
  const snapshotsByPath = useMemo(
    () => new Map((changeDetails?.snapshots ?? []).map((snapshot) => [snapshot.path, snapshot])),
    [changeDetails],
  );
  const isFileRewindApplied = fileState === "reverted";
  const toggleActionLabel = intl.formatMessage({
    id: isFileRewindApplied
      ? "chat.changeSummary.reverted"
      : "chat.changeSummary.rewind",
  });
  const panelToggleLabel = intl.formatMessage({
    id: isFileListOpen ? "chat.changeSummary.collapse" : "chat.changeSummary.expand",
  });
  const reviewDiffLabel = intl.formatMessage({ id: "chat.changeSummary.review" });
  const canRequestFileRewind = Boolean(onToggleFiles);

  return (
    <>
    <Collapsible
      open={isFileListOpen}
      onOpenChange={setIsFileListOpen}
      // Bugfix: 历史消息里的文件卡会等二次校验后再出现；
      // summary 如果没有同样的渐入，会在文件卡稳定前后显得像突兀跳出。
      data-zcode-stream-animate="true"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-none"
      style={
        {
          "--zcode-stream-animation-delay": `${animationDelayMs}ms`,
        } as CSSProperties
      }
    >
      {/* Bugfix: 展开/收起触发器之前只给内部小按钮加 hover 背景，
          收起态看起来像 header 里漂着一块。hover 视觉提升到整行 header，
          但仍只让左侧标题区域负责 toggle，避免右侧撤销按钮误触发折叠。 */}
      <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-hover">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={panelToggleLabel}
            title={panelToggleLabel}
            className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left"
          >
            <ChevronRightIcon
              className={`size-3.5 shrink-0 text-foreground-subtlest transition-transform ${
                isFileListOpen ? "rotate-90" : ""
              }`}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
              {filesChangedLabel}
            </span>
            <span className="shrink-0 tabular-nums text-ui-base">
              <span className="text-diff-added">+{turnSummary.added}</span>{" "}
              <span className="text-diff-removed">-{turnSummary.removed}</span>
            </span>
          </button>
        </CollapsibleTrigger>
        {canRequestFileRewind && turnSummary.fileCount > 0 && changeDetails ? (
          <div className="flex items-center gap-1.5 text-ui-base text-foreground-subtle">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={
                messageId
                  ? testId(TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON, messageId)
                  : TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON
              }
              data-message-id={messageId}
              aria-label={toggleActionLabel}
              title={toggleActionLabel}
              disabled={isFileRewindApplied}
              onClick={() => onToggleFiles?.()}
              className="h-7 gap-1.5 px-2 text-ui-base text-foreground-subtle hover:text-foreground"
            >
              <span>{toggleActionLabel}</span>
              <Undo2 className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>

      <CollapsibleContent>
        {/* Bugfix: 变更摘要整体之前没有折叠态，完成任务后会默认展开所有文件行。
            默认闭合可避免大批文件变更把最新回复向上挤开；单文件 diff 仍保持按需展开。 */}
        {turnSummary.files.map((file) => {
          const relativePath = toWorkspaceRelativePath(workspacePath, file.path);
          const snapshot = snapshotsByPath.get(file.path);
          const readonlyPatch = readonlyDiffPatchesByPath?.get(file.path);
          const diffViewerSource = buildChangeSummaryDiffViewerSource({
            patch: readonlyPatch,
            path: file.path,
            snapshot,
            relativePath,
            workspacePath,
            workspaceIdentity,
            workspaceRemoteSessionId,
          });
          const filePreviewSource = buildChangeSummaryFilePreviewSource({
            path: file.path,
            relativePath,
            workspacePath,
            workspaceIdentity,
            workspaceRemoteSessionId,
          });
          const canOpenDiff = Boolean(diffViewerSource && onOpenCodeViewer);
          const openDiffViewer = () => {
            openChangeSummaryDiffViewer(diffViewerSource, onOpenCodeViewer);
          };

          return (
            <div key={file.path} className="w-full bg-background/50 overflow-hidden">
              <div
                aria-disabled={!canOpenDiff}
                className={cn(
                  "flex w-full items-center gap-1 px-2 py-2 text-left transition-colors",
                  canOpenDiff ? "cursor-pointer hover:bg-hover/30" : "cursor-default",
                )}
                onClick={openDiffViewer}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  openDiffViewer();
                }}
                role="button"
                tabIndex={canOpenDiff ? 0 : -1}
                title={file.path}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="min-w-0 flex items-center">
                    <FileDisplayInline
                      path={file.path}
                      options={{
                        basePath: workspacePath,
                        showFilePath: true,
                        className: "inline-flex min-w-0 max-w-full items-center gap-1.5",
                        fileNameClassName: "truncate text-ui-base font-medium text-foreground",
                        filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                      }}
                    />
                  </div>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums text-ui-base">
                    {file.added > 0 ? <span className="text-diff-added">+{file.added}</span> : null}
                    {file.removed > 0 ? (
                      <span className="text-diff-removed">-{file.removed}</span>
                    ) : null}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    aria-label={reviewDiffLabel}
                    title={reviewDiffLabel}
                    disabled={!canOpenDiff}
                    className="h-7 gap-1.5 rounded-lg bg-input px-2 text-ui-base"
                    onClick={(event) => {
                      event.stopPropagation();
                      openDiffViewer();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <span>{reviewDiffLabel}</span>
                  </Button>
                  <OpenSplitButton
                    target={{
                      type: "file",
                      path: file.path,
                      title: relativePath,
                      label: relativePath,
                      previewSource: filePreviewSource,
                    }}
                    onOpenCodeViewer={onOpenCodeViewer}
                    // Bugfix: 手机远控只需要在应用内预览 diff 文件，不需要桌面端的“选择 App 打开”菜单。
                    // 隐藏下拉区可以减少窄屏误触，同时保留主“打开”按钮的预览能力。
                    hideOpenWithMenu={compactForRemoteControl}
                    stopPropagation
                  />
                </div>
              </div>
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
    </>
  );
}
