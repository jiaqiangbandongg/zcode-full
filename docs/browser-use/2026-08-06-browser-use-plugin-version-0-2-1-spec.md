# Browser Use Plugin 0.2.1 版本同步规格

> 后续当前发布版本由 `2026-08-14-browser-use-plugin-version-0-3-0-spec.md` 收敛为 `0.3.0`。

> 状态：已实现并验证
> 日期：2026-08-06
> 基线：`staging@1fdf1e658624`

## 1. 目标

将 Browser Use 官方插件发布身份从 `0.2.0` 最小升级到 `0.2.1`。本次只切换版本作用域，
不修改 Browser API、skill guidance、UI、协议或运行时行为。

以下当前版本事实源必须统一为 `0.2.1`：

1. workspace package `package.json`；
2. `.zcode-plugin/plugin.json`；
3. Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS`；
4. SEA `officialSeaPlugins`；
5. `node_repl` MCP `serverInfo.version`。

`0.2.0` 只允许作为 previous/stale cache fixture 或无关依赖版本继续存在，不得再作为 Browser Use
当前发布版本。

## 2. Impact Brief

### 2.1 Feature Summary

| Field            | Value                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 拉取最新 staging 后确认 Browser Use 为 `0.2.0`，并升级到 `0.2.1`                                                     |
| Capability       | `capability.browser-use-plugin-distribution`                                                                         |
| Change layer     | persistence + validation                                                                                             |
| Operating mode   | planning                                                                                                             |
| Primary seeds    | plugin package/manifest、Bootstrap official definition、SEA official assets、MCP server version、cache/version tests |
| Out of scope     | Browser command/runtime、skill guidance、UI、协议、desktop/mobile delivery                                           |

### 2.2 UI Surface Matrix

| User scenario              | UI entry                          | Shared implementation           | Display/draft owner            | Default/inherit source                  | Validation/gating                                      | Commit action                       | Authority/persistence                                                 | Mode boundary                                         | Must remain isolated from                                               |
| -------------------------- | --------------------------------- | ------------------------------- | ------------------------------ | --------------------------------------- | ------------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| 启动后使用内置 Browser Use | Plugin settings / skill discovery | bundled official plugin seeding | 无草稿；UI 读取 discovery 结果 | official definition + packaged manifest | package/manifest/Bootstrap/SEA/server version 精确对齐 | 启动时 seed 到 version-scoped cache | `~/.zcode/cli/plugins/cache/zcode-plugins-official/browser-use/0.2.1` | filesystem、SEA、Desktop 与 remote 继续复用既有资产链 | Browser runtime、conversation stream、workspace identity、delivery kind |

### 2.3 Feature Relationships

| Rank           | From                     | Semantic edge   | To                            | Why inspect it                                         | Evidence                                         |
| -------------- | ------------------------ | --------------- | ----------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| must-inspect   | package/manifest         | versioned-by    | Bootstrap official definition | 决定 filesystem seed cache path                        | `official-plugin-definitions.ts`                 |
| must-inspect   | package/manifest         | embedded-by     | SEA official assets           | SEA 只接受精确版本匹配                                 | `sea-official-plugin-assets.mjs`、SEA build test |
| must-inspect   | plugin version           | identifies      | MCP server info               | 宿主需要识别实际 Browser Use runtime                   | `tool-contract.ts`、MCP server test              |
| must-inspect   | current official version | persisted-to    | version-scoped cache          | `0.2.1` 必须成为 marketplace partition 的 current root | Bootstrap/Adapter tests                          |
| invariant-only | version bump             | must-not-change | Desktop/Web Remote delivery   | 不得改变 continuous/replayable 或 shared-host 边界     | diff audit                                       |

### 2.4 State Owners And Commit Sinks

| State/fact               | Authoritative owner           | Commit/build sink    | Persistence/cache                      | Evidence               |
| ------------------------ | ----------------------------- | -------------------- | -------------------------------------- | ---------------------- |
| workspace plugin version | `package.json`                | workspace build      | package metadata                       | package file           |
| runtime plugin identity  | `.zcode-plugin/plugin.json`   | plugin discovery     | seeded cache manifest                  | manifest               |
| bundled current version  | `OFFICIAL_PLUGIN_DEFINITIONS` | filesystem seed      | official cache + marketplace partition | Bootstrap source/tests |
| SEA embedded version     | `officialSeaPlugins`          | SEA asset collection | embedded manifest then official cache  | SEA source/tests       |
| MCP runtime version      | `NODE_REPL_SERVER_VERSION`    | `serverInfo`         | runtime handshake                      | MCP server source/test |

### 2.5 Must-Preserve Invariants

| Invariant                                               | Proof needed                                     |
| ------------------------------------------------------- | ------------------------------------------------ |
| 五个当前版本事实源都为 `0.2.1`                          | exact-version assertions + alignment tests       |
| `0.2.0` cache 与 `0.2.1` 并存时只加载 current partition | Adapter stale/current fixture                    |
| Browser Use 必需资产清单不变且完整                      | Bootstrap/SEA asset tests                        |
| Desktop/remote 资产 staging 行为不变                    | existing runtime/remote asset tests + diff audit |
| 不改变 Browser runtime、协议与 delivery                 | source diff 不触及对应实现                       |

### 2.6 Codegraph Evidence

当前仓库没有 `.codegraph/` 索引；codegraph 明确拒绝查询后，使用 feature graph 声明的 seeds 和
depth-2 精确文本扫描完成回退验证。

| Seed                          | Direct callers / key path                                  | Depth | Interpretation                             |
| ----------------------------- | ---------------------------------------------------------- | ----- | ------------------------------------------ |
| `OFFICIAL_PLUGIN_DEFINITIONS` | `resolveOfficialPluginRoots`、Bootstrap plugin/cache tests | 2     | filesystem seed 当前版本与 cache path 权威 |
| `officialSeaPlugins`          | SEA asset collector、SEA build test                        | 2     | SEA embedded version 权威                  |
| package/manifest              | Bootstrap/SEA alignment tests                              | 2     | 发布身份机械闭环                           |
| `NODE_REPL_SERVER_VERSION`    | MCP server construction、server handshake test             | 2     | runtime serverInfo 与 package 同步         |

### 2.7 Graph Delta And Questions

- Graph delta：更新 `capability.browser-use-plugin-distribution` 的当前 spec 引用；能力、边和 code seed
  已完整，无新增产品语义。
- Graph drift candidate：全图检查发现既有 `evidence.mcp-runtime-tests` 仍引用已不存在的
  `conversation-session-browser-use-iab-multisession.test.ts`；该 stale seed 早于本次版本升级且不属于
  distribution capability，本次仅记录，留待对应 MCP/E2E 图谱维护任务处理。
- 未决问题：无；用户已明确要求 `0.2.0` 升到 `0.2.1`。

## 3. 发布与缓存时序

```text
package / manifest / Bootstrap / SEA / serverInfo = 0.2.1
                              |
                              v
                    build/startup validation
                              |
                              v
           seed temp -> atomic promote -> browser-use/0.2.1
                              |
                 +------------+------------+
                 |                         |
        0.2.0 remains stale       marketplace partition
                 |                  points to 0.2.1 only
                 +------------+------------+
                              |
                  existing Browser runtime/delivery
              desktop-continuous | web-remote-replayable
```

## 4. Accepted Cases And Pruning

| Case ID | Setup                           | Action                  | Assertions                                                          | Evidence             | E2E status |
| ------- | ------------------------------- | ----------------------- | ------------------------------------------------------------------- | -------------------- | ---------- |
| BUV-021 | workspace current sources       | run alignment tests     | package/manifest/Bootstrap/SEA/serverInfo 均为 `0.2.1`              | config + unit        | not-needed |
| BUV-022 | `0.2.0` 与 `0.2.1` cache 并存   | discover plugins        | 只加载 `0.2.1` current partition，无 duplicate diagnostic           | Adapter unit         | not-needed |
| BUV-023 | filesystem/SEA asset collection | validate required paths | server/client/docs/skills 必需资产仍完整                            | Bootstrap + SEA unit | not-needed |
| BUV-024 | source diff                     | inspect touched files   | 不修改 Browser command、UI、协议、remote/continuous/replayable 实现 | diff audit           | not-needed |

| Decision ID | Pruned combinations               | Guard/invariant                               | Representative coverage |
| ----------- | --------------------------------- | --------------------------------------------- | ----------------------- |
| PRUNE-021   | desktop/mobile Browser action E2E | 本次不改 runtime、UI、协议或 delivery         | BUV-021/023/024         |
| PRUNE-022   | 所有历史版本排列                  | previous + current 足以证明 stale coexistence | BUV-022                 |

## 5. Planning Handoff

| Item            | Destination                                      | Status     |
| --------------- | ------------------------------------------------ | ---------- |
| Spec update     | 本文 + current runtime/plugin compatibility docs | complete   |
| Case catalog    | 不涉及 Conversation E2E                          | not-needed |
| Coverage matrix | 本文 BUV cases                                   | complete   |
| E2E handoff     | 确定性版本/资产合同足够                          | not-needed |

## 6. 验证记录

| 验证项                              | 结果                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Red phase                           | Bootstrap、SEA Browser Use、MCP server 三条 exact-version 合同均按预期读到旧 `0.2.0` 并失败         |
| Bootstrap plugin/cache tests        | 2 files / 39 tests 通过                                                                             |
| Adapter stale/current cache test    | 1 passed，46 skipped                                                                                |
| Browser Use plugin tests            | 6 files / 32 tests 通过                                                                             |
| SEA Browser Use version/assets test | 1/1 通过；package/manifest/SEA 均为 `0.2.1`，必需资产清单完整                                       |
| Desktop runtime asset scripts       | 39/39 通过                                                                                          |
| Remote official plugin assets       | 77/77 通过                                                                                          |
| Browser Use plugin build            | 通过，构建身份为 `@zcode/browser-use-plugin@0.2.1`                                                  |
| CLI workspace typecheck             | 23/23 tasks 通过                                                                                    |
| 根仓库 `pnpm typecheck`             | 通过                                                                                                |
| 根仓库 `pnpm lint`                  | 0 errors，36 条既有 warning                                                                         |
| Feature graph check                 | node/edge/doc 结构通过；发现 1 个与本次无关的既有 stale code seed，已在 Graph Drift Candidates 记录 |
| 旧版本复扫                          | Browser Use 的 `0.2.0` 仅保留为 stale cache fixture 和本文迁移说明；其它命中属于无关 fixture        |

补充：SEA 全插件对齐测试仍会被最新 staging 的既有
`restore-legacy-sessions` 漂移阻塞（package/manifest 为 `0.1.1`，SEA 清单为 `0.1.0`）；独立的 Browser Use
SEA 合同已拆分并通过，本次不跨范围修改该插件。
