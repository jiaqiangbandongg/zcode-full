# Browser Use Plugin 0.1.3 版本同步规格

> 历史规格：`0.1.3` 的版本同步合同已完成；后续当前发布版本由
> `2026-08-14-browser-use-plugin-version-0-3-0-spec.md` 收敛为 `0.3.0`。

> 状态：已实现并完成发布资产、文档与运行时契约验证
> 日期：2026-08-02
> 基线：`origin/staging@1203073aff`

## 1. 目标

Browser Use plugin 的当前发布版本从 `0.1.2` 最小幅度升级到 `0.1.3`，使已经进入 staging 的
locator、action expected-effect 与 popup 双 registry 原子观察 guidance 进入新的官方缓存目录，避免旧
`0.1.2` cache 继续被当作当前随包内容。

所有当前版本事实源必须统一为 `0.1.3`：

1. workspace package `package.json`；
2. `.zcode-plugin/plugin.json`；
3. Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS`；
4. SEA `officialSeaPlugins`；
5. Bootstrap cache-path 契约与 SEA/version alignment 契约；
6. 当前 Browser Use/Plugin compatibility 文档。

历史/迁移测试可以保留旧版本，但必须明确表示 stale/previous cache，不能被命名为 current。

## 2. Impact Brief

### 2.1 Feature Summary

| Field | Value |
| --- | --- |
| Developer intent | 从最新 staging 独立拉分支，将 Browser Use plugin 最小幅度升到 `0.1.3` 并统一所有版本入口 |
| Capability | `capability.browser-use-plugin-distribution` |
| Change layer | persistence + validation + commit-effect |
| Operating mode | implementation-handoff |
| Primary seeds | plugin package/manifest、official definitions、SEA official assets、official cache tests |
| Out of scope | Browser command 协议、UI、desktop/mobile delivery 语义 |

### 2.2 UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display/draft owner | Default/inherit source | Validation/gating | Commit action | Authority/persistence | Mode boundary | Must remain isolated from |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 启动后使用内置 Browser Use | Plugin settings / agent skill discovery | bundled official plugin seeding | 无本地草稿；UI 读取 discovered plugin | `OFFICIAL_PLUGIN_DEFINITIONS` + packaged manifest | package/manifest/seed/SEA 版本必须相等 | 启动时 seed 到 version-scoped cache | `~/.zcode/cli/plugins/cache/zcode-plugins-official/browser-use/0.1.3` | Desktop filesystem seed 与 SEA seed 使用同一版本；远端沿既有 runtime asset staging | conversation stream、workspace identity、browser tab runtime |

### 2.3 Shared And Divergent Behavior

| Concern | Shared across surfaces | Deliberately different | Why it matters for this change |
| --- | --- | --- | --- |
| Option source | package、manifest、Bootstrap 与 SEA 都声明同一当前版本 | 历史测试可声明 stale version | 当前版本分叉会让随包插件无法 seed 或仍加载旧 cache |
| Validation | Bootstrap/SEA 自动化机械校验版本一致 | Adapter stale-cache 测试同时保留 previous/current 两代 | 既验证发布事实，也验证升级现场 |
| Commit effect | 当前资产写入 `browser-use/0.1.3` | 旧版本目录不主动删除 | 版本目录切换实现可恢复升级，不破坏旧 cache |
| Persistence/recovery | bundled marketplace partition 指向当前 cachePath | fallback scan 只用于缺少 partition 的旧状态 | 当前权威分片必须压过残留旧目录 |

### 2.4 Feature Relationships

| Rank | From | Semantic edge | To | Condition | Why inspect it | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| must-inspect | Browser Use package/manifest | versioned-by | Bootstrap official definition | filesystem seed | 决定 cache 目录和 marketplace version | `official-plugin-definitions.ts` |
| must-inspect | Browser Use package/manifest | embedded-by | SEA official assets | SEA build/startup | SEA 只接受与 definition 精确匹配的 manifest entry | `sea-official-plugin-assets.mjs`、`bundled-plugins.ts` |
| must-inspect | current official version | persisted-to | version-scoped cache | app startup | 新版本必须与旧 `0.1.2` 并存但成为唯一 current root | plugin adapter/bootstrap tests |
| must-inspect | Browser Use plugin assets | staged-by | Desktop、SEA、production remote、development remote | all packaged/dev modes | 每条分发链都必须同时携带 server/client/docs/skills | staging source + asset tests |
| must-inspect | Browser included docs/API | guides | Node REPL persistent kernel | model executes examples across cells | included 示例必须可执行且复用 canonical binding | browser manifest tests |
| invariant-only | plugin version and contract fixes | must-not-change | Browser command runtime/delivery | all modes | 不改变 browser command、continuous/replayable 语义 | 既有 Browser Use tests |

### 2.5 State Owners And Commit Sinks

| State/fact | Draft/display owner | Authoritative owner | Commit command/service | Persistence/cache | Evidence |
| --- | --- | --- | --- | --- | --- |
| workspace plugin version | package metadata | `package.json` | build/package collection | workspace package | package file |
| runtime plugin identity | plugin manifest | `.zcode-plugin/plugin.json` | plugin discovery | seeded cache manifest | manifest |
| bundled current version | Bootstrap | `OFFICIAL_PLUGIN_DEFINITIONS` | `resolveOfficialPluginRoots` | official cache + marketplace partition | bundled plugin source/tests |
| SEA embedded version | SEA asset collector | `officialSeaPlugins` | SEA build | embedded manifest then official cache | SEA source/tests |

### 2.6 Must-Preserve Invariants

| Invariant | Surfaces/modes | Proof needed | Evidence |
| --- | --- | --- | --- |
| 四个当前版本事实源都为 `0.1.3` | filesystem + SEA | exact-version assertions + alignment tests | Bootstrap/SEA tests |
| `0.1.2` 只能作为 previous/stale 历史说明或 fixture 出现 | migration tests | 全仓精确复扫并分类 | `rg` audit |
| Browser Use 仍是 runtime-backed official plugin | desktop/SEA/remote assets | `dist/mcp/server.js` 与 docs/client assets 仍被打包 | SEA asset tests |
| 开发态远程资产 hash 与归档必须包含 `scripts/browser-client.mjs` | SSH/WSL/Docker dev deploy | 修改 client script 会改变 dev asset identity，归档包含 client | remote deploy tests |
| bootstrap 复用不能只检查 server | Desktop + production remote | Browser Use 每次从源码重建，或同时证明 server/client 新鲜 | runtime asset script tests |
| `overview.md` / `workflow.md` included 示例跨 cell 可执行 | all Browser Use sessions | 真实 `NodeReplSession` 执行示例并验证 `globalThis.browser` | browser manifest tests |
| API manifest 与 runtime `TabInfo` 都声明必需 viewport | all backends | API manifest v10 与 fallback/effective docs 都包含 `viewport: BrowserViewportSize` | browser manifest tests |
| 不改变 continuous/replayable 与 browser runtime | desktop/mobile | 无协议/UI/runtime diff | diff audit |

### 2.7 Codegraph Evidence

当前环境没有 ZCode codegraph 工具；按 skill 规则使用 feature graph seeds + depth-2 `rg`/direct-caller
fallback。

| Seed | Query | Direct callers / key path | Depth | Interpretation |
| --- | --- | --- | --- | --- |
| `OFFICIAL_PLUGIN_DEFINITIONS` | direct callers | `bundled-plugins.ts` filesystem/SEA seed resolution、Bootstrap tests | 2 | 当前官方版本与 cachePath 权威 |
| `officialSeaPlugins` | direct callers | `collectSeaOfficialPluginAssets`、SEA build tests | 2 | SEA embedded manifest 权威 |
| plugin `package.json` / manifest | text/config scan | Bootstrap/SEA alignment tests | 2 | 发布内容版本事实 |
| official cache path | text/test scan | Bootstrap resilience、Adapter stale coexistence tests | 2 | 升级与恢复证据 |

### 2.8 Graph Drift Candidates

| Candidate | Live-code evidence | Missing/stale graph relation | Proposed follow-up |
| --- | --- | --- | --- |
| Browser Use distribution/versioning | official definitions、SEA manifest、cache tests | 原图只有 agent guidance capability，没有插件发布/缓存能力 | 增加 `capability.browser-use-plugin-distribution` 与 evidence edges |

### 2.9 Graph Delta

| Status | Node/edge | Semantic reason | Evidence | Action |
| --- | --- | --- | --- | --- |
| confirmed | `capability.browser-use-plugin-distribution` | 版本决定官方 seed、SEA 匹配与 cache identity | 用户要求 + live source scan | 写入 feature graph |
| confirmed | distribution → build-release / agent-core / evidence | 发布物进入 agent runtime，但不改变 delivery | bundled/SEA source | 写入 typed edges |

### 2.10 Unresolved Questions

| Question | Candidate answers | Scope difference | Owner |
| --- | --- | --- | --- |
| none | “最小版本号”按 semver patch 从 `0.1.2` 升至 `0.1.3` | 不引入 minor/major 兼容变化 | 用户指令 + semver |

## 3. 发布时序

```text
package/manifest/Bootstrap/SEA = 0.1.3
                    |
                    v
          build / startup validation
                    |
                    v
seed temp directory -> atomic promote -> browser-use/0.1.3
                    |
                    v
 bundled marketplace partition points only to 0.1.3
                    |
        +-----------+-----------+
        |                       |
 old 0.1.2 remains stale    discovery loads 0.1.3
        |                       |
        +------ no duplicate ---+
```

## 4. Accepted Cases And Pruning

| Case ID | Setup | Action | Assertions | Evidence layers | E2E status |
| --- | --- | --- | --- | --- | --- |
| BUV-001 | workspace current version sources | run alignment tests | package/manifest/Bootstrap/SEA 全部为 `0.1.3` | config + unit | not-needed |
| BUV-002 | cache 同时存在 previous/current | discover plugins | bundled partition 只加载 `0.1.3`，无 duplicate diagnostic | adapter unit | not-needed |
| BUV-003 | SEA asset collection | build manifest | Browser Use entry 是 `0.1.3` 且包含 skill/docs/server/client | SEA unit/build | not-needed |
| BUV-004 | 开发态远程部署拥有 Browser Use client script | 计算 dev asset hash 并生成官方插件归档 | `scripts/browser-client.mjs` 参与 hash 与 copy；内容变化不会复用旧远端缓存 | server unit | not-needed |
| BUV-005 | included Browser 文档进入 persistent Node REPL | 顺序执行 overview/workflow 示例 | canonical `globalThis.browser` 跨 cell 存续；不使用 `tabs.selected()` 或局部 browser alias | core contract | not-needed |
| BUV-006 | bootstrap 工作区残留旧 runtime | Desktop/remote 准备官方插件 | Browser Use 不因仅存在旧 `server.js` 而跳过 rebuild；server/client/docs/skills 全部存在后才可 stage | build-script contract | not-needed |
| BUV-007 | runtime/API/docs 当前事实复扫 | 生成 effective documentation | `TabInfo.viewport`、RegExp、node_repl 物理载体和 server version 口径一致 | contract + docs | not-needed |

| Decision ID | Pruned combinations | Guard/invariant | Product reason | Representative coverage |
| --- | --- | --- | --- | --- |
| PRUNE-001 | desktop/web/mobile 各跑 Browser E2E | 无 runtime/API/UI 改动 | 版本 identity 由确定性打包契约验证 | BUV-001/003 |
| PRUNE-002 | 所有历史插件版本排列 | bundled partition 是当前权威 | 一组 previous + current 足以验证 stale coexistence | BUV-002 |
| PRUNE-003 | desktop/mobile 各跑一遍 Browser action E2E | 本次不改 Browser command、tab owner 或 delivery | 分发和文档合同用确定性单测覆盖 | BUV-004..007 |

## 5. Planning Handoff

| Item | Destination | Status |
| --- | --- | --- |
| Spec update | 本文档 + plugin compatibility/current runtime spec | complete |
| Case catalog | 不涉及 Conversation E2E | not-needed |
| Coverage matrix | 本文 BUV cases | complete |
| Decision backlog | 无 | not-needed |
| E2E handoff | 确定性打包/版本契约足够 | not-needed |

## 6. 验证记录

| 验证项 | 结果 |
| --- | --- |
| Red phase | Bootstrap exact version/cache-path 与 SEA exact version 契约按预期失败，实际值均为旧 `0.1.2` |
| Bootstrap plugin/cache tests | 2 files / 38 tests 通过 |
| Adapter stale/current cache test | 1 passed，46 skipped |
| Browser Use plugin tests | 6 files / 29 tests 通过 |
| SEA build tests | 39/39 通过；包含版本对齐、完整资产清单，以及缺失 Browser client 时拒绝打包 |
| ZCode CLI workspace build | 15 tasks 全部成功 |
| Browser Use plugin build | 通过，构建身份为 `@zcode/browser-use-plugin@0.1.3` |
| Bootstrap plugin tests | 1 file / 30 tests 通过；filesystem/SEA seed 缺必需 Browser 资产时拒绝，完整包正常 seed |
| Browser 分发与文档聚焦回归 | core 16 + plugin 29 + desktop 38 + server 77 + SEA 39 全部通过 |
| ZCode CLI workspace typecheck | 23/23 tasks 通过 |
| 根仓库 `pnpm typecheck` | 通过 |
| 根仓库 `pnpm lint` | 0 errors，36 条既有 warning |
| Feature graph integrity | 150 nodes / 259 edges / 216 code seeds；无重复 node/edge、悬空 edge 或缺失 code seed |
| 旧版本复扫 | `0.1.2` 只保留在本文 previous/stale 说明和 Adapter stale-cache fixture；无旧 current source |

## 7. 0.1.3 发布后审计补强合同

2026-08-02 的全链路复查发现，版本事实虽然一致，但资产白名单、included 文档和当前事实文档仍可独立
漂移。0.1.3 的完成条件因此补充如下：

1. Desktop、SEA、production remote、development remote 和 filesystem seed 五条链都必须包含
   `dist/mcp/server.js`、`scripts/browser-client.mjs`、skills 与 effective documentation。
2. Development remote 的内容 hash 与 copy 必须使用同一白名单；`scripts` 变化必须让 `.dev-version`
   变化，禁止继续命中旧远端缓存。
3. Browser Use 的 bootstrap 产物是 server/client 二元组。bootstrap build 不得只因 `server.js` 存在
   就复用工作区残留；Browser Use 需要从当前源码重新生成二元组。
4. `overview.md` 与 `workflow.md` 是模型默认可见的 included 文档。示例必须统一写入
   `globalThis.browser`，不得用跨 cell 不持久的局部 `const browser`，也不得以 `tabs.selected()` 绕过
   完整 list → 模型观察 → verified match → get/claim 协议。
5. API manifest v10、Skill、included docs、fallback、当前事实 spec 与 coverage matrix 必须统一
   `TabInfo.viewport`、跨 Realm `RegExp`、显式截图 artifact path 和宿主 `node_repl` 的真实边界。
6. `node_repl` MCP 的 serverInfo version 与 Browser Use package version 同步，并由自动化机械校验；禁止
   在源码中长期保留无法解释的独立 `0.1.0`。
7. SEA 与 remote 不能只把 Browser Use manifest 或 `dist/mcp/server.js` 当作完整性标记；server、client、
   API/docs 与两项 skill 的必需路径缺少任意一项，都必须拒绝发布或强制重新部署。
