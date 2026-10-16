# open() 同站 tab 复用（reuseTab）设计记录

- 日期：2026-08-24
- 分支：`feat/browser-open-reuse-tab`
- 关联工单：BUA 用户反馈「操作网页时每次都重新打开一个网页，任务结束后右侧内置浏览器堆满标签页」；另见 ZCT-2090747918255304704（同主题工单，真因另有截图秒败/设置页掐订阅两条正交线索）。

## 背景与诊断

标签页堆积是三个因素叠加，全部在 monorepo 工具层，与桌面 main 进程无关：

1. `browser.open(url)` 无条件 `tabs.new()` + `goto()`（facade.ts 旧实现，源自「open 必须创建 agent-owned tab」的旧 bugfix）；
2. 没有任何按 URL 复用已有 tab 的代码——`selection.ts` 的 `urlMatchRank` 只用于选 backend，tab 复用全靠模型自觉走 `tabs.list() → get(id)` 文档流程，无代码兜底；
3. 任务结束按设计不关 tab（见 `browser-use-plugin/docs/tab-cleanup-iab.md`），右侧面板只进不出。

注意：`navigate` 命令本身不会新开 tab——main 端 `resolveTab`（browserGuestManager.ts）已有完整 currentTab 复用链，问题只在 `open()` 与模型调用习惯。

## 设计（用户已确认）

```
open(url?, { reuseTab = true } = {}):
  browser = getDefault()
  if url && reuseTab:
    tabs.list()                     // 仅本 scope agent-owned tabs，不会误接管用户 tab
    selectTabForUrl(url, tabs):     // urlMatchRank，阈值 rank <= 2（同 hostname）
                                   // rank 3 父子域不复制用（可能是不同站点，误跳风险）
                                   // 同 rank 优先 active，否则取最新
    命中 → activateTab（激活给用户看到）→ goto(url) 原地跳转 → 返回
    未命中 / list 失败 → 降级 tabs.new() + goto（复用链路绝不阻断任务）
  否则（无 url / reuseTab:false）→ tabs.new() + goto
```

关键取舍：
- **默认 `reuseTab: true`**：治本必须默认复用；默认 false 等于又回到「靠模型自觉」的软约束老路。
- **保留显式逃生口**：模型填表一半时想开同站对照页，默认复用会导航走表单页——传 `reuseTab: false` 或 `tabs.new()` 可强制并行 tab。
- **`tabs.new()` 语义不变**、main 端不动、任务结束回收不做（用户选择，维持 tab-cleanup-iab.md 既有设计）。

## 改动清单

| 文件 | 内容 |
|---|---|
| `apps/zcode-cli/packages/core/src/browser-client/selection.ts` | 新增纯函数 `selectTabForUrl()`（与 `selectBrowserForUrl` 共享 `urlMatchRank`） |
| `apps/zcode-cli/packages/core/src/browser-client/facade.ts` | `BrowserTabs.reuse(url)`（单次 list + activateTab）；`open()` 接入并整体降级 |
| `apps/zcode-cli/packages/core/src/browser-client/documentation.ts` | fallback 文档：`open()` 教成默认导航入口 |
| `apps/zcode-cli/packages/browser-use-plugin/skills/control-browser/SKILL.md`、`docs/overview.md` | 模型指引同步 |
| `apps/zcode-cli/packages/core/tests/browser-client.test.ts` | 新增 9 用例（TDD）：精确/同域/父子域/无匹配/list 失败降级/无 url/reuseTab:false/active 优先/最新兜底 |

## 验证

- core 包 browser 相关 36/36 绿；browser-use-plugin 35/35 绿；两包 typecheck 通过。
- 命令序列断言：复用路径 `[list, activateTab{tabId}, navigate{url, tabId}]`；降级路径 `[list, newTab, navigate]`。
- desktop `bundled-agents` 打包副本非 git-tracked，构建时自动再生成，无需同步。

## 顺带修复：tool-contracts 守卫红（staging 基线）

同分支 `ea09daa8e7`：`js_reset`/`js_add_node_module_dir` 的 metadata 与 permission/timeout 声明不同步——
`sideEffectScope` metadata 写 `system` 而 permission 侧一直按 `none` 生效（统一为 `none`，与兄弟工具先例一致）；两个工具缺
`metadata.timeoutMs`（补 `5000` 与 `SHORT_TIMEOUT.defaultMs` 一致）。运行时审批与超时行为零变化。
修复后 staging 基线剩余已知红：`bash-run-conformance`（硬编码开发者本机绝对路径）、`io-boundary`、`runtime-module-boundary`（均与本分支无关，未动）。

## 发布

插件版本 `0.3.1 → 0.4.0`（`88249773df`），五个版本事实源按
`docs/browser-use/2026-08-14-browser-use-plugin-version-0-3-0-spec.md` 约定同步 bump。
不 bump 的风险：desktop 命中 `0.3.1` stale seed，旧 SKILL.md 与无 `open` 声明的旧 api.json 发不出去。

## 已知边界

- 模型直接调 `browser.tabs.new()` 仍会开新 tab（显式语义，未收口）——若线上仍见堆积，先查模型轨迹里 `newTab` 命令来源。
- 复用匹配只看 URL，不感知页面状态；表单半填场景依赖模型传 `reuseTab: false`（文档已教）。
- 任务结束不回收 tab 的策略不变；如后续要做上限回收/一键清理，见本文件「背景」第 3 点与 tab-cleanup-iab.md 的 `keep` 机制。

## 补遗（2026-08-24）：manifest hideUnknown 盲区

文档同步时发现：REPL 注入的 `agent.browsers` 是 `asRuntimeObject()` 的 hideUnknown 代理（facade.ts），
`open()` 不在 `Browsers` manifest 声明里会被隐藏成 **undefined**——SKILL.md 教的调用会直接 TypeError。
而裸 facade 单测走不到代理，测不出该缺陷。修复（`d6fe5ae7be`）：

- 两处 manifest 补声明：core 的 `FALLBACK_MANIFEST` 与插件 `docs/api.json`（二者需同步维护）；
- 旧测试「open 必须是 undefined」的断言（锁的是 open 作为兼容入口刻意隐藏的旧设计）反转为可见性守卫；
- 新增用例走 `asRuntimeObject()` 真实代理路径验证。

教训：**给模型新增可见 API 时，必须同时声明 manifest（两处）并用代理路径测试**，裸对象直测是盲区。
