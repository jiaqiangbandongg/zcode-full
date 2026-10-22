import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { RemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { RemoteProjectConnectionDetails } from "@/WorkspaceSidebar/RemoteProjectConnectionDetails.js";

/** 悬停和点击共享一个浮层，锚定项目整行；不让 Tooltip 与菜单竞争焦点。 */
export function RemoteProjectDetailsPopover({
  anchorRef,
  tab,
  deviceName,
  presentation,
  error,
  disabled = false,
  onConnect,
  onDisconnect,
  onEdit,
  onManage,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  tab: WorkspaceTabState;
  deviceName: string;
  presentation: RemoteConnectionPresentation;
  error?: string;
  disabled?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onEdit?: () => void;
  onManage?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const statusId = useId();
  const [mode, setMode] = useState<"hover" | "click" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clicked = useRef(false);
  const anchor = useMemo(
    () => ({
      current: {
        // 虚拟锚点仍需真实行元素，Floating UI 才能订阅侧栏滚动和布局变化。
        get contextElement() {
          return anchorRef.current ?? undefined;
        },
        getBoundingClientRect: () => anchorRef.current?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    [anchorRef],
  );
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = () => {
    clearTimer();
    setMode(null);
  };
  const pin = () => {
    clearTimer();
    clicked.current = true;
    setMode("click");
  };
  useEffect(() => {
    if (disabled) {
      clearTimer();
      setMode(null);
    }
    return clearTimer;
  }, [disabled]);
  const leave = () => {
    clearTimer();
    if (mode === "hover") timer.current = setTimeout(close, 150);
  };
  const action = (callback?: () => void) =>
    callback
      ? () => {
          close();
          callback();
        }
      : undefined;
  return (
    <Popover
      open={!disabled && mode !== null}
      onOpenChange={(open) => {
        clearTimer();
        if (open) clicked.current = true;
        setMode(open ? "click" : null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-remote-project-details-trigger
          aria-describedby={statusId}
          aria-label={intl.formatMessage(
            { id: "workspaceSidebar.connectionDetails" },
            { device: deviceName },
          )}
          className={cn(
            "ml-auto flex h-6 min-w-0 max-w-24 items-center rounded-sm px-1 text-ui-xs",
            presentation.status === "online"
              ? "text-remote-foreground-muted"
              : [presentation.foreground, presentation.surface],
          )}
          onPointerEnter={(event) => {
            clearTimer();
            if (!disabled && !mode && event.pointerType !== "touch") {
              timer.current = setTimeout(() => {
                clicked.current = false;
                setMode("hover");
              }, 400);
            }
          }}
          onPointerLeave={leave}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (mode === "hover") {
              event.preventDefault();
              pin();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
        >
          <span id={statusId} className="sr-only">
            {presentation.recovery
              ? intl.formatMessage({ id: presentation.recovery.messageId }, presentation.recovery.values)
              : intl.formatMessage({ id: presentation.shortMessageId })}
          </span>
          <span className="truncate">
            {presentation.status === "online"
              ? deviceName
              : presentation.recovery
                ? intl.formatMessage(
                    { id: presentation.recovery.shortMessageId },
                    presentation.recovery.values,
                  )
                : intl.formatMessage({ id: presentation.shortMessageId })}
          </span>
        </button>
      </PopoverTrigger>
      {/* Radix 首帧会为 Trigger 自动注册锚点；虚拟锚点必须随后覆盖它，
          否则自动锚点退场后仍指向旧节点，详情会错误定位到窗口原点。 */}
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        data-remote-project-details={tab.workspaceIdentity ?? tab.workspacePath}
        side="right"
        align="start"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-24px)] p-3"
        onPointerEnter={clearTimer}
        onPointerLeave={leave}
        onFocusCapture={pin}
        onOpenAutoFocus={(event) => {
          if (mode === "hover") event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // 详情切换后不夺取新浮层焦点；悬停关闭也不改变原键盘焦点。
          const row = anchorRef.current;
          const active = row?.ownerDocument.activeElement;
          if (
            clicked.current &&
            row &&
            (active === row.ownerDocument.body || row.contains(active ?? null))
          )
            row.focus();
        }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation();
          pin();
        }}
      >
        <RemoteProjectConnectionDetails
          tab={tab}
          deviceName={deviceName}
          presentation={presentation}
          error={error}
          onConnect={action(onConnect)}
          onDisconnect={action(onDisconnect)}
          onEdit={action(onEdit)}
          onManage={action(onManage)}
        />
      </PopoverContent>
    </Popover>
  );
}
