# Terminal Theme Tokens

`packages/ui/src/Terminal.tsx` 里的 xterm 主题现在统一从 `packages/ui/src/styles.css` 读取 terminal 专属 token。

当前接入的 token：

- `--color-terminal-bg`
- `--color-terminal-fg`
- `--color-terminal-cursor`
- `--color-terminal-cursor-accent`
- `--color-terminal-selection`
- `--color-terminal-selection-inactive`
- `--color-terminal-black`
- `--color-terminal-red`
- `--color-terminal-green`
- `--color-terminal-yellow`
- `--color-terminal-blue`
- `--color-terminal-magenta`
- `--color-terminal-cyan`
- `--color-terminal-white`
- `--color-terminal-bright-black`
- `--color-terminal-bright-red`
- `--color-terminal-bright-green`
- `--color-terminal-bright-yellow`
- `--color-terminal-bright-blue`
- `--color-terminal-bright-magenta`
- `--color-terminal-bright-cyan`
- `--color-terminal-bright-white`

调整方式：

1. 在 `packages/ui/src/styles.css` 的亮色 `@theme` 和暗色 `.dark` 中修改对应 token。
2. `Terminal` 会在主题切换时重新读取 token 并实时更新 xterm 配色。

设计约束：

- Zai Light 的终端背景和光标反色必须跟随 `--color-background`，避免终端区域硬编码纯白后和工作区背景脱节。默认正文、ANSI 色、选区色仍由 terminal token 单独调校，保证命令输出可读。
- 选区颜色优先使用品牌色低透明度混合，避免在明暗主题下都过重。
- ANSI 16 色优先映射到现有语义色系和 neutral 阶梯，不单独引入零散色值。
