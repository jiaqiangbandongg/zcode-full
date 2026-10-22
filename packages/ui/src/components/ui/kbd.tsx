import { ControlShortcutBadge } from "@/ControlShortcutBadge.js";
import { cn } from "@/components/lib/utils.js";

/** 每个按键保留独立键帽，复用全应用快捷键提示的样式与平台字体。 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <ControlShortcutBadge
      // 原因：旧键帽使用未定义的 muted 色彩 token，实际渲染透明；统一复用共享快捷键徽标。
      className={cn("pointer-events-none min-w-4 select-none justify-center gap-1", className)}
      {...props}
    />
  );
}

/** 键帽组合容器：把一次组合的多个键横排（gap-1），如 ⌘ + K。 */
function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
