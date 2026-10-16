# Count Lint Script

`pnpm lint:count` 是开发期代码体量观察脚本，用来统计仓库内 `.ts` 与 `.tsx` 文件的长度。它不改变 lint 规则，也不写入工作区文件，只给维护者提供后续拆分大文件或设定 lint 阈值时的输入。

## 目标

- 从仓库根目录递归统计非测试 `.ts` 和 `.tsx` 文件。
- 输出每个文件的行数、字节数和相对路径。
- 默认按行数从大到小排序，便于优先发现最大文件。
- 不新增环境变量；通过根 `package.json` 的 `lint:count` 脚本运行。
- 使用 Node.js 标准库实现，避免依赖 POSIX shell、`wc`、`find` 或平台特定命令。

## 扫描契约

脚本默认从当前工作目录开始扫描。为了避免生成物和依赖污染统计，递归时跳过：

- `.git`
- `.next`
- `.turbo`
- `build`
- `coverage`
- `dist`
- `node_modules`
- `out`

为了避免开发调试包干扰生产代码体量观察，递归时跳过：

- `packages/debug`

测试文件不计入统计，避免 fixture、fake adapter 和集成场景体量干扰生产代码拆分优先级。脚本跳过：

- 路径任一 segment 为 `tests` 或 `__tests__` 的文件
- 文件名以 `.test.ts`、`.test.tsx`、`.spec.ts` 或 `.spec.tsx` 结尾的文件

脚本不跟随符号链接，避免跨平台符号链接权限差异和循环目录。路径在输出中统一展示为 `/` 分隔的仓库相对路径。

## 输出契约

输出包含：

- 标题：`TypeScript file lengths (.ts, .tsx)`
- 文件总数
- 总行数
- 总字节数
- 表格列：`Lines`、`Bytes`、`File`

空文件计为 `0` 行；只有一个换行符的文件计为 `1` 行；带末尾换行的普通文件不额外多计一行。

## 错误行为

文件系统错误向脚本入口冒泡，并由 CLI 边界输出 `lint:count failed: <message>`，退出码为 `1`。脚本不吞掉底层错误，也不把错误转换成普通统计行。

## 测试覆盖

- 行数统计覆盖空文件、无末尾换行、CRLF 和末尾换行。
- 文件发现覆盖 `.ts`、`.tsx`、测试文件跳过、非 TypeScript 文件、生成目录跳过，以及 `packages/debug` 跳过。
- 格式化覆盖总数、总行数和按行数降序排序。
