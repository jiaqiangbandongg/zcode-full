# Visualize 回复引用格式

## 输出约定

Visualize skill 要求新建或更新视图时，在本轮最终回复中独占一行输出
`::visualize` 加 JSON 对象，使用执行端提供的会话输出目录中的绝对路径：

```text
::visualize{"path":"/absolute/session-dir/demo.html"}
::visualize{"path":"/absolute/session-dir/demo.html","mode":"wide"}
```

- 保留两个 ASCII 冒号；不生成 Unicode 私用区标记，不省略为裸 `visualize`。
- JSON 只包含 `path`、可选 `title` 和可选 `mode: "wide"`。
- 实际回复中的引用不加反引号、不放进代码块，也不放进进度消息。
- 文件名、HTML 片段、输出目录和完成态要求沿用现有 Gen UI 契约。

## 原因与兼容

模型可能遗漏或写错 Unicode 私用区分隔符，使输出无法被识别为交互视图引用。
新回复统一采用可见的 ASCII 指令前缀，避免生成依赖不可见分隔符的引用。

解析器继续接受已有 Unicode JSON 引用和 `::visualize{path="..."}` 参数格式，
不迁移历史消息，也不放宽路径、参数、代码区排除或消息完成门槛。
本次仅调整 skill 的输出指引；桌面、远程工作区、Web/手机的既有支持范围不变。

## 验证

- 从 skill 提取普通与宽模式示例，替换占位路径后交给现有引用解析器，确认生成 UI 引用。
- 运行 `packages/ui/src/gen-ui/domain/references.test.ts`，覆盖 JSON、历史格式、
  流式完成门槛、代码示例和非法参数。
- 检查 skill 不再包含 Unicode 私用区分隔符或要求新回复使用 Unicode 的指引。
