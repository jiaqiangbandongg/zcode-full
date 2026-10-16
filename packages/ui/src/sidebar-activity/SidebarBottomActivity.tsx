import { MarketingBanner } from "@/components/marketing-touch/MarketingTouchProvider.js";
import { useMarketingBannerVisible } from "@/components/marketing-touch/useMarketingBannerVisible.js";
import { GlobalNoticeSurface } from "@/global-notice/GlobalNoticeSurface.js";
import type { GlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";

/**
 * 左下角活动共享槽位的仲裁层：整个 UI 中唯一同时依赖营销触达与全局通知两套系统的地方，
 * 以此把这份耦合收敛到单点，保持两个 feature 模块互不 import（不制造循环依赖）。
 *
 * 纯只读投影，不持有任何状态：领 token banner 可见时独占槽位并覆盖在上；banner 消失/关闭后
 * 才在同一槽位显示 highspeed 分享卡。优先级：领 token banner > highspeed 全局通知。
 * 两者都不可见时 GlobalNoticeSurface 返回 null，槽位不产生多余 DOM。
 */
export function SidebarBottomActivity({
  noticeStore,
}: {
  noticeStore?: GlobalNoticeStore | null;
} = {}) {
  const bannerVisible = useMarketingBannerVisible();
  if (bannerVisible) return <MarketingBanner />;
  // 未注入时走 GlobalNoticeSurface 默认的 browserGlobalNoticeStore。
  return <GlobalNoticeSurface store={noticeStore ?? undefined} />;
}
