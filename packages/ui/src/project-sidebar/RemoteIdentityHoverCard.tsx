import { useEffect, useRef, useState, type ReactElement } from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { ChevronRight, Settings } from "lucide-react";
import { Anchor, createPopperScope } from "@radix-ui/react-popper";
import { sourceServerConnectionStateSchema } from "@zcode/shared";
import type { RemoteProjectHost } from "@/project-sidebar/contract.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { RemoteConnectionProgressSection } from "@/project-sidebar/RemoteConnectionProgressSection.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatRemoteProjectConnectionAddress,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";

const CLOSE_DELAY_MS = 100;
const useHoverCardScope = HoverCardPrimitive.createHoverCardScope();
const usePopperScope = createPopperScope();

/**
 * 项目模型迁移曾漏接详情；项目入口只读同一 Host，悬停结束即关闭，不保存点击锁定状态。
 * 待处理设备只提供定位设置的入口，实际处理仍由设置页设备卡完成。
 */
export function RemoteIdentityHoverCard({
  host,
  title,
  projectName,
  deviceName,
  paths,
  connectionError,
  anchorToMenu = false,
  contentClassName,
  onOpenDeviceSettings,
  children,
}: {
  host?: RemoteProjectHost;
  title: string;
  projectName?: string;
  deviceName?: string;
  paths: readonly string[];
  /** 项目行已合并旧 workspace 错误的连接错误；缺省读 Host 投影。 */
  connectionError?: string;
  anchorToMenu?: boolean;
  contentClassName?: string;
  onOpenDeviceSettings?: () => void;
  children: ReactElement;
}) {
  const { intl } = useZCodeIntl();
  const scope = useHoverCardScope(undefined);
  const popperScope = usePopperScope(scope.__scopeHoverCard);
  const trigger = useRef<HTMLAnchorElement>(null);
  // 固定偏移会把不存在的滚动条也算进去；让定位器直接读取菜单外沿，仍以行高确定纵向位置。
  const menuAnchor = useRef({
    get contextElement() {
      return trigger.current ?? undefined;
    },
    getBoundingClientRect() {
      const row = trigger.current;
      if (!row) return new DOMRect();
      const bounds = row.getBoundingClientRect();
      const menu = row.closest('[role="menu"]')?.getBoundingClientRect();
      return menu ? new DOMRect(menu.left, bounds.top, menu.width, bounds.height) : bounds;
    },
  });
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const overDetails = useRef(false);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    cancelClose();
    // Radix 会因文字选区跳过关闭；身份浮层只按离开区域关闭，保留跨区缓冲和复制能力。
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  useEffect(() => {
    // Host 消失或换代时撤销旧浮层，不能在设备重新出现后恢复旧的展示状态。
    setOpen(false);
    overDetails.current = false;
    return () => clearTimeout(closeTimer.current);
  }, [host?.id]);
  if (!host) return children;
  const msg = (id: string) => intl.formatMessage({ id });
  const error = connectionError ?? host.lastConnectionError;
  const presentation = resolveRemoteConnectionPresentation({
    state:
      sourceServerConnectionStateSchema.safeParse(host.lastConnectionStatus).data ??
      host.connectionStatus,
    // 修复原因：缺少 upgradeTarget 时操作名固定回退成“更新远端”，与设置页设备卡矛盾。
    upgradeTarget: host.upgradeTarget,
    projectError: error,
  });
  return (
    <HoverCard
      {...scope}
      open={open}
      onOpenChange={setOpen}
      openDelay={300}
      closeDelay={CLOSE_DELAY_MS}
    >
      <HoverCardTrigger
        {...scope}
        ref={trigger}
        asChild
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onFocus={cancelClose}
        onBlur={(event) => {
          // 菜单移出条目时会把焦点收回容器，这不是离开详情；关闭交给指针移出处理，
          // 同时阻止 Radix 默认失焦关闭，否则鼠标进入详情后仍会被菜单的焦点回收关闭。
          const menu = event.currentTarget.closest('[role="menu"]');
          if (menu && event.relatedTarget === menu) {
            event.preventDefault();
            return;
          }
          // 点击详情文字会让按钮失焦但没有新焦点；仍在详情内时保留选择和复制。
          if (event.relatedTarget || !overDetails.current) scheduleClose();
        }}
      >
        {children}
      </HoverCardTrigger>
      {anchorToMenu && open ? <Anchor {...popperScope} virtualRef={menuAnchor} /> : null}
      <HoverCardContent
        {...scope}
        data-testid="remote-identity-details"
        role="tooltip"
        side="right"
        align="start"
        onPointerEnter={() => {
          overDetails.current = true;
          cancelClose();
        }}
        onPointerLeave={() => {
          overDetails.current = false;
          scheduleClose();
        }}
        className={cn("w-80 max-w-[calc(100vw-2rem)] rounded-xl p-3 text-ui-sm", contentClassName)}
      >
        <div className="flex min-w-0 items-center gap-3 border-b border-border pb-3">
          <strong className="min-w-0 flex-1 break-words font-medium">{title}</strong>
          {/* 修复原因：曾显示 pending 的泛化文案“需要处理”，看不出要更新、安装还是确认身份；改用与项目行一致的短状态。 */}
          <span className={presentation.foreground}>
            {intl.formatMessage({ id: presentation.shortMessageId }, presentation.recovery?.values)}
          </span>
        </div>
        <RemoteConnectionProgressSection host={host} status={presentation.status} error={error} />
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
          {projectName ? (
            <>
              <dt className="text-remote-foreground-muted">{msg("project.name")}</dt>
              <dd className="break-words">{projectName}</dd>
            </>
          ) : null}
          <dt className="text-remote-foreground-muted">{msg("workspaceSidebar.projectDevice")}</dt>
          <dd className="break-words">{deviceName || remoteHostLabel(host)}</dd>
          <dt className="text-remote-foreground-muted">{msg("workspaceSidebar.projectLine")}</dt>
          <dd>{msg(`remote.kind.${host.kind}`)}</dd>
          <dt className="text-remote-foreground-muted">
            {msg("settings.source.connectionAddress")}
          </dt>
          <dd className="break-all font-mono">
            {host.target ? formatRemoteProjectConnectionAddress(host.target) : "—"}
          </dd>
          <dt className="text-remote-foreground-muted">{msg("workspaceSidebar.projectPath")}</dt>
          <dd className="min-w-0 break-all font-mono">
            {paths.map((path) => (
              <div key={path}>{path}</div>
            ))}
          </dd>
        </dl>
        {presentation.status === "pending" && onOpenDeviceSettings ? (
          <button
            type="button"
            data-testid="remote-identity-device-settings"
            className={cn(
              "mt-3 flex w-full items-center gap-1.5 border-t border-border pt-3 text-left hover:underline",
              presentation.foreground,
            )}
            onClick={() => {
              setOpen(false);
              onOpenDeviceSettings();
            }}
          >
            <Settings aria-hidden="true" className="size-3.5" />
            <span className="min-w-0 flex-1 break-words">{msg(presentation.actionMessageId)}</span>
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
