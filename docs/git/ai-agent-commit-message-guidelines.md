# AI Agent Commit Message 规范

更新日期：2026-09-15

## 适用范围

本规范适用于本项目中由 AI Agent 生成或协助生成的所有 Git 提交信息（commit message）与 PR 标题。

目标是与 `Conventional Commits` 保持一致，并参考 Electron 文档中的语义化提交约定，降低历史追溯和发布分发成本。

## 基本格式

提交标题（第一行）必须使用语义前缀：

```text
<type>(<scope>): <subject>
```

说明：

- `<type>`：提交类型，必填
- `<scope>`：影响范围，建议填写（如 `ui`、`services`、`agent`、`git`）
- `<subject>`：简短描述本次变更的结果，使用小写开头

示例：

```text
fix(ui): avoid stale workspace path in git pane
feat(services): add provider config file resolver
docs(git): add ai agent commit message guidelines
```

## 类型约定（与 Electron 语义前缀对齐）

- `fix`：缺陷修复
- `feat`：新功能
- `docs`：文档变更
- `test`：测试补充或修正
- `build`：构建系统相关变更
- `ci`：CI 配置或脚本变更
- `perf`：性能优化（无功能语义变化）
- `refactor`：重构（不新增功能、不修复缺陷）
- `style`：代码风格/格式化（不影响代码语义）
- `chore`：杂项维护（依赖、脚手架、非功能性清理）

## 标题与正文规则

参考 Electron 规范，提交信息应满足：

1. 第一行尽量控制在 50 字符内，最长不超过 72 字符
2. 第一行后保留一个空行
3. 正文按约 72 列换行
4. 提交信息描述 **做了什么 + 为什么**，不要只写“改了哪些文件”

推荐正文结构：

```text
<type>(<scope>): <subject>

Why:
- 背景/问题
- 触发条件或用户影响

What:
- 关键方案 1
- 关键方案 2

Risk:
- 兼容性或回归风险
- 已做的验证（typecheck/lint/test）
```

## AI Agent 专项要求

为保证提交历史可维护，AI Agent 需额外遵守以下规则：

1. 不写过程噪音：不要在 commit message 里写“按提示修改”“根据对话修复”“AI 自动生成”。
2. 不写工具流水账：不要罗列“运行了什么命令”，除非它构成变更价值（如迁移脚本）。
3. 一个提交只表达一个意图：避免把“重构 + 新功能 + 样式调整”混在一个提交里。
4. 修 bug 必须写清根因与修复策略；非显然根因与代码内中文注释保持一致，不为显然修改添加重复注释。
5. PR 标题与最终 squash commit 标题都必须使用语义前缀

## Breaking Change 规则

若引入不兼容变更，在正文或 footer 使用：

```text
BREAKING CHANGE: <impact>
```

示例：

```text
feat(agent): remove legacy provider handshake

BREAKING CHANGE: legacy agent providers before v2 can no longer connect.
```

## 不推荐写法

以下写法会降低历史可读性，禁止使用：

- `update code`
- `fix bug`
- `修改一下`
- `wip`
- `try fix`

## 提交前检查清单

在创建 commit 前，AI Agent 必须确认：

- 提交标题符合 `Conventional Commits`
- 标题与正文能解释“为什么要改”
- 变更范围与 `scope` 一致
- 已通过[根 AGENTS.md](../../AGENTS.md)中适用于本次变更的必要验证；纯文档按文档检查，代码按代码检查，CLI/E2E 按各自范围验证
- 必要验证阻塞或失败时保留工作区改动，不自动提交；已有失败与本次引入的问题分开报告

## 参考

- [Conventional Commits](https://www.conventionalcommits.org/)
- [Electron Commit Message Guidelines](../electron/docs/development/pull-requests.md#commit-message-guidelines)
- 项目规则：[AGENTS.md](../../AGENTS.md)
