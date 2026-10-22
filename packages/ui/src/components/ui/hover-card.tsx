import * as React from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { cn } from "../lib/utils.js";

function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

// 自定义锚点时 Portal 与内容必须共享 Root 的 scope，才能读取同一浮层的开关与定位上下文。
type HoverCardScopeProps = {
  __scopeHoverCard?: Parameters<ReturnType<typeof HoverCardPrimitive.createHoverCardScope>>[0];
};

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  __scopeHoverCard,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content> & HoverCardScopeProps) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal" {...{ __scopeHoverCard }}>
      <HoverCardPrimitive.Content
        {...{ __scopeHoverCard }}
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 origin-(--radix-hover-card-content-transform-origin) rounded-lg bg-popover p-2.5 text-ui-base/relaxed text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
