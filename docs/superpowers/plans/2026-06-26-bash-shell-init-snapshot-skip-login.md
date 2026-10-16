# Bash Shell Init Snapshot And Skip Login Plan

**Goal:** 实现 shell init snapshot 策略：首次 Bash toolcall 用 login shell 生成真实 `.sh` snapshot，后续 source snapshot 后跳过 `-l`。

**Scope:** 只影响 Bash tool runtime。provider-visible content、tool exposure、tool description、Explore/Main/Plan system prompt 不因本计划变化。

## Snapshot 生命周期语义

- 创建命令是 `shellPath -c -l <snapshot creation script>`。
- 创建 env 显式包含 resolved shell：`SHELL=shellPath`、`GIT_EDITOR=true`。
- 创建成功后只返回当前进程里这一次 snapshot path，并注册 cleanup 回调结束时 `unlink(snapshotPath)`。
- 后续 Bash command 执行前检查 snapshot path 是否仍可访问；可访问则 source snapshot 并用 `["-c", command]`，不可访问则 fallback 到 `["-c", "-l", command]`。
- cold resume / new process 不从磁盘恢复 snapshot path，也不扫描旧 snapshot。
- retention cleanup 只清理 `shell-snapshots/` 顶层超过默认 30 天 cutoff 的 `.sh` 文件。

## ZCode Target

- POSIX 和 Git Bash 支持 shell init snapshot；CMD 和 legacy shell 保持原行为。
- snapshot 文件位于 ZCode storage 的 `shell-snapshots/snapshot-${shell}-${timestamp}-${random}.sh`。
- snapshot creation script 使用 host path 写文件；Git Bash 只在后续 source snapshot 时转换 path。
- manager 对同一 adapter/root/shell/dialect 缓存创建 promise；失败缓存为 `undefined`，后续继续 login shell fallback。
- 当前进程创建成功的 snapshot 在 `NodeExecutionAdapter.close()` 中 cleanup。
- adapter 构造时执行 retention cleanup，清理顶层 stale `.sh`。
- ZCode startup script 仍是独立的内部 `.sh`，执行顺序是：source shell init snapshot -> source ZCode startup script -> user command -> cwd capture trailer。
- 不启用 find/grep/rg alias 注入；后续 bundled search 另开任务处理。

## Implementation Checklist

- [x] `shell-init-snapshot.ts`
  - [x] 创建顶层随机 snapshot path。
  - [x] `getOrCreate()` 只返回 ready snapshot 或 `undefined`。
  - [x] creation script 覆盖 rc source、function/option/alias export、PATH export。
  - [x] Git Bash source path 使用 `windowsPathToGitBashPath()`。
  - [x] 当前进程 cleanup 和 30 天 retention cleanup。
- [x] `index.ts`
  - [x] 在 spawn 前异步创建/revalidate snapshot。
  - [x] snapshot ready 时 source snapshot 并跳过 `-l`。
  - [x] snapshot creation env 使用 resolved shell overlay。
  - [x] cancellation/close during snapshot creation 不继续 spawn user command。
- [x] `bash-startup-script.ts`
  - [x] 支持在 ZCode startup script 前插入 optional leading source。
- [x] Tests
  - [x] creation script 单测覆盖 bash/zsh/no-rc/Git Bash path。
  - [x] cleanup 单测覆盖 process cleanup 和顶层 retention。
  - [x] exec 集成测试覆盖 skip-login、missing snapshot fallback、creation failure fallback、resolved shell env、cancel/close、cwd capture。
- [x] Docs
  - [x] 更新 `docs/runtime-tools/bash-effective-shell-snapshot.md`。

## Validation Commands

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run \
  tests/shell-init-snapshot.test.ts \
  tests/shell-init-snapshot-cleanup.test.ts \
  tests/bash-startup-script.test.ts \
  tests/exec.test.ts

pnpm --dir apps/zcode-cli --filter @zcode/adapters typecheck

git diff --check
```

Full workspace gates remain:

```bash
pnpm lint
pnpm typecheck
```

## 边界

- 不写入额外的品牌标识 env；只实现 shell snapshot 运行时语义。
- 不实现 `rg`/`find`/`grep` alias 注入；该能力依赖 bundled search assets，另行设计。
- cleanup sweep 放在 adapter lifecycle 中触发，不引入全局 cleanup orchestrator。
