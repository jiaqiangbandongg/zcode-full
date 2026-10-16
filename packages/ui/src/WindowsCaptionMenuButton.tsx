import { DesktopCommandIds } from "@zcode/shared";
import type { UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useState } from "react";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createHelpMenuActionHandlers } from "@/lib/helpMenuActions.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import { ChevronDownIcon } from "lucide-react";

import {
  shouldShowDesktopUpdateEntry,
  getUpdateMenuLabelId,
  getUpdateMenuLabelValues,
} from "@/lib/desktopUpdateMenu.js";
export { shouldShowDesktopUpdateEntry } from "@/lib/desktopUpdateMenu.js";

const WINDOWS_CAPTION_MENU_ALIGN_OFFSET = -12;

export function WindowsCaptionMenuButton({
  readOnlyReason,
  workspaceAbsPath,
  onCreateTask,
  onOpenWorkspace,
  allowOpenWorkspace = true,
  allowOpenInFileManager = true,
  onToggleTerminal: _onToggleTerminal,
  onToggleBrowser: _onToggleBrowser,
  triggerPresentation = "header",
  useWindowsCaptionSpacing = false,
}: {
  readOnlyReason?: string;
  workspaceAbsPath: string;
  onCreateTask: () => void;
  onOpenWorkspace: () => void;
  allowOpenWorkspace?: boolean;
  allowOpenInFileManager?: boolean;
  onToggleTerminal: () => void;
  onToggleBrowser: () => void;
  triggerPresentation?: "header" | "header-borderless";
  useWindowsCaptionSpacing?: boolean;
}) {
  const platform = usePlatform();
  const { intl, locale } = useZCodeIntl();
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  const openWorkspaceShortcutLabel = useShortcutCommandLabel("openWorkspace");
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const openFeatureRequest = useFeedbackStore((state) => state.openFeatureRequest);
  const helpMenuActions = createHelpMenuActionHandlers({
    platform,
    intl,
    openSubmit: openFeedbackSubmit,
  });
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const [stdioTapDevState, setStdioTapDevState] = useState({
    enabled: false,
    visible: false,
  });
  const [showCommunityMenuItem, setShowCommunityMenuItem] = useState(false);
  const showDesktopUpdateEntry = shouldShowDesktopUpdateEntry();

  const syncUpdateState = useCallback(async () => {
    if (!platform.getUpdateState) {
      return;
    }

    try {
      const payload = await platform.getUpdateState();
      setUpdateState(payload);
    } catch (error) {
      logger.warn("[WindowsCaptionMenuButton] 同步自动更新状态失败", { error });
    }
  }, [platform]);

  const syncStdioTapDevState = useCallback(async () => {
    if (!platform.getZCodeStdioTapDevState) {
      setStdioTapDevState({ enabled: false, visible: false });
      return;
    }

    try {
      const state = await platform.getZCodeStdioTapDevState();
      setStdioTapDevState({ enabled: state.enabled, visible: state.visible });
    } catch (error) {
      logger.warn("[WindowsCaptionMenuButton] 同步 stdio tap 状态失败", { error });
      setStdioTapDevState({ enabled: false, visible: false });
    }
  }, [platform]);

  useEffect(() => {
    if (showDesktopUpdateEntry) {
      void syncUpdateState();
    }
    void syncStdioTapDevState();
    return showDesktopUpdateEntry
      ? (platform.onUpdateStateChanged?.((payload) => {
          setUpdateState(payload);
        }) ?? (() => {}))
      : undefined;
  }, [platform, showDesktopUpdateEntry, syncStdioTapDevState, syncUpdateState]);

  useEffect(() => {
    let isCancelled = false;

    void platform.canOpenCommunity(locale).then(
      (visible) => {
        if (!isCancelled) {
          setShowCommunityMenuItem(visible);
        }
      },
      () => {
        if (!isCancelled) {
          setShowCommunityMenuItem(false);
        }
      },
    );

    return () => {
      isCancelled = true;
    };
  }, [locale, platform]);

  const handleOpenWorkspaceInFileManager = async () => {
    if (readOnlyReason) {
      return;
    }
    const result = await platform.openInFileManager(workspaceAbsPath);
    if (!result.success) {
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  };

  const handleExecuteDesktopCommand = (
    command: (typeof DesktopCommandIds)[keyof typeof DesktopCommandIds],
  ) => {
    void (async () => {
      await platform.executeDesktopCommand(command);
      if (command === DesktopCommandIds.CheckForUpdates) {
        // Bugfix: 这个 Windows 合并菜单才是截图里的入口。
        // 点击后菜单会关闭，重新打开前主动拉取 main 中的 updater 状态，避免一直显示静态“检查更新”。
        await syncUpdateState();
      }
    })();
  };

  const handleToggleStdioTapDevProxy = () => {
    void (async () => {
      await platform.executeDesktopCommand(DesktopCommandIds.ToggleZCodeStdioTapDevProxy);
      await syncStdioTapDevState();
    })();
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          if (showDesktopUpdateEntry) {
            void syncUpdateState();
          }
          void syncStdioTapDevState();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className={cn(
            "text-foreground-subtle hover:text-foreground [app-region:no-drag]",
            useWindowsCaptionSpacing
              ? WINDOWS_CAPTION_CONTROL_CLASS
              : "h-full w-[45px] rounded-none",
            "border-0 hover:bg-hover",
            triggerPresentation === "header" && "border-l border-border/50",
          )}
          aria-label={intl.formatMessage({ id: "titleBar.windowMenu" })}
        >
          <ChevronDownIcon className="size-5 text-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // Bugfix: Windows titleBarOverlay 的原生窗口按钮宽度会受 DPI / 系统主题 / Electron 取整影响，
        // 菜单右对齐到 45px 自绘入口时，浮层边缘可能压到最小化按钮下方；轻微左移只影响这颗 caption 菜单。
        alignOffset={WINDOWS_CAPTION_MENU_ALIGN_OFFSET}
        side="bottom"
        sideOffset={8}
        className="w-72 border border-popover-border bg-menu p-2"
      >
        <DropdownMenuItem
          disabled={Boolean(readOnlyReason)}
          title={readOnlyReason}
          onSelect={() => {
            if (!readOnlyReason) {
              onCreateTask();
            }
          }}
        >
          {intl.formatMessage({ id: "titleBar.menu.file.newTask" })}
          <DropdownMenuShortcut>{newTaskShortcutLabel}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {allowOpenWorkspace ? (
          <DropdownMenuItem onSelect={onOpenWorkspace}>
            {intl.formatMessage({ id: "workspace.openWorkspace" })}
            <DropdownMenuShortcut>{openWorkspaceShortcutLabel}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : null}
        {allowOpenInFileManager ? (
          <DropdownMenuItem
            disabled={Boolean(readOnlyReason)}
            title={readOnlyReason}
            onSelect={handleOpenWorkspaceInFileManager}
          >
            {intl.formatMessage({ id: "appHeader.openInFileExplorer" })}
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuSeparator />

        {/* <DropdownMenuItem onSelect={onToggleTerminal}>
          {intl.formatMessage({ id: "terminal.toggle" })}
          <DropdownMenuShortcut>{formatCommandShortcutLabel("J")}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggleBrowser}>
          {intl.formatMessage({ id: "browser.toggle" })}
        </DropdownMenuItem>

        <DropdownMenuSeparator /> */}

        <DropdownMenuItem onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.ShowAbout)}>
          {intl.formatMessage({ id: "titleBar.menu.help.about" })}
        </DropdownMenuItem>
        {showDesktopUpdateEntry ? (
          <DropdownMenuItem
            disabled={updateState?.enabled === false}
            onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.CheckForUpdates)}
          >
            {intl.formatMessage(
              { id: getUpdateMenuLabelId(updateState) },
              getUpdateMenuLabelValues(updateState),
            )}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.OpenResourceManager)}
        >
          {intl.formatMessage({ id: "titleBar.menu.help.resourceManager" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={helpMenuActions.openIssueReport}>
          {intl.formatMessage({ id: "titleBar.menu.help.feedback" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openFeatureRequest}>
          {intl.formatMessage({ id: "workspaceHeader.help.productRequest" })}
        </DropdownMenuItem>
        {showCommunityMenuItem ? (
          <DropdownMenuItem
            onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.OpenCommunity)}
          >
            {intl.formatMessage({ id: "sidebar.menu.community" })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={helpMenuActions.openProductDocs}>
          {intl.formatMessage({ id: "workspaceHeader.help.docs" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={helpMenuActions.exportLogs}>
          {intl.formatMessage({ id: "titleBar.menu.help.exportLogs" })}
        </DropdownMenuItem>
        {stdioTapDevState.visible ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={stdioTapDevState.enabled}
              onCheckedChange={handleToggleStdioTapDevProxy}
            >
              {intl.formatMessage({ id: "titleBar.menu.help.toggleZCodeStdioTap" })}
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem
              onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.ToggleDevTools)}
            >
              {intl.formatMessage({ id: "titleBar.menu.help.toggleDevTools" })}
            </DropdownMenuItem>
          </>
        ) : null}
        {/* Bugfix: 批量会话压测下线后，Windows 自绘标题栏菜单不能再暴露旧开关。 */}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.CloseWindow)}
        >
          {intl.formatMessage({ id: "titleBar.menu.file.closeWindow" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
