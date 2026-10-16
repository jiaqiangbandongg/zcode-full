# 内置插件卸载后的 Catalog / Runtime 分离方案

状态：实现完成（2026-08-21）
适用分支：`fix/builtin-plugin-detail-after-uninstall`
评审：Fable 只读对抗评审已通过，结论为“方向成立，落点应在 Catalog/seed 层”。

## 1. Feature Summary / Impact Brief

| Field | Value |
| --- | --- |
| Developer intent | 内置 Document Skills 卸载后仍能打开详情并查看完整组件清单；行为与非内置 Marketplace 插件一致 |
| Capability | Plugin Marketplace detail、builtin uninstall/restore、official seed/cache |
| Change layer | `option-source`、`commit-effect`、`persistence`、`validation` |
| Operating mode | `planning` → implementation |
| Primary seeds | `bundled-plugins.ts`、`plugins.ts`、`marketplace.ts`、`official-marketplace.ts`、`pluginStoreListing.ts`、Plugin Store detail UI |
| Out of scope | 新协议/schema、单项组件启停、Web/手机 remote、workspace-scope 安装、conversation E2E |

### 1.1 当前事实（Fact）

1. 内置插件卸载通过 `plugins.suppressedBuiltins` 表示；Agent discovery、Desktop `skillsService`、`commandsService` 和 session facade 都会据此过滤运行时资源。
2. `writeOfficialMarketplace` 当前把 suppressed 内置插件从 bundled marketplace 分片过滤掉。
3. seed 当前对 suppressed 插件删除 `cache/<official>/<name>/<version>` 并跳过物化。
4. `plugins/describe` 对未安装插件依赖 Marketplace entry 和 source root；`filesystem/sea` entry 当前只从 `cachePath` 或计算出的 cache 目录读取。
5. UI 将 suppressed 内置插件重新投影为 `restorable=true`，但详情页仍因 `info` 缺失调用 `plugins/describe`，于是得到 `plugin_not_found` 或 cache missing。
6. 官方内置分片和 CDN 分片已经按同一 `zcode-plugins-official` 身份合并；ADR-0001 要求 listing 属于 Catalog，而不是安装态。

### 1.2 推断（Inference）

- Catalog（目录身份、listing、只读组件详情）与 Runtime（是否发现、是否启用、用户配置、data）职责混淆，是本次 bug 的根因。
- 内置 cache 的字节来自应用 bundle/SEA，不是用户下载的安装产物；删除它不会从设备移除真实内置代码，只会破坏离线 describe 并制造 seed↔uninstall 互删竞态。
- 保留只读内置 cache，并由 discovery 继续过滤 suppression，可以在不新增 SEA 感知 adapter 的前提下复用非内置插件的 describe UI 合同。

### 1.3 未知 / 明确延后（Unknown / Deferred）

- 当前 config read-modify-write 与 plugin storage lock 之间存在低概率 lost-update 窗口；本次不扩展为跨进程锁重构，记录为后续任务。
- `ZCodeAvailablePluginSummary.installed` 对活跃内置插件的底层投影仍可能为 false；本次通过 UI join 保证 Marketplace 行为，协议字段修正另行处理。

## 2. Product Contract

### 2.1 用户可见合同

卸载前后，内置插件与普通 Marketplace 插件保持同一产品语义：

| 状态 | `installed` | `runtimeLoaded` | Catalog/detail | 主操作 |
| --- | --- | --- | --- | --- |
| 已安装 | true | true（若 enabled） | 可查看完整组件和 metadata | 管理 / 卸载 |
| 已卸载内置 | false | false | Catalog、listing、组件详情仍可读 | Install（内部走 restore） |
| 普通未安装候选 | false | false | 从 Marketplace source describe | Install |
| 恢复后 | true | 按 enabled 生效 | 与安装前一致 | 管理 / 卸载 |

卸载后的详情读取必须是只读操作：不得清除 suppression、不得启用插件、不得创建 installed record、不得触发模型会话或 MCP runtime。

### 2.2 状态与归属

| 状态/事实 | 权威 owner | Mirror/cache | 读写边界 |
| --- | --- | --- | --- |
| 官方 Catalog entry/listing | bundled + CDN marketplace partitions 合并层 | `marketplace.json` | 只读详情/列表；刷新只更新 CDN 分片 |
| 内置源物化目录 | seed boundary（filesystem/SEA → official cache） | `cache/<official>/<name>/<version>` | 不代表 installed；可被 describe 读取 |
| 内置卸载态 | user config `plugins.suppressedBuiltins` | overview 的 `restorableBuiltins`、UI `restorable` | 唯一 Runtime 抑制真相源 |
| enabled/options | user plugin config | Agent/UI overview | 卸载时清理；不影响 Catalog |
| plugin data | `data/<plugin-id>` | 无 | 卸载时删除 |
| 普通 Marketplace 安装记录 | `installed_plugins.json` | UI installed summary | 只归属 cache/Marketplace 安装；内置 restore 不写入 |

## 3. Architecture Boundary

```text
                 ┌──────────────────────────────────────────────┐
                 │ Immutable bundled source                     │
                 │ packages/*-plugin (dev) / SEA assets (prod)  │
                 └──────────────────────┬───────────────────────┘
                                        │ seed boundary
                                        │ filesystem/SEA -> files+sha -> cache
                                        ▼
      ┌──────────────────────────── Catalog layer ────────────────────────────┐
      │ bundled-marketplace.json (all builtin entries)                         │
      │ cdn-marketplace.json       ── merge by official marketplace identity   │
      │ cache/<official>/<name>/<version> (immutable materialized source)      │
      └───────────────┬───────────────────────────────────┬───────────────────┘
                      │ read-only                         │ read + filter
                      ▼                                   ▼
              plugins/describe                       Runtime discovery
              overview/listing                 adapters / skills / commands / MCP
                      │                                   │
                      │                         suppressed id is excluded
                      │                                   │
                      ▼                                   ▼
              Detail UI                         Effective runtime capabilities

  uninstall builtin = add suppressedBuiltins + clear enabled/options + rm data
                      (never remove Catalog entry or immutable source cache)
  restore builtin   = remove suppressedBuiltins + reseed if cache is missing
  Install UI         = restorable ? restoreBuiltin : marketplace install
```

### 3.1 Seed boundary

- `resolveSeedSource` remains the only place that understands filesystem vs SEA.
- `seedBundledOfficialPlugins` always writes all official plugin entries and materializes missing or outdated cache roots with existing temp-directory + marker + atomic replacement safeguards.
- `writeOfficialMarketplace` writes all bundled entries. Suppression is not compiled into Catalog.
- `resolveOfficialPluginRoots` may keep accepting suppression only as a compatibility parameter if removing it would create unnecessary churn, but suppression must remain enforced by discovery and direct readers; it must not delete Catalog/cache.

### 3.2 Runtime boundary

- `discoverNodePluginsSync` continues filtering official candidates by suppressed ID before producing `PluginLoadOutcome`.
- `skillsService` and `commandsService` direct cache scans continue applying the same suppression check.
- `plugin-facade`, browser runtime feature gates, and startup marks continue to use the filtered outcome.
- No new reader may treat cache presence as proof of installation or enablement.

### 3.3 Marketplace describe/install boundary

- `plugins/describe` for a suppressed builtin reads the preserved merged Catalog entry and materialized cache; it does not call restore or mutate config.
- `plugins/restoreBuiltin` remains the canonical builtin recovery operation.
- Any direct CLI/protocol install path that resolves an official `filesystem`/`sea` entry must route to builtin restore instead of writing a marketplace-owned installed record. CDN same-name entries with a real CDN source remain normal Marketplace installs.

## 4. UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display/draft owner | Validation/gating | Commit action | Authority/persistence | Mode boundary | Must remain isolated from |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Browse public plugin | `PluginStorePage` list/card | `buildStoreItems`, `PluginStoreCard` | Plugin management store projection | Catalog entry exists; `restorable` controls primary action | `onOpenDetail` / `onInstall` | Agent `plugins/overview`, Catalog partitions | Desktop local and existing Web service abstraction; no new remote branch | Runtime enablement |
| View uninstalled builtin detail | `PluginStoreDetailView` | same detail + `plugins/describe` cache | `describeCache` keyed by stable plugin ID | Catalog/cache readable; no runtime `info` required | read-only `plugins/describe` | Agent Catalog + immutable cache | No session/clientMode change | `suppressedBuiltins`, enable/options, data |
| Uninstall builtin | detail/card/manage menu + confirm dialog | `usePluginUninstall`, management store | operation state in plugin management store | explicit confirmation; builtin is uninstallable | `plugins/uninstall` | user config + data cleanup; Catalog untouched | Desktop local lifecycle only | Marketplace source removal semantics |
| Restore builtin | Install button on restorable item | `handleInstall`, `restoreBuiltin` | operation state + refreshed overview | `item.restorable === true` | `plugins/restoreBuiltin` | suppression removed; seed self-heals missing cache | Desktop local lifecycle only | ordinary installed record |
| View installed detail | detail/manage | `ZCodePluginInfo` runtime projection | `item.info` | runtime info available | no mutation for read | discovery outcome | unchanged | catalog-only detail fallback |

## 5. Shared And Divergent Behavior

| Concern | Shared across surfaces | Deliberately different | Why it matters |
| --- | --- | --- | --- |
| Catalog/detail | All Marketplace entries use listing + `plugins/describe` | Builtin source is local immutable cache; Git/URL source may clone/download | User-visible detail contract stays identical without making adapter SEA-aware |
| Runtime | All effective capabilities come from filtered discovery | Builtin suppression uses config; ordinary plugin absence uses installed record/source state | Cache presence must never imply runtime presence |
| Install | UI always shows Install for `installed=false` | Builtin Install routes to restore; ordinary candidate routes to install | Prevents builtin being rewritten as marketplace-owned |
| Uninstall | UI confirmation and cleanup semantics | Builtin clears suppression/config/data but preserves source Catalog/cache; ordinary plugin removes its install cache/record | Aligns product behavior while respecting immutable App-bundled source |
| Failure | Describe failure is visible and retryable | Missing cache is a seed/storage fault, not a normal “uninstalled” state | Avoids deterministic Retry loops after valid uninstall |

## 6. Impact Relationships

| Rank | From | Semantic edge | To | Condition | Why inspect it | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| must-inspect | official seed | materializes | Catalog/cache | filesystem or SEA source | Fixing suppression must not break packaged assets | `bundled-plugins.ts`, `official-marketplace.ts` |
| must-inspect | Catalog/cache | read-by | `plugins/describe` | detail has no runtime info | Direct root cause of screenshot | `marketplace.ts:941-1025` |
| must-inspect | suppression | filters | Runtime discovery | official stable ID | Preserve no-runtime invariant | adapters `index.ts`, services scanners |
| must-inspect | UI restorable projection | routes-to | restoreBuiltin | duplicate available/restorable ID | Prevent wrong installed-record ownership | `pluginStoreListing.ts`, `PluginStorePage.tsx` |
| must-inspect | uninstall | persists-to | user config + data | builtin confirm path | Separate Catalog from user state | `plugins.ts`, config adapter |
| should-inspect | Catalog merge | overrides | CDN same-name entry | official CDN source present | Preserve official identity/ownership | `official-marketplace.ts`, ADR-0001 |
| invariant-only | plugin management | executes-through | Agent Host | local or remote workspace | No new process/remote runtime | lifecycle catalog scope |
| evidence-only | lifecycle contract | covered-by | PLM cases/matrix | manual-review fixtures | Regression proof | `docs/plugin-management-lifecycle-case-catalog.md` |

## 7. Must-Preserve Invariants

| Invariant | Surfaces/modes | Proof needed |
| --- | --- | --- |
| Suppressed builtin never contributes Skill/Command/MCP/Hook | Agent discovery, Desktop direct scanners, session facade | cache exists + suppressed; runtime lists omit plugin |
| Catalog remains readable after uninstall | Public list, card, detail | describe returns components/metadata; no config diff |
| Describe is read-only | detail/retry | suppression/config/data/cache unchanged before/after |
| Builtin restore does not create ordinary installed record | Install button and direct protocol install | `installed_plugins.json` unchanged; suppression removed; runtime returns |
| CDN same-name ownership remains source-based | official merged Catalog | CDN source uses Marketplace install; bundled source uses restore |
| Seed and uninstall do not oscillate cache | startup/list/overview + uninstall | no delete/recreate loop; cache marker remains valid |
| Desktop continuous and web-remote-replayable boundaries unchanged | all plugin settings surfaces | no session/task stream or remote delivery changes |
| Workspace identity contract unchanged | local/remote service calls | existing `workspaceIdentity?.trim() || workspacePath` fallback remains |

## 8. Accepted Cases And Pruning

### 8.1 Accepted cases

| Case ID | Setup | Action | Assertions | Evidence layers | Status |
| --- | --- | --- | --- | --- | --- |
| `PLM-LC-014 builtin-uninstall-detail-parity` | Isolated HOME; builtin seeded and enabled with config/data | Open detail; uninstall; remain on detail; retry; restart; restore | After uninstall: `installed=false`, suppression present, runtime absent, Catalog/cache and full components still visible, no error banner; retry is read-only; restart preserves detail; Install restores runtime and leaves no ordinary installed record | UI + protocol + config/data/cache + fresh discovery | accepted / focused unit coverage |
| `PLM-LC-015 bundled-install-ownership` | Suppressed builtin and merged official entry; optional CDN same-name fixture | Invoke Install through UI and direct protocol paths | bundled source routes restore; CDN source routes Marketplace install; no stale suppression/duplicate ownership | protocol + installed record + runtime | accepted / focused unit coverage |
| `PLM-LC-016 seed-cache-runtime-separation` | Suppressed builtin with cache present/missing; dev filesystem and SEA fixture | Resolve/list/describe/skills/commands; remove cache and resolve again | Suppression always filters runtime; missing cache self-heals from seed; describe works before/after; no Catalog filtering | bootstrap + adapter + services tests | accepted / focused unit coverage |

### 8.2 Reuse / update existing case

`PLM-LC-006 builtin-suppress-restore` remains the lifecycle case, but its assertions change:

- remove “cache清理”和“重启不 reseed” assertions;
- require Catalog/cache preservation and detail readability;
- continue requiring config/data cleanup, suppression persistence, runtime absence, and clean restore.

### 8.3 Pruned combinations

| Dimension | Pruned values | Reason |
| --- | --- | --- |
| Client | Web standalone, mobile `/remote` | no new remote protocol or delivery behavior |
| Scope | workspace-scope plugin install | current UI contract is user-scope only |
| Component runtime | MCP + Skill closure; Command/Agent/Hook enumeration | existing lifecycle catalog covers representative runtime paths |
| Source | public network SEA and real CDN in formal CI | use deterministic local filesystem/SEA/HTTP fixtures; real CDN remains manual smoke |
| Locale/theme/viewport | existing pairwise UI contract | not a new presentation change |

## 9. Minimal Implementation Plan

1. Update the lifecycle spec/catalog/matrix and feature graph (this dossier first).
2. Add failing bootstrap/adapter tests for suppressed builtin: full bundled manifest, cache retained/self-healed, describe succeeds, runtime still filtered.
3. Add failing UI listing/detail tests for duplicate `available + restorable` ID and successful detail rendering.
4. Change seed/catalog/uninstall ownership in `bundled-plugins.ts` and `plugins.ts`.
5. Fix `buildStoreItems` merge and builtin install routing; keep protocol schemas unchanged.
6. Run focused tests and inspect persisted snapshots for config, data, cache, manifest, installed records.
7. Run mandatory `pnpm typecheck` and `pnpm lint`; then run broader plugin lifecycle tests and `git diff --check`.

### Planned code files

- `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`
- `apps/zcode-cli/packages/bootstrap/src/plugins.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/startup-marks.ts` (only if suppression parameter is removed)
- `apps/zcode-cli/packages/ui/src/settings/pluginStoreListing.ts`
- `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` only if bundled install routing requires a narrow helper
- bootstrap/adapters/services/UI tests covering the accepted cases above

### Explicitly not changed

- `packages/shared` protocol schemas
- Web remote / mobile replayable state
- conversation case catalogs
- component-level enable/disable model
- cross-process config locking redesign

## 10. Rollback / Failure Boundaries

- If Catalog/cache retention causes a runtime leak, rollback must first prove every reader still filters suppression; do not “fix” by hiding the detail UI.
- If a seed fails, retain the previous valid cache marker and expose a diagnostic; do not write a partial cache.
- If restore fails, suppression remains and the plugin stays absent from Runtime; Catalog detail remains readable when cache is valid.
- If direct install ownership cannot be distinguished safely for CDN same-name entries, keep the UI restore path and defer the direct CLI route as a separately gated fix; never create a duplicate installed record.

## 11. Feature Boundary Planner Output

### Codegraph evidence

This checkout has no `.codegraph/` directory, so the scan used current source/docs/tests with `rg` after confirming the CodeGraph index is absent. The primary depth-2 paths are:

```text
PluginStorePage
  -> pluginManagementStore.describePlugin / restoreBuiltin / installPlugin
  -> Agent plugins/overview + plugins/describe + plugins/restoreBuiltin
  -> bundled seed + marketplace resolver + runtime discovery
  -> skillsService / commandsService / session facade
```

### Graph drift candidates

1. Existing graph has `capability.plugin-source-acquisition` and `persistence.plugin-marketplace-installed-cache`, but no explicit Catalog-vs-Runtime separation or builtin suppression owner.
2. Existing lifecycle case `PLM-LC-006` encodes the superseded cache-deletion contract.
3. UI `restorableBuiltins` and `plugins/describe` relationship is not represented as a separate graph edge.

### Proposed graph delta

Add `capability.plugin-catalog-runtime-separation` with code seeds for bundled seed, merged official marketplace, describe resolver, suppression filter, builtin uninstall/restore, UI detail and lifecycle evidence. Add edges:

- capability → Catalog/cache persistence (`must-inspect`);
- capability → Runtime suppression/discovery (`must-preserve-runtime-contract`);
- Catalog/cache → `plugins/describe` (`read-by`, `must-inspect`);
- restorable UI projection → `restoreBuiltin` (`commits-to`, `must-inspect`);
- capability → PLM-014/015/016 evidence (`covered-by`, evidence-only).

## 12. Planning Handoff

| Item | Destination | Status |
| --- | --- | --- |
| Feature spec / dossier | this file | complete before code |
| Existing lifecycle case catalog | `docs/plugin-management-lifecycle-case-catalog.md` | update PLM-LC-006 + add PLM-LC-014/015/016 |
| Coverage matrix | `docs/testing/plugin-management-lifecycle-e2e-coverage-matrix.md` | add/update rows |
| Feature graph | `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` | add confirmed capability and edges |
| Formal proof | `packages/formal-proof` | not applicable; no conversation state-space change |
| E2E handoff | plugin manual-review pending specs | planned after focused tests; no formal promotion in this task |

## 13. Implementation and Verification

- `bundled-plugins.ts` now always materializes the complete official Catalog/cache and leaves Runtime suppression to discovery.
- builtin uninstall now preserves the official Catalog/cache while still clearing suppression-controlled config and plugin data.
- direct install of a suppressed bundled `filesystem`/`sea` entry routes through `restoreBuiltin`; CDN-backed entries retain Marketplace ownership.
- UI joins duplicate available/restorable IDs so listing metadata and component detail remain available in the uninstalled state.
- Focused verification: Bootstrap `tests/plugins.test.ts` 33/33, Adapters `tests/plugins.test.ts` 74/74, UI listing/card tests 20/20; package typechecks pass; root `pnpm typecheck` and `pnpm lint` pass (lint reports existing warnings only).
