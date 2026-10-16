# ApplyPatch Tool

## 定位

`ApplyPatch` 是结构化文件补丁工具，用于多行、多个 hunk 或多文件的可验证编辑。它不是自由文本脚本，也不是 shell 命令。

## 输入契约

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `patch_text` | `string` | 是 | 完整 patch 文本，必须包含 `*** Begin Patch` 和 `*** End Patch` |

支持的文件操作：

- `*** Add File: <path>`：新增文件，后续内容行必须以 `+` 开头。
- `*** Update File: <path>`：更新既有文件，后续一个或多个 `@@` hunk 描述局部修改。
- `*** Move to: <path>`：紧跟在 Update header 后，把更新后的内容写入新路径并删除旧路径。
- `*** Delete File: <path>`：删除既有文件。

Update hunk 语义：

- `@@` 开始一个 hunk；`@@ some context` 可提供额外定位锚点。
- 空格开头的行是上下文行，必须参与旧内容匹配。
- `-` 开头的行是旧行。
- `+` 开头的行是新行。
- `*** End of File` 可作为 EOF 锚点，优先从文件末尾匹配。

## 输出契约

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `files` | array | 每个受影响文件的路径、操作类型、diff、增删行数 |
| `structuredPatch` | array | 所有文件的展示用 diff hunk |
| `summary` | string | 短摘要，例如 `M src/a.ts`、`A src/b.ts` |

模型可见结果只返回短确认和文件摘要；完整 diff 进入结构化 output、权限 UI、事件和 debug 投影。TUI diff preview 与 `Edit` 共用同一套结构化 hunk 投影和 Shiki token 高亮路径，失败时降级为纯文本 diff。

## 行为语义

核心流程：

1. parse patch envelope 和所有文件 section。
2. 规范化相对路径为 session cwd 下的绝对路径。
3. 对所有文件先做 verification，不得边验证边写。
4. Update hunk 在 LF Unicode 逻辑内容中匹配；写回时保留原文件 encoding 和 lineEndings，包括 GB2312 / GBK / GB18030 等 legacy 中文编码。
5. 匹配策略按顺序为 exact、trimEnd、trim、Unicode 标点归一化。不得进行跨文件搜索或开放式语义猜测。
6. 任一 hunk 找不到、路径非法、文件状态不符合操作类型或 parser 失败时，整个 patch 失败且不产生任何文件副作用。
7. 所有 verification 成功后生成每文件 diff，进入 edit 权限审批。
8. 如果任一文件编码不支持、疑似二进制、或 patched content 无法编码回原编码，整次 patch 必须失败且不写入任何文件。
8. 审批通过后再按文件应用写入和删除。

## 权限模型

`ApplyPatch` 和 `Edit` / `Write` 共用 `edit` permission：

- `readOnly=false`
- `destructive=false`
- `concurrentSafe=false`
- `sideEffectScope=workspace`
- `riskLevel=medium`
- `needsApproval=true`

权限 pattern 来源是 patch 中所有受影响路径。

## 校验与错误

必须提供稳定错误码或结构化 context：

- patch 缺少 begin/end marker。
- patch 为空。
- file section header 无效。
- update 目标不存在。
- delete 目标不存在。
- update hunk 找不到 expected lines。
- 多文件 patch 中任一文件 verification 失败。

失败时不得写入已验证成功的其他文件。

## ZCode 设计结论

`ApplyPatch` 解决的是 `Edit.old_string` 容易受行号、tab、换行和长字符串复制影响的问题。它通过结构化 hunk、上下文行和预验证把兼容性限制在局部 diff 中。它不是 Python/sed 替换脚本的替代壳，而是受权限、trace、adapter 和 diff UI 统一管理的一等 tool。
