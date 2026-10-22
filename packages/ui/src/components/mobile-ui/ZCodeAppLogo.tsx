import type { ZCodeAppLogoProps } from "@/components/mobile-ui/contract.js";
import { cn } from "@/components/lib/utils.js";
import appLogoUrl from "@/assets/provider-icons/logo-zai.svg";

/**
 * 桌面端标题栏左上角同款应用 logo（圆角方块 + Z 字形，自带底色，深浅主题通用）。
 * 装饰性图片：调用方负责在旁边给出可读的品牌文字，避免屏幕阅读器重复朗读。
 */
export function ZCodeAppLogo({ className }: ZCodeAppLogoProps) {
  return (
    <img
      src={appLogoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      // 稳定的测试/E2E 钩子：打包器可能把 SVG 内联为 data URL，不能靠文件名断言。
      data-app-logo="zcode"
      className={cn("shrink-0 select-none object-contain", className)}
    />
  );
}
