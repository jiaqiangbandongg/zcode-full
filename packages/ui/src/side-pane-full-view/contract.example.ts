/**
 * side-pane-full-view 标准调用示例：壳层只通过 controller 发命令，显隐全部从 fullView 只读派生。
 */
import type {
  SidePaneFullViewController,
  SidePaneFullViewHostMode,
} from "@/side-pane-full-view/contract.js";

export function exampleSidePaneFullView(controller: SidePaneFullViewController): {
  mode: SidePaneFullViewHostMode;
  sidebarVisible: (isSidebarVisible: boolean) => boolean;
} {
  // 面板 tab 被激活时切回面板 surface；对话 tab / 菜单「在完整视图中打开」切到对话 surface。
  controller.setSurface("side-pane");
  const fullView = controller.fullView;
  return {
    mode: !fullView ? "normal" : fullView.surface === "conversation" ? "conversation" : "floating",
    sidebarVisible: (isSidebarVisible) => isSidebarVisible && fullView === null,
  };
}
