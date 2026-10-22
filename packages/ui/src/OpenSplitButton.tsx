import type { EditorInfo } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, PanelRightIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { logger } from "@/logger.js";

// 导出类型供共用时间线以 import type 引用（构建期擦除，不把 open-with 子树带进公开页 bundle）。
export type OpenSplitButtonTarget =
  | {
      type: "website";
      url: string;
      localPath?: string;
      workspacePath?: string;
    }
  | {
      type: "file";
      path: string;
      title: string;
      label: string;
      previewSource?: CodeViewerSource;
    };

interface OpenSplitButtonProps {
  target: OpenSplitButtonTarget;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  hideOpenWithMenu?: boolean;
  stopPropagation?: boolean;
  /** 整张卡片复用按钮的操作与状态，右键和下拉不会维护两套动作。 */
  renderCard?: (button: ReactNode) => ReactElement;
}

export function OpenSplitButton({
  target,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  hideOpenWithMenu = false,
  stopPropagation = false,
  renderCard,
}: OpenSplitButtonProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();

  const previewSource = target.type === "file" ? target.previewSource : undefined;
  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: previewSource?.workspacePath,
    workspaceIdentity: previewSource?.workspaceIdentity,
    workspaceRemoteSessionId: previewSource?.workspaceRemoteSessionId,
  });
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  const isRemoteSource = Boolean(
    previewSource?.workspaceIdentity ||
    previewSource?.workspaceRemoteSessionId ||
    matchedOpenContext.isRemoteWorkspace,
  );
  const fileActions = useFileContextActions({
    canOpenLocalFileManager: Boolean(platform.canOpenLocalFiles),
    isRemoteWorkspace: isRemoteSource,
    remoteTarget: openInEditorRemoteTarget,
    workspaceIdentity: previewSource?.workspaceIdentity,
  });
  const filePath = target.type === "file" ? target.path : target.localPath;
  const workspacePath =
    target.type === "file" ? previewSource?.workspacePath : target.workspacePath;
  const canOpenNative = Boolean(platform.canOpenLocalFiles && !isRemoteSource);
  const editorRequest = useRef(0);
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [editorsLoaded, setEditorsLoaded] = useState(false);
  const [loadingEditors, setLoadingEditors] = useState(false);
  const sortedEditors = useMemo(
    () =>
      isRemoteSource && !openInEditorRemoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors: editors,
            selectedEditorId: null,
            remoteTarget: openInEditorRemoteTarget,
          }).availableEditors,
    [editors, isRemoteSource, openInEditorRemoteTarget],
  );
  const canPreview =
    target.type === "website"
      ? Boolean(onOpenBrowserUrl)
      : Boolean(onOpenFileLink || onOpenCodeViewer);
  useEffect(() => {
    setEditors([]);
    setEditorsLoaded(false);
    setLoadingEditors(false);
    // 卡片虚拟行重用时旧目标的异步应用结果不能覆盖新目标。
    editorRequest.current += 1;
    return () => {
      editorRequest.current += 1;
    };
  }, [filePath, previewSource?.workspaceIdentity, previewSource?.workspaceRemoteSessionId]);

  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  const loadEditors = useCallback(async () => {
    if (editorsLoaded || loadingEditors || target.type !== "file") {
      return;
    }

    const request = ++editorRequest.current;
    setLoadingEditors(true);
    try {
      const result = await platform.getInstalledEditors(target.path);
      if (request !== editorRequest.current) return;
      setEditors(result);
      setEditorsLoaded(true);
    } catch (error) {
      if (request !== editorRequest.current) return;
      logger.warn("[OpenSplitButton] 获取第三方打开方式失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (request === editorRequest.current) setLoadingEditors(false);
    }
  }, [editorsLoaded, loadingEditors, platform, target, isRemoteSource, openInEditorRemoteTarget]);

  const handlePreview = () => {
    if (target.type === "website") {
      onOpenBrowserUrl?.(target.url);
      return;
    }

    if (onOpenCodeViewer) {
      onOpenCodeViewer(
        target.previewSource ?? {
          type: "file",
          title: target.title,
          path: target.path,
        },
      );
      return;
    }

    onOpenFileLink?.({
      path: target.path,
      label: target.label,
      pathKind: "file",
      workspacePath: target.previewSource?.workspacePath,
      workspaceIdentity: target.previewSource?.workspaceIdentity,
      workspaceRemoteSessionId: target.previewSource?.workspaceRemoteSessionId,
    });
  };

  const handleOpenInEditor = (editor: EditorInfo) => {
    if (target.type !== "file") {
      return;
    }

    persistLastSelectedEditorId(editor.id);
    // 返回失败和 IPC 拒绝都必须有可见反馈，不能只写日志后静默结束。
    void platform
      .openInEditor(editor.id, target.path, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: target.previewSource?.workspaceIdentity,
      })
      .then((result) => {
        if (!result.success) throw new Error(result.error ?? "unknown-error");
      })
      .catch((error: unknown) => {
        logger.warn("[OpenSplitButton] 第三方 App 打开文件失败", {
          editorId: editor.id,
          path: target.path,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      });
  };

  const handleOpenExternal = () => {
    if (target.type !== "website" || !target.localPath || !platform.openExternalFile) {
      platform.openExternal(target.type === "website" ? target.url : target.path);
      return;
    }

    const localPath = target.localPath;
    const reportFailure = (error: unknown) => {
      logger.warn("[OpenSplitButton] 浏览器打开本地文件失败", {
        path: localPath,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "chat.previewCards.openExternalFailed" }));
    };
    void platform
      .openExternalFile(localPath)
      .then((result) => {
        if (!result.success) reportFailure(result.error ?? "unknown-error");
      })
      .catch(reportFailure);
  };

  const handleOpenDefault = () => {
    if (!filePath || !canOpenNative || !platform.openExternalFile) return;
    void platform
      .openExternalFile(filePath)
      .then((result) => {
        if (!result.success) throw new Error(result.error);
      })
      .catch((error: unknown) => {
        logger.warn("[OpenSplitButton] 默认应用打开文件失败", {
          path: filePath,
          error: String(error),
        });
        toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      });
  };

  // 新增动作只出现在右键菜单，下拉仍使用原有的应用列表布局。
  const renderContextActions = () => {
    const Item = ContextMenuItem;
    const Separator = ContextMenuSeparator;
    const Sub = ContextMenuSub;
    const SubTrigger = ContextMenuSubTrigger;
    const SubContent = ContextMenuSubContent;
    return (
      <>
        <Item disabled={!canPreview} onSelect={handlePreview}>
          <PanelRightIcon className="size-4" />
          {intl.formatMessage({
            id: "chat.previewCards.previewInSidePane",
          })}
        </Item>
        {target.type === "website" ? (
          <Item onSelect={handleOpenExternal}>
            <ExternalLinkIcon className="size-4" />
            {intl.formatMessage({ id: "common.open" })}
          </Item>
        ) : (
          <>
            {canOpenNative && platform.openExternalFile && (
              <Item onSelect={handleOpenDefault}>
                <ExternalLinkIcon className="size-4" />
                {intl.formatMessage({ id: "chat.previewCards.openDefaultApp" })}
              </Item>
            )}
            {platform.canOpenLocalFiles && (!isRemoteSource || openInEditorRemoteTarget) && (
              <Sub>
                <SubTrigger>{intl.formatMessage({ id: "chat.previewCards.openWith" })}</SubTrigger>
                <SubContent>
                  {sortedEditors.length ? (
                    sortedEditors.map((editor) => (
                      <Item key={editor.id} onSelect={() => handleOpenInEditor(editor)}>
                        <img src={editor.iconDataUrl} alt="" className="size-4 shrink-0" />
                        <span>{editor.name}</span>
                      </Item>
                    ))
                  ) : (
                    <Item disabled>
                      {intl.formatMessage({
                        id: loadingEditors ? "common.loading" : "chat.previewCards.noOpenApps",
                      })}
                    </Item>
                  )}
                </SubContent>
              </Sub>
            )}
          </>
        )}
        <Separator />
        {target.type === "website" && (
          <Item onSelect={() => void fileActions.copyAbsolutePath({ path: target.url })}>
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "chat.previewCards.copyLink" })}
          </Item>
        )}
        {filePath && (
          <>
            {workspacePath && (
              <Item
                onSelect={() =>
                  void fileActions.copyRelativePath({
                    path: filePath,
                    relativePath: getWorkspaceFileRelativePath(workspacePath, filePath),
                  })
                }
              >
                <CopyIcon className="size-4" />
                {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
              </Item>
            )}
            <Item onSelect={() => void fileActions.copyAbsolutePath({ path: filePath })}>
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
            </Item>
          </>
        )}
      </>
    );
  };

  const button = (
    <DropdownMenu onOpenChange={(open) => open && void loadEditors()}>
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className={`h-7 rounded-none border-0 gap-1 ${hideOpenWithMenu ? "px-2" : "pr-1.5"}`}
          disabled={!canPreview}
          onClick={(event) => {
            stopEventPropagation(event);
            handlePreview();
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
        {!hideOpenWithMenu && (
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="!w-5 rounded-none border-0 text-foreground-subtlest"
              aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
              title={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
              onClick={stopEventPropagation}
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        )}
      </div>
      {!hideOpenWithMenu && (
        <DropdownMenuContent align="end" side="top" className="w-44" onClick={stopEventPropagation}>
          <OpenSplitButtonDropdownActions
            target={target}
            sortedEditors={sortedEditors}
            loadingEditors={loadingEditors}
            handleOpenExternal={handleOpenExternal}
            handleOpenInEditor={handleOpenInEditor}
          />
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
  if (!renderCard) return button;
  return (
    <ContextMenu
      onOpenChange={(open) =>
        open &&
        platform.canOpenLocalFiles &&
        (!isRemoteSource || openInEditorRemoteTarget) &&
        void loadEditors()
      }
    >
      <ContextMenuTrigger asChild>{renderCard(button)}</ContextMenuTrigger>
      <ContextMenuContent>{renderContextActions()}</ContextMenuContent>
    </ContextMenu>
  );
}

// 右键菜单新增后，下拉菜单仍保留原有的平铺应用列表与路径操作顺序。
function OpenSplitButtonDropdownActions({
  target,
  sortedEditors,
  loadingEditors,
  handleOpenExternal,
  handleOpenInEditor,
}: {
  target:
    | { type: "website" }
    | { type: "file"; path: string; label: string; previewSource?: { workspacePath?: string } };
  sortedEditors: readonly EditorInfo[];
  loadingEditors: boolean;
  handleOpenExternal: () => void;
  handleOpenInEditor: (editor: EditorInfo) => void;
}) {
  const { intl } = useZCodeIntl();
  const fileActions = useFileContextActions();
  const selectedEditor = sortedEditors[0];
  return (
    <>
      {target.type === "website" ? (
        <DropdownMenuItem onSelect={handleOpenExternal}>
          <ExternalLinkIcon className="size-4" />
          <span>
            {intl.formatMessage({
              id: "chat.previewCards.openExternal",
            })}
          </span>
        </DropdownMenuItem>
      ) : (
        <>
          {selectedEditor ? (
            sortedEditors.map((editor) => (
              <DropdownMenuItem key={editor.id} onSelect={() => handleOpenInEditor(editor)}>
                <img src={editor.iconDataUrl} alt={editor.name} className="size-4 shrink-0" />
                <span>{editor.name}</span>
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem disabled>
              {intl.formatMessage({
                id: loadingEditors ? "common.loading" : "chat.previewCards.noOpenApps",
              })}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => void fileActions.copyAbsolutePath({ path: target.path })}
          >
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void fileActions.copyRelativePath({
                path: target.path,
                relativePath: target.previewSource?.workspacePath
                  ? getWorkspaceFileRelativePath(target.previewSource.workspacePath, target.path)
                  : target.label,
              })
            }
          >
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
