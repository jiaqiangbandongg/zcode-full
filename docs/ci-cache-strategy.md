# CI 缓存策略：工作区持久化取代 GitLab Cache

> Spec 先行文档。本文定义 `.pnpm-store` / `.npm-cache` 等 Node 依赖缓存在 CI 中的唯一合法策略，
> 以及防回归守卫的校验规则。修改缓存策略前必须先更新本文。

## 1. 背景与问题

实测（pipeline #260842，MR !1954，2026-08-13），多个 job 的耗时被 GitLab cache 归档/解压吃掉：

| Job | 总耗时 | restore_cache | archive_cache | 占比 |
| --- | --- | --- | --- | --- |
| `build:desktop:app` | 670s | 173s | 474s | 97% |
| `build:remote:assets` | 939s | 271s | 611s | 94% |
| `build:linux:arm64` / `x64` | 340s / 356s | 26s | 89s | ~34% |

根因链：

1. **没有共享缓存服务器**。job 日志明确输出 `No URL provided, cache will not be uploaded to shared cache server`，
   cache zip 只存在 runner 本机磁盘，永远到不了别的机器。
2. **shell runner 工作区跨 job 复用**。`GIT_CLEAN_FLAGS` 已排除 `.pnpm-store/` `.npm-cache/`，
   这些目录在两次 job 之间天然存活；cache 的"解压覆盖"与工作区内容完全相同，是纯无效动作。
3. **store 膨胀放大代价**。`.pnpm-store` 累积到 738,472 个文件（pnpm store 只增不减；
   单 runner 工作区装过所有分支的 lockfile 依赖并集；`pnpm store prune` 因与并行 job 的
   reflink 冲突（`ERR_PNPM_ENOENT`）被有意禁用，见 `.gitlab/ci/10-scripts.yml` maintain-node-cache 注释），
   单次归档代价从模板注释预估的 40~60s 恶化到 474s/611s。

仓库内已有验证过的反例：Windows 打包 job（pull-only、无本地 cache 命中）pnpm install 仅 25s，
macOS 打包 job 仅 7.3s；`ELECTRON_CACHE`（GB 级）从来不走 GitLab cache，纯靠 `GIT_CLEAN_FLAGS`
工作区持久化。**"工作区持久化"是已被 Windows/macOS/Electron 三条链路验证可行的模式。**

## 2. 决策

```
【废弃】                                【唯一合法】
GitLab cache 打包 node 依赖             GIT_CLEAN_FLAGS 排除 + 工作区复用
  job 结束: 枚举+压缩 73 万文件           job 结束: 无动作 (0s)
  job 开始: 解压覆盖相同内容              job 开始: 直接命中工作区 (0s)
```

- **Node 依赖缓存（`.pnpm-store` / `.npm-cache` / `.next/cache`）一律不声明 GitLab cache。**
  工作区持久化（`GIT_CLEAN_FLAGS` 排除项）是唯一事实源。
- **`packages/desktop/mock-cdn/`（remote assets 二进制）同样改为工作区持久化**，
  失效管理依赖 `build:remote:assets` 脚本内已有的旧 release 清理逻辑，
  原先为它服务的 `remote-assets-cache-key.txt` key 汇总机制废弃删除。
- 冷启动（新 runner / 工作区被清）接受一次全量 `pnpm install`：
  实测 25s（Windows，npmmirror 镜像）~ 121s（macOS 全量），对比归档浪费可忽略。
- `.ci:maintain-node-cache`（24h `npm cache verify` + 坏 store 隔离重建重试）保留，
  负责工作区 store 的健康与磁盘治理。

## 3. 改动清单

| 文件 | 改动 |
| --- | --- |
| `.gitlab/ci/00-workflow.yml` | 删除 `.ci:npm-cache` / `.ci:npm-cache:pull` 模板；`GIT_CLEAN_FLAGS` 追加 `-e packages/desktop/mock-cdn/` |
| `.gitlab/ci/30-build.yml` | `build:desktop:app`、`.build:linux:template`、`build:remote:assets`（两条 cache）、macos/cua-helper/web-remote-control/windows 模板的 cache 引用全部删除 |
| `.gitlab/ci/remote-assets-cache-key.txt` | 删除（cache key 汇总机制废弃） |
| `scripts/ci/ci-lint-pipeline.mjs` | 新增守卫（规则见 §4） |
| `scripts/test/ci-lint-pipeline.test.mjs` | 守卫单测（node:test） |
| `docs/desktop-ci-cd.md` | 同步 00-workflow.yml 的描述（移除"npm/pnpm 缓存模板"） |

## 4. 防回归守卫规则

`node scripts/ci/ci-lint-pipeline.mjs` 扫描 `.gitlab-ci.yml` 与 `.gitlab/ci/*.yml`，规则：

- **R1**：任何 `cache:` 声明（块式、`paths:` 列表、flow 列表、`!reference` 引用）的路径中
  不得出现 `.pnpm-store` / `.npm-cache` / `.next/cache`。
- **R2**：不得出现对 `.ci:npm-cache` / `.ci:npm-cache:pull` 的 `!reference` 引用（模板已删除，出现即坏引用）。
- **R3**：`00-workflow.yml` 的 `GIT_CLEAN_FLAGS` 必须包含排除项
  `.pnpm-store/`、`.npm-cache/`、`packages/desktop/mock-cdn/`（工作区持久化的前提，防止误删导致缓存全失效）。

若未来需要为某个目录恢复 GitLab cache，判定标准（满足全部才允许，且必须先更新本文与守卫）：
1. 该目录会被 `get_sources` 的 git clean 清掉（无法靠工作区持久化）；且
2. 重新获取的代价显著高于归档/解压代价；且
3. 已配置共享缓存服务器（否则 cache 永远只在本机，归档必然白干）。

## 5. store 膨胀治理（磁盘层）

策略切换后膨胀从"每次流水线浪费 20 分钟"降级为"磁盘缓慢增长"。治理选项：

- **A（推荐）**：夜间低峰 schedule 流水线，单 job 独占 runner 时 `rm -rf .pnpm-store` 重建
  （单 job 独占即无 reflink 并发冲突；代价是次日首个 job 全量安装 ~2min）。
- **B**：接受现状，runner 磁盘水位告警时人工清理。

## 6. 预期效果

| Job | 改动前 | 改动后 |
| --- | --- | --- |
| `build:desktop:app` | 11m10s | ~25s |
| `build:remote:assets` | 15m39s | ~60s |
| `build:linux:arm64` / `x64` | 5m41s / 5m57s | ~4m05s / ~4m20s |
| 流水线整体（MR） | ~34min | ~23min（关键路径为 `build:windows:arm64` 22.5min） |
