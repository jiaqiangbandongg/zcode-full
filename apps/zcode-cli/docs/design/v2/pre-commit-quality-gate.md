# Pre-commit Quality Gate

## 文档定位

本文定义仓库级 Git pre-commit 质量门，成熟度为 `L1 Local Workflow Contract`。它服务于开发提交前的快速防线，不改变运行时 agent loop、tool runtime、权限系统或发布路径。

## 目标

- 在本地提交前自动运行根目录 `pnpm lint`。
- 在 lint 通过后自动运行根目录 `pnpm test`。
- 复用现有 npm scripts，不在 Git hook 中复制 lint 或 test 规则。
- 使用 Husky 管理 Git hooks，保持标准 Node.js CLI 仓库的安装体验。
- 不新增 `ZCODE_` 环境变量，不读取外部配置，不触碰数据库结构。

## 非目标

- 不替代 CI。CI 仍应独立执行 lint、test、typecheck 和发布相关验证。
- 不在 pre-commit 中运行 build、coverage 或端到端测试，避免普通提交路径过重。
- 不绕过用户显式的 Git 操作；维护者仍可使用 Git 原生命令临时跳过 hook。

## 执行契约

pre-commit hook 位于 `.husky/pre-commit`，执行顺序固定为：

1. `pnpm lint`
2. `pnpm test`

任一命令返回非零退出码时，提交失败，并由对应命令输出错误详情。hook 不吞掉错误、不改写退出码、不生成额外文件。

## 安装契约

根 `package.json` 使用 `prepare` 脚本运行 `husky`，确保依赖安装后 Git hook shims 被初始化。Husky 作为根 devDependency 安装，避免各 workspace package 重复声明。

## 跨平台约束

- hook 脚本只调用 `pnpm` 和已有 npm scripts，不使用 POSIX 专属管道、重定向、路径拼接或 shell 字符串组合。
- Git for Windows 通过自带 shell 执行 Husky hook；脚本内容保持最小化，降低 Windows shell 差异。
- 实际 lint/test 逻辑继续由仓库脚本和 Turbo 负责跨平台处理。

## 错误行为

- `pnpm lint` 失败：停止执行，不运行 test，提交失败。
- `pnpm test` 失败：提交失败。
- Husky 未安装或 Git hooks 未初始化：安装依赖时 `prepare` 负责修复；若用户禁用 Git hooks，属于本地 Git 配置行为，不在代码中兜底。

## 测试覆盖

- `npm run lint`
- `npm test`
- 手动验证 `.husky/pre-commit` 可执行并按顺序调用 `pnpm lint` 与 `pnpm test`。
