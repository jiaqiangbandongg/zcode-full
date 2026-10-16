# 官方插件版本同步规格：node-repl-host / Browser Use 0.5.0 与 Computer Use 0.6.0

> 日期：2026-09-17
> 状态：已实现并验证
> 关联改动：Computer Use 换成 node_repl SDK 重建，node_repl 宿主从 Browser Use 抽成独立
> 官方插件 `@zcode/node-repl-host`。

本规格同时覆盖三个包，因为这次它们的版本事实源清单**结构性地变了**：Browser Use 原本的
五处事实源里，第五处 `NODE_REPL_SERVER_VERSION` 随宿主迁出，成了 node-repl-host 自己的
记录。此前每版一份的 `docs/browser-use/*-browser-use-plugin-version-*-spec.md` 系列只描述
单插件，无法表达迁出后的归属。

## 1. 版本决策

| 包 | 旧版本 | 新版本 | 决策依据 |
| --- | --- | --- | --- |
| `@zcode/browser-use-plugin` | 0.4.2 | 0.5.0 | 发布单元内容变了：node_repl MCP server 不再由本插件携带（`dist/mcp/server.js` 移出 seed 清单），插件只剩 skill、client runtime 与文档。这是发布物构成的变化，不是缺陷修复，取 minor。 |
| `@zcode/node-repl-host` | 0.4.2 | 0.5.0 | 宿主契约本身变了：从 Browser Use 内部抽成独立 seed 单元，工具面随 Computer Use 的 node_repl SDK 重建调整。抽出时它继承了 Browser Use 的 0.4.2，本次按同一 minor 台阶抬到 0.5.0。 |
| `zcode-cua` / `@zcode/zcode-cua-plugin` | 0.5.14 | 0.6.0 | producer 侧是破坏性重建（`feat(cua)!`：重建工具面、后台输入与观察面），patch 号不足以让下游区分新旧 producer。 |

node-repl-host 与 Browser Use 数字相同**只是同源历史的巧合**，不构成耦合：两者各自独立升版，
`NODE_REPL_SERVER_VERSION` 的注释里已就地记录这一点。

## 2. 版本事实源

### 2.1 Browser Use（四处，手工维护）

1. `apps/zcode-cli/packages/browser-use-plugin/package.json`；
2. `apps/zcode-cli/packages/browser-use-plugin/.zcode-plugin/plugin.json`；
3. Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS` 里 `browser-use` 条目；
4. SEA `officialSeaPlugins` 里 `browser-use` 条目。

原第五处 `NODE_REPL_SERVER_VERSION` 已不属于本插件——它随宿主迁到 node-repl-host。

### 2.2 node-repl-host（五处 + 一份产物，手工维护）

1. `apps/zcode-cli/packages/node-repl-host/package.json`；
2. `apps/zcode-cli/packages/node-repl-host/.zcode-plugin/plugin.json`；
3. Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS` 里 `node-repl-host` 条目；
4. SEA `officialSeaPlugins` 里 `node-repl-host` 条目；
5. `src/tool-contract.ts` 的 `NODE_REPL_SERVER_VERSION`，即 MCP `serverInfo.version`。

另有 `dist-types/tool-contract.d.ts` 是 git-tracked 的声明产物，必须与 src 同步提交。

node-repl-host 不是面向用户的插件：无 skill、无市场 listing、无图标，但必须始终随发布物嵌入，
否则 Browser Use 或 Computer Use 任一启用时都没有宿主可跑。

### 2.3 Computer Use（机器派生，**不要手改**）

CUA 的版本真相源是 pnpm catalog 里 `@zcode/zcode-cua` 的 producer pin 所解析出的 producer
`package.json.version`。下列记录全部由 `bump-zcode-cua-producer.mjs` 原子写回，手改任一处都会
被 `check-version-coherence.mjs --check` 判为漂移：

- `pnpm-workspace.yaml` catalog 的两个别名（`@zcode/zcode-cua`、`@zcode/zcode-cua-helper-runtime`）；
- `pnpm-lock.yaml` 的 catalog 解析与 producer resolution 元数据；
- wrapper `package.json` 与 `.zcode-plugin/plugin.json`；
- Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS` 里 `computer-use` 条目；
- `upstream.json` 的 commit/ref/skillSha256 provenance；
- 实现契约 `docs/superpowers/specs/2026-08-14-cua-final-raster-integrity-contract.md` 的 producer ref。

producer 侧（`zcode-cua` 仓库）升版需要改两份记录并重建产物：`package.json`、
`plugin/.zcode-plugin/plugin.json`，以及 git-tracked 的 `dist/`——版本经 esbuild define
`__ZCODE_CUA_VERSION__` 注入 bundle，消费者通过 git 依赖只拿到 `dist/**`，不重建等于发旧版本号。
重建必须在该仓库自己的 `node_modules` 下进行；若 `node_modules` 是指向别处克隆的软链，esbuild
会把模块键写成 `../../../../zcode-cua/node_modules/...`，`dist_freshness` 门禁会红。

## 3. 发布与缓存链路

```text
browser-use:     package / manifest / Bootstrap / SEA            = 0.5.0
node-repl-host:  package / manifest / Bootstrap / SEA / serverInfo = 0.5.0
computer-use:    catalog pin -> lock -> wrapper / Bootstrap        = 0.6.0
                         |
                         v
 filesystem / SEA / Desktop / remote official assets
                         |
                         v
 seed temp -> atomic promote -> <plugin>/<version>
                         |
                         v
 新 runtime 与其版本身份一起生效
```

官方 cache 目录名带版本号，因此升版后 seed 进新目录；旧目录可作为历史缓存保留，但官方
discovery 只应指向新版本。

## 4. 兼容边界

- 不改协议、不改 `ToolResultPayload` 等既有数据形态；本次只改版本身份与其同步点。
- 历史版本规格（`0.4.1`、`0.4.2` 等）继续记录旧版本事实，**不回写为新版本**。
- Browser Use 的 SEA 条目注释此前硬编码了当时的版本号，本次改为版本中立表述，去掉一个多余的
  漂移点（同文件 document-skills 条目的注释本来就是中立的）。

## 5. 防漂移的机械校验

| 校验点 | 覆盖范围 |
| --- | --- |
| `plugins.test.ts`「keeps every bundled plugin package, manifest, and seed version aligned」 | 逐个官方插件比对 package / manifest / Bootstrap definition |
| `build-sea.test.mjs`「keeps SEA official plugin versions aligned with package and plugin manifests」 | 逐个 SEA 条目比对 package / manifest / SEA 清单 |
| `node-repl-host/test/mcp-server.test.ts` | 钉住 `serverInfo.version` == 本包 `package.json.version` |
| `check-version-coherence.mjs --check` | 钉住 CUA 全链（catalog / lock / wrapper / 官方定义 / upstream provenance / 实现契约） |
| `zcode-cua` 的 `scripts/checks/dist_freshness.sh` | 钉住 git-tracked `dist/` 与 src 在同一提交内干净重建一致 |

## 6. 验证

见本次提交的验证记录：producer 侧 typecheck / lint / 单测 / dist freshness；消费侧
`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测与 CLI 子
workspace 单测。
