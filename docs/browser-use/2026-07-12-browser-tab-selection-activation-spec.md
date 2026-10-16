# Browser Tab 选择、激活与操作预检 Spec

> 状态：产品语义已确认。本文补充 `2026-07-12-browser-tab-process-lifetime-spec.md`，定义多 tab
> 场景下“模型选哪个 tab”和“用户看到哪个 tab”的一致性。挂起 tab 的选择与透明恢复另受
> `2026-07-31-browser-tab-residency-budget-spec.md` 约束。

## Feature/change summary

| 字段         | 决策                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Change       | `browser.tabs.get(id)` 从纯对象绑定改为“绑定 + 激活”；前台 scope 展示目标 tab，后台 scope 只记录激活态              |
| 模型预检     | 每个逻辑 browser 操作批次先单独返回 `tabs.list()` 给模型观察，下一次 JS 调用再按 id/url/title 确认目标并 `tabs.get(id)` |
| 用户可见结果 | get 成功后目标 browser-use tab 成为当前 side-pane active tab，右侧栏展开                                                |
| State owner  | main `BrowserGuestManager` 持有 selected tab；renderer side pane 持有前台可见 tab                                       |
| Out of scope | 同一个 JS cell 已确认目标后的每个 locator/snapshot 动作都重复 list；自适应 renderer 预算                                |

## Clarification log and fixed boundaries

| 需求                      | 固定边界                                                         | 原因                                                                                    |
| ------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `tabs.get` 应激活对应 tab | 每次 get 都发送显式 `activateTab` backend command                | 不能只在 agent 内返回一个 Tab 对象而让 UI 仍展示另一个页面                              |
| 多 tab 容易选错           | 模型每个逻辑操作批次必须重新 list→观察结果→match→get             | 不能依赖上个 turn/cell 的 `globalThis.tab` 或数组位置；SDK 内部静默 list 不算模型已观察 |
| “每次操作”粒度            | 一个逻辑批次开始前预检；同一 cell 内已确认目标后的连续动作不重复 | 保留可审计选 tab 证据，同时避免每个 locator action 增加无意义往返                       |

没有剩余未定义产品分支。

## Boundary decisions

| 边界              | 必须行为                                                                                         | 禁止行为                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `tabs.list()`         | 返回当前 scope 全量 logical tab（含 suspended）的 id/url/title，并且最多一个 `active`；`active` 的语义是「不带 tabId 的命令会落到哪个 tab」 | 为了 list 恢复全部 guest；多个 tab 同时声明 active；把 `active` 当成「UI 当前是否可见」的代理（可见性走独立的 `browserVisibilitySet/Get`） |
| 目标匹配（模型侧） | 模型先收到完整 list 结果；优先稳定 id，否则按用户给定/最新 list 中的明确 url/title 匹配          | 多 tab 时盲选 `[0]`、`at(-1)`、在同一未观察 cell 内静默选择，或复用未知指向的全局 tab（本行只约束模型消歧，不适用于下节的系统回退） |
| `tabs.get(id)`        | 校验 logical id 仍存在；若 suspended 则先 single-flight 恢复，再通知 backend 激活，成功后才返回 Tab                                         | 只构造本地对象、不更新 UI；为恢复失败的 tab 静默新建空页                                                                                   |
| 激活 side effect  | 更新 main selected tab，标记其它同 scope tab inactive；仅当该 scope 正在前台时显示/展开目标 view | 后台对话抢占当前 workspace/session UI；激活失败后仍执行页面动作                       |
| 后续动作          | 使用本次 get 返回的精确 tabId 执行                                                               | 退化为“当前默认 tab”或跨 scope tab                                                    |
| `tabs.selected()` | 只读取当前 effective active，不承担用户明确选择的替代品                                           | 把返回值当成模型多 tab 消歧的依据，或据此跳过 list→match→get 预检                      |
| 系统 effective active | 无显式 selected 时由 main 按固定顺序回退出唯一 active（见下节），使 `tabs.list()` 的 `active` 与不带 tabId 的命令落点一致 | 把该回退当作模型的目标选择依据；在已有显式 selected 时用回退覆盖它                     |

### 系统 effective active 回退（不是模型目标选择）

上表「目标匹配（模型侧）」禁止的位置猜测只约束**模型侧消歧**。它不适用于以下两处——这两处没有
「用户/模型明确选择」可用，必须由系统给出确定性答案：

- `tabs.list()` 的 `active` 字段计算；
- `resolveTab()`：命令**根本没带 tabId** 时的落点。

`BrowserGuestManager.effectiveActiveTabId()` 的顺序，命中即停：

1. `activeTabByScope`（显式 `tabs.get` / 激活的结果）且该 tab 未 closed；
2. tab 自报 `active`（human tab 在 claim 前只置 `tab.active`，不写 `activeTabByScope`）；
3. 该 scope 内最近未关闭的 logical tab（`logicalOwnedTabs(context).at(-1)`）。

命中即停，因此同 scope 仍最多一个 `active=true`，上表 `tabs.list()` 的不变量不变。

**第 3 步的适用前提**：scope 内既没有显式 active、也没有 tab 自报 active。典型状态是**会话在后台跑**
——renderer 的 `isVisible = pane 展开 && tab 选中`，后台恒为 false，于是只上报
`attachGuest({ active: false })`，`activeTabByScope` 与 `defaultTabByScope` 皆空。此时不回退的后果：
`tabs.list()` 报零个 active，下游按 `active` 寻址就永远拿不到轮尾截图（见
`2026-07-15-browser-turn-final-screenshot-spec.md`）；`resolveTab()` 则会凭空新开一个空 tab，反而让
list 报的 `active` 与实际落点不一致。

**不允许**：模型不得用 `active` 或 `tabs.selected()` 代替 `list → match → get` 预检；BTA-005 /
BTA-007 的多 tab 消歧规则不因该回退放宽。回退是「系统必须给出一个落点」的兜底，不是「最后一个 tab
就是用户想要的那个」的承诺。

同形回退在实现里早于本节存在：`browserGuestManager.ts` 的 visibility 路径、CLI facade 的
`tabs.selected()`（`find(active) ?? at(-1)`）都是这个形状。本节把它写实为跨层一致的系统语义，
而不是各处独立的临时兜底。

## Domain scope and high-risk cross-products

主域是 browser client facade、browser command protocol、desktop main tab registry 与 renderer side pane。

- list 结果 × user 手动切 tab：下一次逻辑操作必须重新 list，不能信任旧 active。
- 多 agent-created tab × 同 URL：必须按稳定 id 或更多已知事实消歧；不得位置猜测。
- active tab × collapsed side pane：显式 get 仍应发送 show/activate，让用户看到即将被操作的页面。
- background session/workspace × activate event：renderer 只能后台更新归属 tab，不能抢当前 active scope。
- desktop-continuous × web-remote-replayable：命令仍经 shared host；不把 tab 状态下沉 relay/main 之外的新层。

## Concept map and state owners

| 概念                                     | owner                                                         | 证据                              |
| ---------------------------------------- | ------------------------------------------------------------- | --------------------------------- |
| list/get facade 与 Tab binding           | `apps/zcode-cli/packages/core/src/browser-client/facade.ts`   | command trace + core unit test    |
| command schema                           | `packages/shared` 与 `apps/zcode-cli/packages/contracts` 镜像 | runtime schema parse test         |
| selected logical tab、scope、visibility callback | `BrowserGuestManager`                                         | manager unit test + response meta        |
| suspended/restoring 与 guest residency           | `BrowserTabResidencyCoordinator`（待实现）                    | residency policy/repository/Electron E2E |
| side-pane active/reveal                  | `applyBrowserUseSidePaneEvent` / `useAppPanels`               | UI state unit test                |
| 模型操作规则                             | browser-use plugin skill/docs/API semantics                   | documentation assembly test       |

## Candidate combinations

| Case    | State                              | Event                | Expected effect                                                                    | Classification                   |
| ------- | ---------------------------------- | -------------------- | ---------------------------------------------------------------------------------- | -------------------------------- |
| BTA-001 | 当前对话内 A active，B background  | `tabs.get(B)`        | list→activate B；B active/visible，A inactive                                      | accepted；旧实现为 bug-candidate |
| BTA-002 | 前台 scope 的 side pane collapsed，B 已 selected | `tabs.get(B)` | 仍发 activate/show，重新展开 B                                                     | accepted                         |
| BTA-003 | 对话 X 在后台，用户正在看对话 Y    | X 执行 `tabs.get(B)`，随后用户切回 X | backend 把 B 设为 X 的 active 并记住偏好；Y 的任务、side pane 和 active tab 均不变；切回 X 后展示 B 并主动展开 | accepted                         |
| BTA-004 | list 后目标被关闭                  | `tabs.get(id)`       | activate 明确失败，不返回可操作 Tab                                                | accepted                         |
| BTA-005 | 多 tab                             | 新逻辑操作批次       | 第一条 JS 返回 list；模型观察后第二条 JS 按 id/url/title match→get→action          | accepted                         |
| BTA-006 | 同一 cell 已 get 目标              | 连续 snapshot/click  | 继续使用精确 tabId，不强制重复 list                                                | pruned；目标未跨异步边界变化     |
| BTA-007 | 多 tab 无法唯一匹配                | 准备 action          | 先获取更多可见事实或向用户确认，不猜位置                                           | accepted                         |
| BTA-008 | 目标 logical tab 已 suspended                    | `tabs.get(id)`                       | 恢复同一 stable id 后激活；guest id 可变化；失败时返回 typed error                                             | accepted；遵循 tab residency 策略   |

## Accepted assertions and evidence

| Case        | Assertions                                                                                     | Evidence                        |
| ----------- | ---------------------------------------------------------------------------------------------- | ------------------------------- |
| BTA-001/002 | core command 顺序为 list→activateTab；manager selected/meta 指向 B；visibility callback 收到 B | core + desktop unit tests       |
| BTA-003     | callback/active map 只作用于完整 browser scope；renderer 记录 X 的 preferred tab 但保持 Y 前台；切回 X 后即使 Y 曾令 pane 收起也恢复并展开 B | desktop manager + UI scope test |
| BTA-004     | unknown/stale id 返回 structured error，未产生 activate callback                               | core + manager unit tests       |
| BTA-005/007 | effective documentation 明确包含 preflight 和禁止位置猜测                                      | browser manifest test           |

## Coverage and E2E handoff

- 更新 `docs/testing/browser-use-codex-parity-coverage-matrix.md`，新增 BCP-053/054/055 激活、后台 scope 与预检断言。
- 本次先用 shared schema、core facade、desktop manager 与 UI state unit tests 机械证明，不新增 conversation E2E。
- 后续真实 UI E2E 可打开 A/B 两页，先展示 A，再执行 `tabs.get(B)`，断言 B trigger 和 B webview 同时激活。
- 不新增 mobile replay snapshot 字段，不改变 workspace identity、remoteSessionId 或 owner/lease 路由。
