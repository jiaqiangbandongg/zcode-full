# Subagents Settings Command Style UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Settings 面板里的 subagents 管理 UI 调整为和 commands 设置页一致的布局、密度与交互风格。

**Architecture:** 只调整 `packages/ui` 的 subagents settings 表现层，不改 runtime、service schema 或 subagent 加载语义。列表页复用 commands 的 section/header/search/grouped-list 结构；表单页复用 commands 的 back-to-list/form-card 结构，同时保留 subagent 专属 model、color、tools checkbox 和 system prompt 字段。

**Tech Stack:** React、TypeScript、Tailwind semantic tokens、现有 Button/Input/Select/Switch/Textarea primitives、Vitest SSR UI tests。

## Global Constraints

- 遵守根目录 `DESIGN.md`，使用 semantic tokens 和现有 UI primitives。
- 只对齐 subagents settings UI；不改 CLI runtime、profile 解析、mention provider 或 session 生效时机。
- P0 仍只支持 user/global subagent 创建编辑；built-in agent 只读展示。
- 保留工具多选 checkbox，不回退到 free-form textarea。
- 保持 i18n 文案同步，不硬编码用户可见字符串。
- 不自动提交；只有用户明确允许后才提交 commit。

---

### Task 1: 对齐 Subagents 列表页到 Commands section 风格

**Files:**

- Modify: `packages/ui/src/settings/SubagentsSection.tsx`
- Modify: `packages/ui/test/subagentsSection.test.ts`

**Interfaces:**

- Consumes: `AgentSummary`、`AgentsCapability`、`ISubagentsService`
- Produces: commands-style subagent settings section with grouped dense list rows

- [x] 将列表页外层从整页 `bg-card` 大容器改为 `space-y-4` section。
- [x] 顶部改为左侧描述、右侧 icon ghost actions：新增、打开用户目录、刷新。
- [x] 搜索框使用 commands 同款 `Input size="lg" h-9 rounded-xl`；保留 status filter select。
- [x] 按来源分为 user 与 built-in 两组，使用 `SettingsResourceGroupHeader` 和 `rounded-xl border bg-card + divide-y`。
- [x] 将 `AgentListRow` 改为 dense row：左侧身份/描述/路径，中间 badge 展示 scope/model/tools，右侧 switch/edit/delete actions。
- [x] built-in/readonly agent 不显示编辑删除；user agent 保留 switch、编辑、删除。
- [x] 更新测试断言：不可写时隐藏新增/打开目录，列表按分组展示，工具 checkbox 仍存在。

### Task 2: 对齐 Subagent 表单页到 CommandForm 风格

**Files:**

- Modify: `packages/ui/src/settings/SubagentsSection.tsx`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/test/subagentsSection.test.ts`

**Interfaces:**

- Consumes: `SubAgentConfig`
- Produces: command-style subagent create/edit form

- [x] 表单页使用 commands 同款 `Back to list` link button、标题、说明。
- [x] 表单主体改为 `rounded-xl border bg-card p-4` 的 compact form card。
- [x] 保留 name、description、model、color、tools checkbox、system prompt 字段。
- [x] 将删除操作放在 form footer 左侧；保存/取消按钮放右侧，保持 action hierarchy。
- [x] 补齐 `settings.subagents.addDescription` 与 `settings.subagents.editDescription` i18n。

### Task 3: 验证

**Files:**

- Test: `packages/ui/test/subagentsSection.test.ts`

- [x] 运行 `pnpm vitest run packages/ui/test/subagentsSection.test.ts`。
- [x] 如有类型或 lint 风险，运行相关 package 级校验。
