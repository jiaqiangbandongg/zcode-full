# CI Build Platform Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 GitLab pipeline 可通过可选的 `ZCODE_BUILD_PLATFORMS` 完整 token 列表选择自动打包平台，未传时保持六个平台全自动，未选平台保留为非阻塞手动 job。

**Architecture:** 在 `.gitlab/ci/30-build.yml` 定义六个按平台拆分的隐藏 rules 模板，各 job 通过 GitLab `!reference` 复用。相同平台规则应用到安装包 build、macOS CUA Helper 与飞书通知，避免未打包平台仍自动构建 helper 或发送通知；仅 MR、web、API pipeline 支持裁剪，tag 与 `ci/*` 发布链路保持全平台自动。

**Tech Stack:** GitLab CI YAML、Vitest、TypeScript 文本契约测试。

---

## 文件结构

- 修改 `packages/desktop/test/gitlabCiBuildGraph.test.ts`：验证六个平台的完整 token、缺省自动、未命中手动契约，以及 macOS helper/各平台通知复用对应规则。
- 修改 `.gitlab/ci/30-build.yml`：定义平台 rules 模板，并让六个 build job 与两个 CUA Helper job引用。
- 修改 `.gitlab/ci/40-notarize-notify.yml`：让六个通知 job 复用对应平台 rules，保留 sandbox/test-tag 禁止通知的既有优先级；未选平台的通知保留非阻塞手动入口，并通过 `needs` 等待对应手动 build。

### Task 1: 添加失败的 CI 图契约测试

- [x] 在 `packages/desktop/test/gitlabCiBuildGraph.test.ts` 增加辅助断言，读取各平台 job 的 `rules` 引用。
- [x] 增加六个平台规则模板测试：断言 `ZCODE_BUILD_PLATFORMS` 为 null/空字符串时 `on_success`，用 `(^|,)platform(,|$)` 完整 token 正则命中时 `on_success`，最终回退为 `manual` 且 `allow_failure: true`。
- [x] 增加 job 映射测试：六个 build、两个 CUA Helper、六个通知 job 必须引用对应平台规则。
- [x] 运行 `pnpm exec vitest run packages/desktop/test/gitlabCiBuildGraph.test.ts`，预期因 rules 模板尚不存在而失败。

### Task 2: 实现平台参数化调度

- [x] 在 `.gitlab/ci/30-build.yml` 增加 `.rules:build-platform:<platform>` 隐藏模板；每个模板包含缺省自动、完整 token 自动、其余非阻塞手动三段规则，并用中文注释记录问题原因与选择 runner 前调度的原因。
- [x] 给六个安装包 build job 添加 `rules: !reference [.rules:build-platform:<platform>, rules]`。
- [x] 给两个 CUA Helper job 添加对应 macOS `rules` 引用，并移除 helper 公共模板里无条件自动的旧规则。
- [x] 在 `.gitlab/ci/40-notarize-notify.yml` 为六个通知 job 声明 rules：先保留 sandbox/test-tag 的 `when: never`，再复用对应平台选择规则；未选时为非阻塞手动 job，并由既有 `needs` 等待对应 build。
- [x] 运行聚焦 Vitest，预期通过。

### Task 3: 验证与提交

- [x] 运行 `node scripts/ci/ci-lint-pipeline.mjs`，验证仓库 CI 静态门禁。
- [x] 运行 `pnpm typecheck`，记录完整结果。
- [x] 运行 `pnpm lint`，记录完整结果。
- [x] 运行 `git diff --check` 并复核变更仅覆盖 spec、计划、测试与 CI 调度。
- [ ] 使用 Conventional Commits 提交：`chore(ci): support selectable build platforms`。
