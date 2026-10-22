import { ZCodeAppLogo } from "@zcode/ui/app-logo";

/** 连接前各页的页头品牌：桌面端同款 logo 图标 + “ZCode”文字，纯静态标识，不可点击。 */
export function WebRemoteControlBrand({ className }: { className?: string }) {
  return (
    <span className={["inline-flex items-center gap-2", className].filter(Boolean).join(" ")}>
      <ZCodeAppLogo className="size-5" />
      <span className="text-ui-xs font-medium">ZCode</span>
    </span>
  );
}
