# Windows Caption Menu Button

- 仅 Windows 桌面端在原生最小化/最大化/关闭按钮左侧渲染一颗自绘菜单按钮。
- 这颗按钮不替换原生 caption buttons，只补充应用级快捷入口。
- 自绘按钮与原生 caption buttons 的横向边界以 Window Controls Overlay 暴露的
  `titlebar-area-x` / `titlebar-area-width` CSS 环境变量为事实源；窗口宽度减去可用
  titlebar 区域即为右侧原生控制区安全边距。`136px / zoomFactor` 只作为旧 Electron、
  测试环境或环境变量不可用时的兼容 fallback，不能覆盖真实的系统/DPI 几何。
- Windows 自绘 Terminal、侧边栏与下拉菜单按钮的宽度由右侧原生控制区总宽度除以三
  派生，使页面缩放后仍与最小化、最大化、关闭三个原生按钮保持同一列宽；不得把
  固定 `46px` 作为缩放后的最终视觉宽度。
- workspace task header、新任务草稿标题栏和 Settings 标题栏必须复用同一安全区计算；
  在默认缩放、最小 `-3` 档、最大 `+5` 档以及不同 Windows DPI 下，下拉按钮的命中区
  都不得进入原生最小化按钮区域。
- 菜单项优先复用已有平台命令与工作区动作，避免再维护一套并行逻辑。
- 菜单顺序按工作区动作、帮助动作、开发诊断动作、窗口动作分组；帮助分组里在“检查更新”和“问题反馈”之间额外插入分隔线，便于区分系统更新与用户支持动作。
- 帮助与诊断类入口统一复用 `DesktopCommandIds`，避免 Windows caption 菜单和桌面主菜单出现能力漂移。
