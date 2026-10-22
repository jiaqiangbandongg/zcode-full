import { cn } from "@/components/lib/utils.js";
import { ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";

export function WindowsTopLeftLogo({
  className,
  imageClassName,
}: {
  className?: string;
  imageClassName?: string;
}) {
  return (
    <div
      className={cn(
        // Logo 底座和外部占位统一为 20px，保留原中心点（27px / 29px）。
        "absolute left-1 top-1 mt-px ml-px z-20 flex h-12 items-center px-3 [app-region:drag]",
        className,
      )}
    >
      <span
        role="img"
        aria-label="ZCode"
        data-testid="settings-logo"
        className={cn(
          "pointer-events-none flex size-5 items-center justify-center select-none",
          imageClassName,
        )}
      >
        <ZCodeStartupLogoBadge size="titlebar" animated={false} />
      </span>
    </div>
  );
}
