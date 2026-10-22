import type { BottomSheetProps, BottomSheetContentProps } from "@/components/mobile-ui/contract.js";
import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/components/lib/utils.js";

/**
 * 手机端底部弹层：沿用 Radix Dialog 的焦点圈定、Esc 关闭与可访问名称，只把内容贴底展示。
 * 用于远控设备页的多连接选择、任务首页的新建任务工作区选择等二级选择。
 */
function BottomSheet(props: BottomSheetProps) {
  return <DialogPrimitive.Root data-slot="bottom-sheet" {...props} />;
}

function BottomSheetTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="bottom-sheet-trigger" {...props} />;
}

function BottomSheetClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="bottom-sheet-close" {...props} />;
}

// 设备选择层是 Dialog；旧实现误用卡片表面和圆角，深浅主题都应复用弹窗 token。
function BottomSheetContent({ className, children, ...props }: BottomSheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="bottom-sheet-overlay"
        className="fixed inset-0 z-50 bg-black/45 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
      />
      <DialogPrimitive.Content
        data-slot="bottom-sheet-content"
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl border-t border-popover-border bg-popover pb-[calc(env(safe-area-inset-bottom)+12px)] text-foreground shadow-2xl outline-none duration-200 data-open:animate-in data-open:slide-in-from-bottom data-closed:animate-out data-closed:slide-out-to-bottom",
          className,
        )}
        {...props}
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-foreground-subtlest"
        />
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function BottomSheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="bottom-sheet-header" className={cn("px-4 pb-2 pt-3", className)} {...props} />
  );
}

function BottomSheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="bottom-sheet-title"
      className={cn("text-ui-lg font-semibold", className)}
      {...props}
    />
  );
}

function BottomSheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="bottom-sheet-description"
      className={cn("mt-1 text-ui-sm text-foreground-subtle", className)}
      {...props}
    />
  );
}

export {
  BottomSheet,
  BottomSheetClose,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetTrigger,
};
