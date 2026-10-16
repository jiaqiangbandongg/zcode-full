# Queued Prompt Panel Blur Style

## 背景

队列面板位于 composer 上方，并通过 `-mb-7 pb-7` 与输入框形成覆盖衔接。旧样式使用 `shadow-xl/5` 强化层级，但在深色主题下会让队列面板与输入框之间显得像两块独立卡片。

## 目标

- 队列面板不再使用阴影制造层级。
- 队列面板保留 `rounded-t-2xl` 和现有覆盖衔接；v4 迁移时沿用旧仓库队列面板的 `bg-surface backdrop-blur-md`，让面板背景带模糊层级但不再依赖阴影。
- 不修改 composer、permission、elicitation、quota、error banner 等其他底部面板。

## 兼容约束

- 桌面端和手机 Web 端使用同一队列面板样式。
- 深色/浅色主题继续使用语义 surface token，不新增硬编码颜色。
- 不改变 queued prompt 的排序、立即发送、编辑、删除逻辑。
