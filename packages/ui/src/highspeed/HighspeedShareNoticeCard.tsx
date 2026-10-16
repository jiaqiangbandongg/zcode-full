import { useEffect, useState, type CSSProperties } from "react";
import { CopyIcon, EyeIcon, XIcon, ZapIcon } from "lucide-react";
import { animate, motion, useReducedMotion } from "motion/react";
import shareCardDarkBackgroundUrl from "@/assets/highspeed/share-card.svg";
import shareCardLightBackgroundUrl from "@/assets/highspeed/share-card-light.svg";
import shareDialogNoiseUrl from "@/assets/highspeed/share-dialog-noise.png";
import shareDialogNoiseLightUrl from "@/assets/highspeed/share-dialog-noise-light.png";
import zaiLogoUrl from "@/assets/highspeed/zai-logo.png";
import { Button } from "@/components/ui/button.js";
import { ZCodeWordmarkLogo } from "@/components/ui/ZCodeAboutLogo.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { GlobalNoticeEnvelope } from "@/global-notice/globalNoticeStore.js";
import {
  copyHighspeedCardImage,
  copyHighspeedShareText,
  formatHighspeedDurationShort,
  highspeedSavedPercent,
  highspeedSpeedup,
  isHighspeedShareEligible,
  isHighspeedShareNoticePayload,
  resolveHighspeedShareNoticeMetrics,
} from "@/highspeed/highspeedShare.js";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";

export function HighspeedShareNoticeCard({
  notice,
  onDismiss,
}: {
  notice: GlobalNoticeEnvelope;
  onDismiss: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const payload = isHighspeedShareNoticePayload(notice.payload) ? notice.payload : null;
  if (!payload) return null;
  // Bug 根因：此前由秒级取整字段重建指标再复检资格，边界倍率被系统性低估而隐藏 View（spec §9）。
  // 现在与发布门禁共用同一份毫秒事实，复检只能与发布判定一致，纵深防御不再误伤已发布的卡。
  const metrics = resolveHighspeedShareNoticeMetrics(payload);
  const shareEligible = isHighspeedShareEligible(metrics);
  const openDetails = () => setOpen(true);
  return (
    <>
      <div className="highspeed-sidebar-share-card-frame">
        <section
          className="highspeed-sidebar-share-card"
          aria-label={intl.formatMessage({ id: "globalNotice.highspeed.title" })}
          data-global-notice-type="highspeed-share"
          role="group"
        >
          {/* Bug 原因：旧实现把设计稿背景拆成多个近似图层，主题切换时容易重复叠加或丢失描边。
           * 直接使用设计交付的完整主题底图，前景元素仍按 Figma 坐标独立渲染。 */}
          <img
            src={shareCardLightBackgroundUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="highspeed-sidebar-share-card__background highspeed-sidebar-share-card__background--light"
            data-highspeed-card-background="light"
          />
          <img
            src={shareCardDarkBackgroundUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="highspeed-sidebar-share-card__background highspeed-sidebar-share-card__background--dark"
            data-highspeed-card-background="dark"
          />
          <div className="highspeed-sidebar-share-card__content">
            <div className="highspeed-sidebar-share-card__title" role="img" aria-label="ZCode">
              <ZCodeWordmarkLogo className="highspeed-sidebar-share-card__wordmark" />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={intl.formatMessage({ id: "globalNotice.highspeed.close" })}
              className="highspeed-sidebar-share-card__close absolute right-2.5 top-2.5 z-2 rounded-full text-foreground-subtle hover:bg-hover hover:text-foreground focus-visible:ring-foreground/50"
              onClick={onDismiss}
            >
              <XIcon aria-hidden="true" />
            </Button>
            {shareEligible ? (
              <Button
                type="button"
                variant="ghost"
                aria-label={intl.formatMessage({ id: "globalNotice.highspeed.view" })}
                className="highspeed-sidebar-share-card__view"
                onClick={openDetails}
              >
                <EyeIcon aria-hidden="true" className="size-3" strokeWidth={2} />
                {intl.formatMessage({ id: "globalNotice.highspeed.view" })}
              </Button>
            ) : null}
            <div className="highspeed-sidebar-share-card__model">
              <ZapIcon aria-hidden="true" className="highspeed-sidebar-share-card__model-icon" />
              <span className="highspeed-sidebar-share-card__model-text">GLM-5.3-Highspeed</span>
            </div>
            <div className="highspeed-sidebar-share-card__description">
              {intl.formatMessage({ id: "globalNotice.highspeed.sidebarTagline" })}
            </div>
          </div>
        </section>
      </div>
      <HighspeedShareDialog metrics={metrics} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** 数字从 0 增长到目标值；reduced-motion 或禁用时直接呈现终值。节奏与卡片各区块的 fade-up 交错对齐。 */
function useCountUpNumber(
  target: number,
  { enabled, delayMs, durationMs }: { enabled: boolean; delayMs: number; durationMs: number },
) {
  const [value, setValue] = useState(enabled ? 0 : target);
  useEffect(() => {
    if (!enabled) {
      setValue(target);
      return;
    }
    setValue(0);
    const controls = animate(0, target, {
      duration: durationMs / 1000,
      delay: delayMs / 1000,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: setValue,
    });
    return () => controls.stop();
  }, [target, enabled, delayMs, durationMs]);
  return value;
}

export function HighspeedShareDialog({
  metrics,
  open,
  onOpenChange,
}: {
  metrics: {
    outputTokens: number;
    durationMs: number;
    regularTps: number;
    highspeedTps: number;
    savedDurationMs?: number;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = useReducedMotion();
  const speedup = highspeedSpeedup(metrics);
  const savedDurationMs = metrics.savedDurationMs ?? calculateHighspeedSavedDurationMs(metrics);
  const savedSeconds = Math.max(0, Math.round(savedDurationMs / 1_000));
  // Bug 原因：此前写成 1 - highspeedTps/regularTps，结果恒为负数被 clamp 成 0%。
  const savedPercent = highspeedSavedPercent(metrics);
  // 倍数与百分比在弹窗入场时从 0 增长到目标值；节奏对齐各自区块 fade-up 的 230ms/300ms 延迟。
  const countUpEnabled = open && !prefersReducedMotion;
  const speedupCount = useCountUpNumber(speedup, {
    enabled: countUpEnabled,
    delayMs: 230,
    durationMs: 900,
  });
  const savedPercentCount = useCountUpNumber(savedPercent, {
    enabled: countUpEnabled,
    delayMs: 300,
    durationMs: 900,
  });
  const copyImage = () =>
    void copyHighspeedCardImage(metrics, undefined, {
      benefit: intl.formatMessage({ id: "globalNotice.highspeed.badge" }),
      standardSpeed: intl.formatMessage({ id: "globalNotice.highspeed.standardTaskSpeed" }),
      speedSummary: intl.formatMessage(
        { id: "globalNotice.highspeed.speedSummary" },
        { duration: formatHighspeedDurationShort(metrics.durationMs) },
      ),
      lessWaiting: intl.formatMessage(
        { id: "globalNotice.highspeed.lessWaiting" },
        { percent: savedPercent },
      ),
      imageSummary: intl.formatMessage(
        { id: "globalNotice.highspeed.imageSummary" },
        { tokens: Math.floor(metrics.outputTokens).toLocaleString(), duration: savedSeconds },
      ),
    })
      .then(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.imageCopied" })))
      .catch(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.imageCopyFailed" })));
  const shareText = intl.formatMessage(
    { id: "globalNotice.highspeed.copySummary" },
    { tokens: metrics.outputTokens.toLocaleString(), duration: savedSeconds },
  );
  const copyText = () =>
    void copyHighspeedShareText(shareText)
      .then(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.textCopied" })))
      .catch(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.textCopyFailed" })));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Bug 原因：Radix Presence 等 overlay/content 的退出 CSS 动画 animationend 才卸载，且无超时兜底；
       * Electron 窗口不可见时 compositor 停摆，animationend 永不触发，bg-black/60 遮罩无限滞留，
       * 把左下角查看按钮罩灰并吞掉点击。关闭态由 highspeed-share.css 强制 animation:none，
       * Radix 检测不到动画名即同步卸载（tw-merge 不合并 tw-animate 的 animate-out，类名方案不可靠）。 */}
      <DialogContent
        className="highspeed-share-dialog__content"
        overlayClassName="highspeed-share-dialog__overlay"
        showCloseButton={false}
      >
        <motion.section
          className="highspeed-share-dialog__card"
          data-highspeed-share-dialog-card="true"
          initial={
            prefersReducedMotion
              ? false
              : { opacity: 0, rotateY: -72, rotateX: 4, scale: 0.9, y: 10 }
          }
          animate={{ opacity: 1, rotateY: 0, rotateX: 0, scale: 1, y: 0 }}
          transition={{ duration: 0.68, ease: [0.22, 1, 0.36, 1] }}
          style={{ transformOrigin: "50% 50%", transformPerspective: 1200 }}
        >
          <div
            className="highspeed-share-dialog__noise highspeed-share-dialog__noise--dark"
            style={{ backgroundImage: `url(${shareDialogNoiseUrl})` }}
            aria-hidden="true"
          />
          <div
            className="highspeed-share-dialog__noise highspeed-share-dialog__noise--light"
            style={{ backgroundImage: `url(${shareDialogNoiseLightUrl})` }}
            aria-hidden="true"
          />
          <div className="highspeed-share-dialog__header">
            <div className="highspeed-share-dialog__brand">
              <span className="highspeed-share-dialog__logo" aria-hidden="true">
                <img src={zaiLogoUrl} alt="" draggable={false} />
              </span>
              <span className="highspeed-share-dialog__benefit">
                {intl.formatMessage({ id: "globalNotice.highspeed.badge" })}
              </span>
              <span className="highspeed-share-dialog__pill">
                {intl.formatMessage({ id: "chat.highspeed.statusTag" })}
              </span>
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({ id: "globalNotice.highspeed.close" })}
                className="highspeed-share-dialog__close"
              >
                <XIcon aria-hidden="true" />
              </Button>
            </DialogClose>
          </div>
          <DialogTitle className="sr-only">
            {intl.formatMessage({ id: "globalNotice.highspeed.title" })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {intl.formatMessage({ id: "globalNotice.highspeed.tagline" })}
          </DialogDescription>
          <div className="highspeed-share-dialog__metric">
            <span className="highspeed-share-dialog__metric-value">
              {speedupCount.toFixed(1)}
              <span className="highspeed-share-dialog__metric-suffix"> x</span>
            </span>
            <span className="highspeed-share-dialog__metric-label">
              {intl.formatMessage({ id: "globalNotice.highspeed.standardTaskSpeed" })}
            </span>
          </div>
          <div className="highspeed-share-dialog__stats">
            <div className="highspeed-share-dialog__stats-header text-ui-sm">
              <span className="highspeed-share-dialog__stats-label">
                <ZapIcon aria-hidden="true" fill="currentColor" strokeWidth={0} />
                {intl.formatMessage(
                  { id: "globalNotice.highspeed.speedSummary" },
                  { duration: formatHighspeedDurationShort(metrics.durationMs) },
                )}
              </span>
              <span className="highspeed-share-dialog__saved text-ui-sm">
                {intl.formatMessage(
                  { id: "globalNotice.highspeed.lessWaiting" },
                  { percent: Math.round(savedPercentCount) },
                )}
              </span>
            </div>
            <div
              className="highspeed-share-dialog__chart"
              aria-hidden="true"
              style={
                {
                  "--highspeed-share-fast-width": `calc(${Math.max(1, 100 - savedPercent)}% + 1px)`,
                  "--highspeed-share-marker-left": `calc(${Math.max(1, 100 - savedPercent)}% + 1px)`,
                } as CSSProperties
              }
            >
              <span
                className="highspeed-share-dialog__chart-bars highspeed-share-dialog__chart-bars--baseline"
                aria-hidden="true"
              />
              <span
                className="highspeed-share-dialog__chart-bars highspeed-share-dialog__chart-bars--fast"
                aria-hidden="true"
              />
              <span className="highspeed-share-dialog__chart-marker" />
            </div>
            <div className="highspeed-share-dialog__actions">
              <button
                type="button"
                className="highspeed-share-dialog__url"
                onClick={copyText}
                title={shareText}
                aria-label={shareText}
              >
                <span>{shareText}</span>
                <CopyIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                className="highspeed-share-dialog__download"
                onClick={copyImage}
              >
                {intl.formatMessage({ id: "globalNotice.highspeed.copyImage" })}
              </button>
            </div>
          </div>
        </motion.section>
      </DialogContent>
    </Dialog>
  );
}
