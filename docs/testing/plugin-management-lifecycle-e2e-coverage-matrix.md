# Plugin Management Lifecycle E2E Coverage Matrix

本矩阵追踪 [Plugin Management Lifecycle Case Catalog](../plugin-management-lifecycle-case-catalog.md)
中的候选 case 从 manual review 到三平台正式门禁的状态。`manual-review` 不等于默认质量门禁覆盖。

## Coverage status

| Case                                      | Spec abbreviation | UI automation | Runtime/storage evidence                                          | Human review | Formal spec | Linux Docker | macOS CI | Windows CI |
| ----------------------------------------- | ----------------- | ------------- | ----------------------------------------------------------------- | ------------ | ----------- | ------------ | -------- | ---------- |
| `PLM-LC-001` discovery/navigation         | `PD`              | targeted pass | UI state + screenshot captured                                    | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-002` presentation                 | `PP`              | targeted pass | DOM/a11y/overflow + screenshot captured                           | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-003` personal main lifecycle      | `PM`              | targeted pass | overview/list/storage + update badge/inline entry + v2 Skill/MCP provider evidence pass | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-004` persistence/local visibility | `PV`              | targeted pass | restart/config/enabled/workspace B evidence pass                  | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-005` orphan/reassociate           | `PO`              | targeted pass | source/config/enabled + all update entries (menu/detail/badge/inline) absent + fresh-session Skill evidence pass | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-006` builtin suppress/restore     | `PB`              | targeted pass | suppression/config/data + Catalog/cache preservation + restart evidence pending | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-007` local official CDN           | `PC`              | targeted pass | loopback HTTP ZIP/cache/overview evidence pass                    | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-007b` real CDN smoke              | `PCS`             | not run       | not captured                                                      | pending      | never       | never        | never    | never      |
| `PLM-LC-008` recoverable failures         | `PF`              | targeted pass | source/refresh/describe/install/update preservation evidence pass | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-009` inline smoke                 | `PI`              | targeted pass | UI/list + fresh-session Skill invocation evidence pass            | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-010` secret env/agent projection  | `PEA`             | targeted pass | MCP resolved marker + no-secret capture + one canonical agent row + Electron `capturePage()` video | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-011` no-Git GitHub Archive        | `PGA`             | targeted pass | real Claude Marketplace/plugin HTTP + missing-Git diagnostic; run `desktop-e2e-20260806033745155-p99439-e61ceea7b4c68fcf` | pending      | never       | never        | never    | never      |
| `PLM-LC-012` isolated refresh/atomic cache | `PRA`             | not run       | partial refresh + persisted failure + rollback evidence pending    | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-014` builtin uninstall/detail parity | `PBD`           | not run       | describe/components + suppression/runtime absence + cache/manifest unchanged pending | pending | blocked | blocked | blocked | blocked |
| `PLM-LC-015` bundled install ownership   | `PBO`              | not run       | bundled restore vs CDN Marketplace ownership evidence pending     | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-016` seed/cache/runtime separation | `PBS`            | not run       | filesystem/SEA seed, suppressed discovery, describe and self-heal evidence pending | pending | blocked | blocked | blocked | blocked |
| `PLM-LC-017` installed row menu layout   | `PML`             | targeted pass | workspace-override row menu single-line text + screenshot         | pending      | blocked     | blocked      | blocked  | blocked    |

## Candidate spec paths

Todo103 新增/迁接候选：PLM-LC-018/019 对应 `plugins/manual-review/pending/plugin-store-auto-refresh-{throttled,on-enter}.test.ts`；Pro `desktop-e2e-20260909-152018-653` 两例通过。PLM-LC-020 对应 `plugins/manual-review/pending/plugin-subagent-override-cold.test.ts`，Pro `desktop-e2e-20260909-152419-828` 冷启动 child/父 continuation 请求验证通过，case-local fixture check 通过。三项均未人工晋级；019 保持公网 smoke、不进入正式 CI。

| Abbreviation | Pending spec                                                                     |
| ------------ | -------------------------------------------------------------------------------- |
| `PD` / `PP`  | `plugins/manual-review/pending/plugin-management-discovery-presentation.test.ts` |
| `PM`         | `plugins/manual-review/pending/plugin-management-personal-lifecycle.test.ts`     |
| `PV` / `PO`  | `plugins/manual-review/pending/plugin-management-persistence-source.test.ts`     |
| `PB` / `PI`  | `plugins/manual-review/pending/plugin-management-builtin-inline.test.ts`         |
| `PC`         | `plugins/manual-review/pending/plugin-cdn-zip-marketplace-install.test.ts`       |
| `PCS`        | `plugins/manual-review/pending/plugin-cdn-zip-official-cdn-smoke.test.ts`        |
| `PF`         | `plugins/manual-review/pending/plugin-management-recoverable-failures.test.ts`   |
| `PEA`        | `plugins/manual-review/pending/plugin-runtime-env-agent-projection.test.ts`      |
| `PGA`        | `plugins/manual-review/pending/plugin-no-git-github-archive.test.ts`             |
| `PRA`        | `plugins/manual-review/pending/plugin-refresh-atomic-cache.test.ts`              |
| `PBD`        | `plugins/manual-review/pending/plugin-management-builtin-detail-parity.test.ts`  |
| `PBO`        | `plugins/manual-review/pending/plugin-management-bundled-install-ownership.test.ts` |
| `PBS`        | `plugins/manual-review/pending/plugin-management-seed-runtime-separation.test.ts` |
| `PML`        | `plugins/manual-review/pending/plugin-management-installed-menu-layout.test.ts`   |

## Latest targeted verification

2026-07-15 已在 macOS 上逐个运行上述 `PD/PP`、`PM`、`PV/PO`、`PB/PI`、`PC`、`PF`
pending spec，均通过。这些 spec 不得并行共享 E2E HOME；允许同一兼容批次串行运行、各用例隔离 HOME 并共享构建。
截图与 provider capture 已生成，但尚未完成人工产品审核，因此本表不会把
任何 case 标成 `formal`，也不会运行 promotion apply、Docker admission 或正式 CI preset。

2026-07-20 已在 macOS 上独立运行 `PEA` pending spec 并通过（run
`desktop-e2e-20260720040616896-p59191-dfc1ae47585cbcf6`）：插件安装详情显示一个 MCP 与一个
agent，Subagents 页面只出现一个规范化插件资源，真实 MCP tool call 返回 resolved marker，provider
capture 与运行日志均不含 synthetic secret。Electron `webContents.capturePage()` 录制生成 2400×1600、
7 秒、28 帧的 VP9 WebM；关键截图与视频已生成，但仍等待人工产品审核。

2026-08-06 已在 macOS 上独立运行 `PGA` pending spec 并通过（run
`desktop-e2e-20260806033745155-p99439-e61ceea7b4c68fcf`）：Agent Git binary 指向不存在的绝对
路径，非 GitHub Git 来源返回 `plugin_git_unavailable`；随后通过 GitHub `zipball/HEAD` 下载真实
Anthropic Claude Marketplace，并按目录中的固定 SHA 安装 `aikido`。Marketplace 与安装缓存均无
`.git`，安装记录保留 URL/SHA，最终 discover 到插件 MCP 组件。该公网 smoke 仍只用于 manual review，
不会晋升为正式 CI 门禁。

2026-08-21 在 Orca 隔离 worktree 完成 Catalog/Runtime 分离的定向回归：Bootstrap 插件生命周期
测试 33/33、Adapters 插件测试 74/74、UI listing/card 测试 20/20；根目录 `pnpm typecheck`
与 `pnpm lint` 通过，lint 仅保留既有 warning。正式手工 E2E（PBD/PBO/PBS）仍待独立隔离 HOME
运行和人工审核，不在本次实现中晋升。

2026-09-02 为「已安装列表可更新角标 + 行内更新按钮」补充 `PM`/`PO` 断言（角标与行内入口出现 /
孤立插件不出现），并新增 UI 单测 `packages/ui/test/pluginStoreUpdateEntries.test.ts`（5/5 通过）。
两个 pending spec 未重新运行：它们仍引用已下线的 `plugin-store-manage`、`plugin-store-installed-row`、
`plugin-store-check-updates` 选择器（管理视图已并入 Settings → 插件列表 `plugin-settings-plugin-row`），
需要单独修复后才能再次做 manual review。

## Admission rules

1. Pending spec must have deterministic case-local filesystem/provider fixtures and stable selectors.
2. Manual run must produce list/detail/manage/error/presentation evidence relevant to its cases.
3. Human review changes `Human review` to `approved`; only then may promotion move the spec out of pending.
4. Promoted runtime cases must pass fixture check, common+case isolated replay, and default replay.
5. Each compatibility group must pass one isolated Docker spec before admission to the `plugins` preset.
6. The admitted preset must pass on Linux; the same formal spec set must be selected by macOS and Windows CI.

## Explicit exclusions

- `PLM-BC-001` install cancel, `PLM-BC-002` standalone source diagnose, and `PLM-BC-003` inline
  uninstall remain bug candidates rather than failing lifecycle cases.
- Standalone Web、手机 `/remote`、remote workspace plugin sync 与 workspace-scope 安装没有在本矩阵中
  被标记为 covered。

## PLM-STRIP-CLIP：已安装条角标裁切（2026-09-15）

- 用例：`packages/ui/test/browser/manual-review/pending/plugin-installed-strip.test.mjs`，真实 `PluginStoreListView` + 测试动作回调。
- Chrome/macOS 浏览器 8/8 通过：390/1200px × 中英文 × 明暗主题，验证首末项角标和焦点空间、hover 后命中区域、滚动末尾更新点击、无误开详情及页面横向溢出。原样式复现 top=false / hit=false。
- 截图：系统临时目录 `zcode-plugin-strip-clipping/`。根 typecheck、desktop typecheck:e2e、lint、architecture 检查通过，已有更新入口单测 5/5。
- Pending，未晋升；浏览器渲染与点击验证不代表完整 Electron 插件更新、手机真机或 Windows/Linux 验证。

## Plugin Creator 与本地化

PLM-LC-018/019/020：`plugins/manual-review/pending/plugin-localization-creator.test.ts`，pending、未执行、未人工审核。单测补充异步目标失效、完整 ID 隔离、缺失/禁用 creator；不作为真实手机或 SSH 端到端证据。

2026-09-16 补充：公开分类与个人市场分组默认全部展开，保留手动收起/展开。PLM-LC-001 的断言同步；plugin-localization-creator E2E 增加 8→6→8 张卡片回归，公开/个人与中英组合由组件交互单测覆盖。

## PLM-MISSING-CONFIG

- 状态：manual-review（非正式 CI 转正）。
- 自动化：`packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs` 中
  `PLM-MISSING-CONFIG`；fixture 经真实 buildStoreItems → PluginStoreListView → 卡片/搜索投影。
- 覆盖：1200/390 宽度、en-US/zh-CN、light/dark；已下架配置不生商品、有目录缺包可安装、新插件不消失。
- 补充：dev Electron 原始配置 → Agent list/overview → Host → Renderer 实测；窄屏浏览器是共享 UI 验证，
  不宣称验证手机真实远控连接。正式隔离 HOME 桌面用例尚未转正。

2026-09-17 验证：`node --test --test-name-pattern=PLM-MISSING-CONFIG packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs` 8/8 通过；dev CDP 验证旧卡片 0、新插件卡片 5、原始 missing 诊断仍保留。重新进入商店后保持结果。

## PLM-DOCUMENT-ORDER（2026-09-17）

默认官方文档插件按 PDF、PPT、Excel、Word 排序。浏览器用例覆盖商店分类和已安装图标条，
桌面/手机 × 中英文 × 深浅主题；预置管理分组、停用、缺项、个人同名隔离及服务端排序优先由单测覆盖。
入口：`packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs`。
此用例属于浏览器展示验证，不作为 Electron 安装生命周期或正式 CI 准入证据。

## PLUGIN-CREATOR-ICON

官方创建器本地图标贯穿商店、`@` 候选、Composer 标签与 Session 消息投影。
`plugin-picker-order.test.mjs` 的 `PLUGIN-CREATOR-ICON` 用例覆盖 catalog 无远端 icon 时打开候选并插入标签，
1200/390、中英、深浅主题；Session 消息及个人市场同名隔离由 `pluginCreatorMentionIcon.test.ts` 覆盖。
状态为 manual-review，不自动转正；不向真实模型发送测试消息。
