# Windows Titlebar Menu

## 目标

在 Windows 桌面端启用自绘顶部菜单，将常用的 `File / View / Help` 动作放入工作区顶部栏，同时保留系统窗口控制按钮。

## 实现

- 主窗口在 Windows 上改为 `titleBarStyle: "hidden" + titleBarOverlay`，继续保留 `backgroundMaterial: "acrylic"`。
- 主进程新增统一的 `executeDesktopCommand` 命令入口，原生应用菜单和 renderer 顶部菜单共用同一套动作实现。
- UI 在 `WorkspaceHeader` 中按 Windows/Linux 桌面端条件渲染 `WindowsCaptionMenuButton`，通过 `IPlatformService.executeDesktopCommand()` 调用主进程命令。
- 新任务草稿态不会渲染完整 `WorkspaceHeader`，但 Windows/Linux 桌面端仍需要保留右上角 Terminal 切换按钮和合并菜单按钮。UI 在 shell 外层标题栏区域依次渲染共享的 Terminal 入口与 `WindowsCaptionMenuButton`，只恢复桌面窗口级入口，不恢复 workspace 路径、分支和 task 相关 header 内容。Windows 草稿态合并菜单按钮保持和 session task header 入口一致的尺寸、直角和 hover 样式，但去掉左侧边框，外层不额外绘制 `bg-background-win-alt` 或 `border-b border-border`，避免在透明标题区形成孤立色块。
- Linux 新任务草稿态的合并菜单外层保留 Linux 标题栏 surface 样式，左下角使用 `rounded-bl-xl`，和右侧自绘窗口按钮区域形成同一层级。
- 新任务草稿态在桌面端不渲染完整 `WorkspaceHeader`，但会在相同布局位置渲染轻量 `<header class="h-10 [app-region:drag]">` 作为标题栏拖拽区。该 header 参与主内容纵向布局，避免用 absolute overlay 覆盖 ChatView，同时仍低于右上角窗口菜单的点击层级。
- 检查更新菜单项订阅 `IPlatformService.onUpdateStateChanged()`，并在菜单打开时通过 `IPlatformService.getUpdateState()` 主动拉取当前状态。主进程的 `electron-updater` 状态会通过 `PlatformChannels.UpdateStateChanged` 持续同步到 renderer，因此 Windows 自绘菜单可以和 macOS 原生菜单一样显示检查、下载进度和可重启安装状态。

## 当前菜单项

- 合并菜单：New task、Open Workspace、Open in File Explorer、About ZCode、Check for Updates（检查中/下载中会显示状态与百分比）、Feedback、Community（有可用入口时）、Export Logs、Toggle Developer Tools（开发态）、Resource Manager（资源管理器，开发态）、Close Window

## Windows 工作区外沿

### 产品语义

系统窗口外形由 Windows/DWM 决定，renderer 只负责工作区内容面板。两者不能只按
`isWindowsDesktop` 合并处理，否则 Windows 10 与 Windows 11、普通窗口与最大化窗口会互相污染。

| 系统与窗口状态 | 系统窗口外形 | 工作区内容面板 |
| --- | --- | --- |
| Windows 11 普通窗口 | DWM 原生圆角 | 保持圆角与完整弱边框 |
| Windows 11 最大化 | DWM 外沿为直角 | 内容面板同步改为直角；移除贴窗口外沿的上、右、下边框，只保留左侧分隔 |
| Windows 10 普通/最大化 | 系统原生直角 | 只把贴系统外沿的右侧两角改为直角；保留既有完整弱边框与内部左圆角 |
| Windows 能力未知/IPC 失败 | 尚未确认 | 保持改动前的圆角与完整弱边框，不把未知状态误判为 Windows 10 |
| macOS、Linux、Web、手机 Web | 不属于本功能 | 保持既有样式与响应式覆盖 |

以 Windows build `>= 22000` 作为 Windows 11 原生圆角能力边界。build 与最大化状态由
Electron main 进程读取，通过 preload 和 `IPlatformService` 注入 UI；UI 不直接读取 Node 或
`window.zcode`。

Windows 11 最大化时，renderer 工作区内容面板与 DWM 外轮廓统一使用直角。本功能不通过
伪最大化、窗口 shape 或修改 work area bounds 改变系统窗口形态。

### 状态链路

```text
Windows build ───────────────┐
                             v
BrowserWindow maximize/unmaximize -> main 计算窗口外观状态
                                      |
                                      v
                         preload IPC 查询 + 状态事件
                                      |
                                      v
                           IPlatformService（desktop）
                                      |
                                      v
                           useAppChromeState（UI）
                                      |
                                      v
                     WorkspaceShellLayout 样式矩阵

Web / 手机 Web -> IPlatformService fallback -> 不进入 Windows 样式分支
```

### 影响面与不变量

- 直接影响：desktop main 窗口状态、desktop preload、共享平台接口、工作区 shell 外沿样式。
- 必须检查：Windows 10/11 × 普通/最大化四种组合，以及首次以最大化状态加载窗口的初始化路径。
- 不影响：标题栏按钮命令、Agent/session、桌面 continuous 消息流、手机 remote replayable 恢复链路。
- 不新增持久化：最大化状态由 `BrowserWindow` 实时持有，renderer 首次查询后订阅变化。
- Windows Snap 分屏与系统全屏不等同于 `BrowserWindow.isMaximized()`，本次保持普通窗口样式，
  不宣称改变这些状态的 DWM 外轮廓。

### 验收用例

1. Windows 11 普通窗口仍显示原生窗口圆角，内容面板保持现有圆角与弱边框。
2. Windows 11 最大化后内容面板四角均为直角，窗口外沿不出现额外上、右、下描边。
3. Windows 11 在最大化与还原之间切换时，样式立即跟随且无须刷新。
4. Windows 10 普通与最大化均不模拟右侧外圆角，同时保留原有上、右、下弱边框。
5. 窗口能力查询失败或 bridge 不可用时保持改动前样式，不闪断到 Windows 10 样式。
6. macOS、Linux、Web 与手机 Web 的现有布局和响应式样式不变。
