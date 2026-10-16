# Settings 资源列表行导航

## 范围

Settings 中 Commands、Subagents、MCP Servers、Hooks 四类资源列表统一使用整行作为编辑入口，不再展示独立的编辑图标按钮。Memory 的项目行和文件行以及 Skills 的详情入口同样遵循列表下钻交互。

## 交互约束

- 仅 ZCode 管理且可编辑的资源行可打开编辑页；内置、插件托管和兼容来源保持只读。
- 鼠标点击可编辑行的非操作区域时打开对应编辑页。
- 可编辑行可聚焦，并支持 `Enter`、`Space` 打开编辑页。
- 行内开关、删除、授权、模型选择等控件保持独立操作，点击或键盘操作不得触发行导航。
- 可编辑行显式使用 `cursor-default` 保持普通箭头光标，并统一使用 `hover:bg-hover` 反馈；只读行不伪装成可点击入口。
- 桌面端与手机 Web 端使用同一套行交互，不依赖 hover 才能发现入口。
- 所有可下钻的 Memory 项目行和文件行使用与其他资源行一致的普通箭头光标。
- Memory 的项目主区域和文件行使用 `div[role="button"][tabindex="0"]`，并复用资源行的 Enter / Space 键盘激活逻辑；项目行右侧 File Tree 保持独立 Button。

## 编辑页删除入口

- Command、Subagent、MCP Server、Hook 的现有资源编辑页统一在表单底部展示删除入口，创建页不展示。
- 删除入口参考 Subagent：左侧使用 `Button variant="link" size="lg"`、`px-0 text-destructive hover:text-destructive` 和 `Trash2 size-3.5`；Save、Cancel 操作组保持右对齐。
- 列表行不再重复展示删除按钮。删除仍经过各资源既有确认弹窗，成功后返回列表。

## Subagent 行信息

- Subagent 已按 User、Plugin、Built-in 分组，行内不再重复展示作用域标签。
- 行内继续展示模型（非内置项）、工具、描述、路径和对应操作。
