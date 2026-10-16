import { DesktopWindowControls } from "@/DesktopWindowControls.js";

/** 全页覆盖层会遮住工作区窗控，使用根节点的平台标记恢复 Windows/Linux 的窗口入口。 */
export function DesktopOverlayWindowControls() {
  return (
    <div className="absolute right-1 top-1 z-30 mt-px mr-px hidden h-12 items-center px-2 [app-region:no-drag] platform-windows-desktop:flex platform-linux-desktop:flex">
      <DesktopWindowControls />
    </div>
  );
}
