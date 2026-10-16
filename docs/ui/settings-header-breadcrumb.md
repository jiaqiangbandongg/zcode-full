# Settings 顶部面包屑

## 目标

Settings 内容面板顶部的窗口拖拽区展示当前层级，帮助用户在分区和分区内部详情之间保持位置感。

```text
当前分区 > 分区内部详情...
```

## 产品合同

- 默认一级为当前 Settings section 标题，不显示固定的“设置”根节点。从独立的插件市场进入插件管理时，
  一级允许投影跨越 Settings 边界的来源节点 `Plugin Marketplace`，用于保留用户的返回路径；直接从
  Settings 进入时仍以 `Plugins` 为一级。
- 只有一级时顶栏保持为空；进入二级或更深的页面级导航后才显示面包屑。
- 分区可以追加只读详情层级。Project Memory 依次追加项目名和文件名，形成
  `Memory > 项目 > 文件`。
- 面包屑只投影现有导航状态，不拥有或持久化导航状态。除当前层外，上级层级复用分区既有返回动作，
  点击后回到对应层级；当前层保持只读文本。
- 分隔符使用 `ChevronRight` 和 `text-foreground-subtlest`；上级层使用 `ghost + default` 按钮，默认
  `text-foreground-subtle`、Hover 为 `text-foreground`；末级使用主文本。所有层级单行截断，不能挤占右侧
  Help、Linux caption menu 或 Windows caption controls 的安全区。
- Settings path 容器使用 `px-2.5` 水平内边距，与标题栏紧凑密度保持一致。
- 面包屑层级及分隔符两侧统一使用 `gap-0`，间距由层级内容自身的 padding 提供。
- 当前层文本使用与 `Button size="default"` 相同的 `text-ui-base/relaxed` 字体尺寸、行高和 `px-2`
  水平内边距。
- 面包屑容器保持 `pointer-events-none`，上级按钮单独恢复 `pointer-events-auto` 和 `[app-region:no-drag]`；
  按钮之外的标题栏仍为 `[app-region:drag]`。
- 面包屑达到二级时，隐藏 Settings 外层重复的 section 大标题（例如 `Memory`），并移除详情页原有
  Back 按钮；返回动作统一由面包屑上级按钮承载。一级页面恢复 section 大标题。插件市场来源路径是
  例外：`Plugin Marketplace > Plugins` 的一级是外部来源而非当前 section，因此内容区继续显示
  `Plugins` 大标题，确保进入插件管理后当前页面标题明确；进入插件、MCP 或 Skill 详情后仍保留
  `Plugins` 中间层级。
- Command、Subagent、MCP、Hook 的新建/编辑当前内容标题使用 `text-ui-xl`。
- Model Settings 和 Usage Stats 不使用面包屑；它们始终保留内容区的大标题。Model Settings
  的内部供应商导航和 Usage Stats 的 Tab 都属于同页切换，不提升为页面层级。
- Desktop、普通 Web 和 Mobile 复用相同层级语义；非 Electron 环境忽略 app-region 样式即可。

## 状态链路

```text
SettingsPage.activeSection ----------------+
                                           |
active section page-level navigation state +--> breadcrumb items --> header
```

子层级仅在所属 section 激活时参与展示。切换分区后旧详情不得泄漏到其他 section。

## 覆盖范围

- Memory：项目、文件。
- 插件：插件详情、已安装插件管理；详情当前层名称与列表卡片、详情标题统一使用本地化展示名称，不使用内部 canonical name。没有配置 `displayName` 时，将 `cloudbase-skills` 这类 `-` / `_` 分隔名称格式化为 `Cloudbase Skills`。直接进入插件设置时路径以 `Plugins` 开始；从插件市场进入时以 `Plugin Marketplace` 开始，并在管理页及其插件、MCP、Skill 子页面保留 `Plugins` 中间层级。
- Subagents、MCP、Commands、Hooks：新建或编辑页。
- 自动化：定时任务和闲时任务的新建或编辑页。
- Model Settings 的供应商/套餐导航、Usage Stats 的 Tab，以及独立 Skills 分区的详情、确认框、授权、同步、搜索、筛选、scope 和表单内部 Tab 不是页面层级，不进入面包屑。Plugins 内的 Skill tab 详情属于插件管理子页面，按插件路径进入面包屑。

## 验收

| ID    | Setup            | Action             | Assertions                                 |
| ----- | ---------------- | ------------------ | ------------------------------------------ |
| SHB01 | Settings General | 打开设置           | 顶栏不显示面包屑，保留拖拽区和右侧安全边距 |
| SHB02 | Memory 项目列表  | 打开 Memory        | 顶栏不显示面包屑                           |
| SHB03 | Memory 项目详情  | 点击项目           | 显示 `Memory > 项目名`                     |
| SHB04 | Memory 文件正文  | 点击文件           | 追加文件名                                 |
| SHB05 | Memory 详情      | 返回或切换 section | 面包屑同步收缩，不残留旧层级               |
| SHB06 | Memory 文件正文  | 点击项目按钮       | 返回项目文件列表，面包屑收缩为两级         |
| SHB07 | 任意二级页面     | 点击 section 按钮  | 复用该分区返回动作回到一级页面             |
| SHB08 | 任意二级页面     | 进入详情           | 隐藏外层 section 大标题，不显示重复 Back   |
| SHB09 | Model Settings   | 切换供应商或套餐   | 顶栏无面包屑，内容区持续显示大标题         |
| SHB10 | Usage Stats      | 切换用量 Tab       | 顶栏无面包屑，内容区持续显示大标题         |
| SHB11 | Settings 插件列表 | 打开插件详情       | 显示 `Plugins > Example Plugin`            |
| SHB12 | 插件市场         | 打开市场插件详情   | 显示 `Plugin Marketplace > Example Plugin` |
| SHB13 | 插件市场         | 点击管理已安装     | 显示 `Plugin Marketplace > Plugins`，内容区保留 `Plugins` 大标题 |
| SHB14 | 市场来源插件管理 | 打开插件、MCP 或 Skill 子页面 | 显示 `Plugin Marketplace > Plugins > 当前页`；点击 `Plugins` 返回管理页 |
