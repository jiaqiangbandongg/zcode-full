# Workspace Sidebar Footer

## 目标

统一 workspace 侧边栏与 Settings 侧边栏底部的账号区交互，避免两处入口行为不一致。

## 当前行为

- 未登录时，头像区和文案都显示为 `Login`，点击会直接打开登录弹窗。
- 已登录时，头像区展示当前用户名，不再把头像区当作登录入口。
- 收到宿主 `update-ready` 事件后，设置按钮左侧会显示一颗 `Update` 按钮。
- 设置按钮打开统一的下拉菜单，包含语言、主题，以及登录/退出登录操作。
- 在 Settings 侧边栏底部复用同一个 footer 组件，但菜单里不再重复展示“设置”入口。
- Coding Plan `Usage Remaining` 不再出现在 footer 头像菜单中：
  - footer 头像菜单只保留账号、偏好设置、升级/续费和登录/退出等操作入口。
  - 升级/续费入口始终显示；当前上下文无法解析 provider 时默认进入 Z.ai Coding Plan。
  - 剩余额度详情保留在 Usage 页和聊天输入框 context 浮层，避免同一信息在头像菜单里形成重复入口。
  - 套餐 badge 仅在展开后的账号菜单顶部、用户名旁展示；侧边栏底部触发入口仅显示头像和用户名。badge 本身不打开剩余额度面板。

## 用户 ID 展示与复制

- 点击侧边栏底部头像或用户名打开菜单，已登录时顶部展示账号信息：左侧头像，右侧第一行用户名及紧随其后的套餐标识、第二行「ID: {id}」和紧随其后的独立复制图标按钮；随后使用分隔线接语言、主题等原有菜单。底部不再保留独立的复制 ID 菜单项。套餐复用 footer 既有权益状态与 badge，无有效套餐时不显示，不增加请求或状态。菜单内套餐标识使用浅边框、透明底色和常规字重；账号区两行不加额外间距，上下内边距为 6px。
- ID 使用 `text-ui-sm` 字号和次要文字颜色，中英文均使用「ID: {id}」，无 tag 背景；ID 文本点击不触发复制，仅旁边的图标按钮复制，支持鼠标、触屏和键盘激活，悬停提示「点击复制用户 ID」。复制按钮默认透明，仅悬停或键盘可见焦点时显示底色，保持原有点击区域。长用户名及 ID 单行省略，复制值始终为完整 ID。
- 头像、用户名和 ID 复用 footer 的 `user`，不额外请求账号数据或持久化 ID。未登录时隐藏整个账号头部与其分隔线；ID 为空时仅隐藏 ID 行。
- 复制复用浏览器 Clipboard API，与现有 UI 复制操作一致：点击复制按钮 → 写入剪贴板 → 成功后提示「用户 ID 已复制」；不可用或写入失败时提示「复制失败，请重试」，不误报成功。
- 中文和英文、桌面和手机 Web、Zai Light 和 Zai Dark 均保持一致行为。
- 验收：仅图标按钮复制、点击 ID 不复制、套餐与用户名同行、完整 ID 复制、长 ID 截断但复制完整、键盘激活、未登录/空 ID 隐藏、剪贴板拒绝和不可用提示失败。
- 浏览器候选用例：`packages/ui/test/browser/manual-review/pending/sidebar-user-id.test.mjs`（真实 footer 组件，账号与平台数据使用 fixture；不等同 Electron 宿主验收）。

## 实现位置

- 账号区组件：`packages/ui/src/WorkspaceSidebarFooter.tsx`
- Settings 侧边栏挂载：`packages/ui/src/SettingsPage.tsx`
- 登录弹窗入口透传：`packages/ui/src/Root.tsx`
- 用量展示：`packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx`
