# Browser Tab 进程内默认持久生命周期 Spec

> 状态：产品生命周期语义已确认；32 个逻辑 tab 硬上限与跨重启恢复由
> `2026-07-31-browser-tab-residency-budget-spec.md` 取代本文原来的“始终 live / 不跨重启 / 仅显式关闭”边界。
>
> 背景轨迹：`model-io-sess_3b29b7bb-c7b3-406f-8460-5462b4ce3d3a.jsonl` 中，第一轮图灵社区页被
> 隐式保留为 handoff，第二轮百度页却因已有 handoff 而在 `turnEnded` 被自动关闭。该差异不是模型或
> 用户主动关闭，而是旧的“只兜底保留一个 tab”策略造成的数据丢失型生命周期缺陷。

## Feature/change summary

| 字段           | 决策                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Change         | IAB tab 从“turn 临时资源、显式保留”改为“ZCode 进程内持久资源、显式关闭”                                              |
| 用户可见入口   | agent `browser.tabs.new()` 创建的 browser-use tab；用户已打开并被 agent claim 的 tab                                 |
| 状态 owner     | Electron main 的 `BrowserGuestManager` 管理控制权；residency coordinator 管理逻辑上限；renderer 保留 tab 壳          |
| 关闭 authority | 模型显式 `tab.close()`；用户手动关闭；每窗口超过 32 个逻辑 tab 的 LRU 自动关闭；workspace 清空；recovery orphan 兜底 |
| Out of scope   | 自适应 renderer 预算；extension/CDP 未实现 backend 的持久化                                                          |

## Clarification log

| 轮次                             | 问题                                           | 用户确认                       | 固定边界                                                                                               |
| -------------------------------- | ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1                                | 是否应依赖模型写 lifecycle JS 保留 tab         | 不应依赖，默认都保留           | `turnEnded` 不得自动关闭 tab                                                                           |
| 2                                | `finalize({ keep })` 中未列出的 tab 是否可关闭 | 不可以；没有主动关闭就必须保留 | `keep` omission 不具有删除语义                                                                         |
| 3                                | “默认保存”是否跨 ZCode 重启                    | 只要求当前 ZCode 进程运行期间  | `closeWindow`/进程退出可以回收；不新增持久化恢复                                                       |
| 4（2026-07-31，2026-08-05 修订） | 是否引入 Tab 跨进程恢复与逻辑 tab 上限         | 引入，并按运行反馈修订         | Tab 壳可跨进程恢复；每窗口最多 32 个逻辑 tab，超限完整关闭最老安全候选；快照 100 页/64 MiB/500 history |

第 4 轮是新产品决策，取代第 3 轮的“不新增持久化恢复”，详细状态机见 residency spec。

## Boundary decisions

| 边界                      | 决策                                                          | 禁止行为                                         |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `tabs.new()`              | 创建成功后默认持续可见、可控                                  | 不能因 turn 完成、异常或模型漏写 finalize 而关闭 |
| `turnEnded`               | 只取消该 turn 的 pending request；保留全部 tab                | 不能选择“最终活动页”并关闭其它 tab               |
| `tabs.finalize({ keep })` | 只对 `keep` 中 tab 应用 `handoff`/`deliverable` 标记          | 不能把未列入 `keep` 解释为 close                 |
| `markHandoff()`           | 显式标记跨 turn 继续控制；不影响其它 tab                      | 不能使其它 active tab 变成临时页                 |
| `markDeliverable()`       | turn 结束时释放该 tab 给原对话但保持可见                      | 不能关闭该 tab、其它 tab 或发布给其它对话        |
| `closeSession`            | 取消 pending request，释放 tab 给原对话，保持 webview 可见    | 不能关闭 tab，也不能改成跨对话可认领             |
| `tab.close()`             | 模型显式关闭一个 tab                                          | 不能扩散到同 scope 的其它 tab                    |
| 用户关闭 tab              | 视为用户主动关闭并删除对应快照                                | 不能重新自动创建已关闭 tab                       |
| 窗口/进程退出             | 只回收 live guest；保留符合持久化条件的 logical tab           | 不能解释为用户逐个关闭 tab                       |
| 第 33 个逻辑 tab          | 按 LRU 完整关闭最老安全候选，并删除恢复事实和 renderer tab 壳 | 不能只销毁 guest 后保留 suspended tab 壳         |
| forced restore orphan     | shell/page-state/restoreUrl 全缺失时定向关闭无法恢复的孤儿壳  | 不能用于普通快照淘汰；不能形成恢复/关闭循环      |
| ZCode 退出                | 回收 live guest；按 page-state repository 恢复 logical tab 壳 | 不能一次性 mount 全部历史 guest                  |

## Domain scope and high-risk cross-products

主域是 browser tool lifecycle、desktop main guest ownership 与 renderer side-pane 可见性。高风险组合：

- 多 tab × 多 turn：已有 handoff 时，新 active tab 仍必须保留。
- finalize keep subset × 未列出 tab：未列出 tab 保持原状态。
- session close × agent-created/claimed user tab：两类都释放而不是关闭，且仍绑定原 session ownership。
- desktop-continuous × web-remote-replayable：IAB 状态仍由 shared desktop host 持有，交付模式不能改变关闭语义。
- window/process lifecycle × session lifecycle：窗口关闭/进程退出可以回收，不能把该规则提前套用到 turn/session。
- logical tab × live guest：未触发上限时默认保留 stable tab identity；跨重启惰性恢复允许 guest renderer 与
  `webContentsId` 变化；超限关闭则连 logical tab 一并删除。

## Concept map and state owners

| 概念                                        | owner                                        | 证据                                                                                          |
| ------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| tab guest、CDP attachment、lifecycle、scope | `BrowserGuestManager`                        | `packages/desktop/src/main/browserView/browserGuestManager.ts`                                |
| logical tab 上限、保护 lease、恢复状态      | `BrowserTabResidencyCoordinator`             | `packages/desktop/src/main/browserView/browserTabResidencyCoordinator.ts`                     |
| tab 可见 webview 和用户关闭动作             | renderer side pane                           | `packages/ui/src/hooks/useAppPanels.ts`、`packages/ui/src/browser-use/UnifiedBrowserView.tsx` |
| turn/session lifecycle 通知                 | ZCode agent runtime → browser control broker | `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`、`agent-runtime.ts`                |
| 模型 API 与 guidance                        | browser-use plugin API/docs/skill            | `apps/zcode-cli/packages/browser-use-plugin`                                                  |
| 进程退出                                    | Electron main/window lifecycle               | `packages/desktop/src/main/index.ts`                                                          |

## Dimensions and candidate decisions

| Case    | 初始状态                     | 事件                   | 预期 effect                                              | 分类                                      |
| ------- | ---------------------------- | ---------------------- | -------------------------------------------------------- | ----------------------------------------- |
| BTL-001 | 两个未标记 agent tab         | `turnEnded`            | 两个 tab 都保持 controlled/visible                       | accepted；旧实现为 bug-candidate          |
| BTL-002 | 一个 handoff + 一个 active   | `turnEnded`            | 两个 tab 都保留，lifecycle 不被隐式重写                  | accepted；轨迹回归主 case                 |
| BTL-003 | 多 tab                       | `finalize({keep:[A]})` | A 应用声明状态，B 保持原状态                             | accepted；旧实现为 bug-candidate          |
| BTL-004 | agent tab + claimed user tab | `closeSession`         | 两者释放为原 session 的 user tabs，不触发 renderer close | accepted；全局 unclaimed 为 bug-candidate |
| BTL-005 | 任意 open tab                | 模型 `tab.close()`     | 只关闭目标 tab并留下 tombstone                           | accepted                                  |
| BTL-006 | 任意 open tab                | 用户关闭 tab           | webview 销毁，tab 不再可控且不自动重建                   | accepted                                  |
| BTL-007 | 任意 open tabs               | 窗口关闭/ZCode 退出    | 回收 live guest；保留可恢复 logical tab                  | accepted；2026-07-31 新决策               |
| BTL-008 | 上次进程曾有 tabs            | 新进程启动             | 恢复 tab 壳；当前/被访问 tab 惰性恢复 guest              | accepted；2026-07-31 新决策取代旧排除     |
| BTL-009 | 创建第 33 个逻辑 tab         | residency 上限评估     | 按保护集合与 LRU 完整关闭最老安全候选                    | accepted；详见 residency spec             |

## Accepted assertions and evidence

| Case        | Setup / action                 | Assertions                                                                                        | Evidence                                    |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| BTL-001/002 | 创建多 tab 后发送 `turnEnded`  | close callback 为 0；`tabs.list()` 返回全部 tab                                                   | manager unit test + response meta           |
| BTL-003     | finalize 仅列出部分 tab        | 未列 tab 仍在 `tabs.list()`；deliverable 只进入 owner session 的 `user.openTabs()`                | manager unit test                           |
| BTL-004     | 两类 tab 后发送 `closeSession` | close callback 为 0；owner controlled list 为空且 user list 包含全部；其它 session user list 为空 | manager unit test                           |
| BTL-005     | 显式 `close`                   | 只收到目标 tab close callback；迟到 attach 被拒绝                                                 | 既有 manager unit test                      |
| BTL-007     | 关闭窗口/manager dispose       | live guest 被清理；显式关闭的 tab 不恢复                                                          | lifecycle unit                              |
| BTL-008     | 重启                           | stable tabId/shell 保留；guest 可替换；快照/URL 按新 spec 恢复                                    | repository + manager + Electron restart E2E |
| BTL-009     | 打开第 33 个逻辑 tab           | 最老安全候选从 DOM、main registry、guest 与恢复仓库同时消失；重启不复活                           | manager + Electron 33-Tab E2E               |

## Coverage and E2E handoff

- 更新 `docs/testing/browser-use-codex-parity-coverage-matrix.md` 的 BCP-044/046/047/049/052。
- turn/session lifecycle 仍由 `BrowserGuestManager` 单元测试覆盖；residency 另补 pure policy、repository、
  manager/UI unit 与真实 Electron 33+ tab E2E。
- 真实 UI E2E 继续复现“图灵社区 → turn 完成 → 百度 → turn 完成”；未触发上限时两个原 guest 都存在；
  第 33 个逻辑 tab 的 E2E 则断言最老 tab 壳、guest 与恢复事实都被完整关闭。
- desktop continuous 与手机 replayable 共用 desktop IAB manager；本次不向 relay/main 新增 task/session 状态。

## `finalize({ keep })` 语义说明

`tabs.finalize({ keep })` 不具有清理未列出临时 tab 的语义。本 spec 只保留“进程内不自动关闭”的
产品语义；释放后的 tab 仍必须按对话隔离，详见
`docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md`。API 形状保持不变：
ZCode IAB 的 omission 不具有删除语义。所有模型提示、API semantics、实现和测试必须
同时声明这一点，禁止用“未列出即清理”的文案诱导模型决定页面是否存活。
