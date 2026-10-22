import type { ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";

export function ControlShortcutBadge({ className, style, ...props }: ComponentProps<"kbd">) {
  const apple = isAppleKeyboardPlatform();
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "rounded-md h-4 inline-flex shrink-0 items-center bg-tooltip-tag px-1.5 text-ui-xs font-medium text-tooltip-tag-foreground",
        apple ? "tracking-normal" : "font-mono",
        className,
      )}
      style={{
        ...(apple
          ? {
              fontFamily:
                '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif',
            }
          : {}),
        ...style,
      }}
      {...props}
    />
  );
}
