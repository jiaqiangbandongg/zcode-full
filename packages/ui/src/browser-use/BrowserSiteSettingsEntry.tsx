import { useState } from "react";
import { Settings, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 地址栏左侧的站点设置入口（spec：docs/browser-use/2026-10-08-embedded-browser-permission-governance-spec.md
 * 「站点权限设置标签页」）。恒为滑杆图标、不随权限请求变化；点击弹出站点信息气泡，
 * 唯一操作「权限设置」进入独立设置标签页。URL 聚焦编辑时由地址栏隐藏本入口，
 * 不结算任何待处理权限申请。
 */
export function BrowserSiteSettingsEntry({
  origin,
  onOpenSettings,
}: {
  origin: string;
  onOpenSettings?: (origin: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `browser.permission.${id}` });
  // Bug 原因：弹窗内容渲染在 body portal，而 trigger 在浏览器 tab 的 TabsContent 里。
  // 点「权限设置」后设置标签激活、浏览器 tab 被 display:none（forceMount 不卸载），
  // 若弹窗内容仍在（含 100ms 退出动画的窗口期），floating 锚点会随隐藏 trigger 尺寸
  // 归零，残影塌到窗口左上角。因此这里受控 open，且关闭时直接卸载内容（不播退出
  // 动画），保证弹窗消失与标签切换同帧完成。
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="rounded-full"
          aria-label={t("siteInfo")}
          title={t("siteInfo")}
          data-testid="browser-permission-trigger"
        >
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          align="start"
          collisionPadding={12}
          className="w-80 max-w-[calc(100vw-24px)] gap-4 p-4"
          data-testid="browser-permission-popover"
        >
          <div
            className="min-w-0 flex-1 text-ui-lg font-medium break-words"
            data-testid="browser-permission-origin"
          >
            {origin}
          </div>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            disabled={!onOpenSettings}
            data-testid="browser-permission-open-settings"
            onClick={() => {
              setOpen(false);
              onOpenSettings?.(origin);
            }}
          >
            <Settings className="size-4" />
            {t("settings")}
          </Button>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
