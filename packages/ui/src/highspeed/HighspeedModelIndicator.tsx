import { motion, useReducedMotion } from "motion/react";
import lightningIconUrl from "@/assets/highspeed/lightning.svg";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const HIGHSPEED_MODEL_TRANSITION = {
  duration: 0.4,
  ease: [0.55, 0, 0.45, 1],
} as const;

export function HighspeedModelIndicator({
  model,
  originalModel,
  sweepActive,
  animateEntrance,
}: {
  model: string;
  originalModel: string;
  sweepActive: boolean;
  /** 仅 draw 新命中时播放翻页入场；切回或恢复时直接呈现静止标识。 */
  animateEntrance: boolean;
}) {
  const { intl } = useZCodeIntl();
  const reducedMotion = useReducedMotion();
  const label = `${model.trim()} HighSpeed`;
  const originalModelLabel = intl.formatMessage(
    { id: "chat.highspeed.originalModel" },
    { model: originalModel },
  );

  return (
    <ControlHintTooltip title={originalModelLabel}>
      <span
        aria-label={label}
        data-highspeed-model-indicator="true"
        className="inline-flex h-7 min-w-0 shrink items-center gap-1 overflow-hidden rounded-lg px-2 text-ui-caption text-icon-purple whitespace-nowrap @max-xl/composer:size-7 @max-xl/composer:justify-center @max-xl/composer:gap-0 @max-xl/composer:p-0"
      >
        <motion.span
          className="inline-flex min-w-0 items-center gap-1 [perspective:240px] text-ui-caption"
          initial={
            reducedMotion || !animateEntrance
              ? false
              : { opacity: 0, transform: "translateY(75%) rotateX(-55deg)" }
          }
          animate={{ opacity: 1, transform: "translateY(0) rotateX(0deg)" }}
          transition={HIGHSPEED_MODEL_TRANSITION}
        >
          <img
            src={lightningIconUrl}
            alt=""
            aria-hidden="true"
            data-highspeed-model-icon="true"
            className="pointer-events-none size-4 shrink-0"
          />
          <span
            className={cn(
              "hidden min-w-0 truncate @xl/composer:inline-flex",
              "highspeed-model-trigger-label-sweep",
              sweepActive && "is-sweep-active",
            )}
          >
            {label}
          </span>
        </motion.span>
      </span>
    </ControlHintTooltip>
  );
}
