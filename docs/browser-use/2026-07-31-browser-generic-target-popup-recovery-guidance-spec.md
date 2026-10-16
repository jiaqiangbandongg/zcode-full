# Browser Use 新 URL 等待、通用目标点击与新标签恢复 Guidance Spec

> 状态：已实现并完成契约验证
> 日期：2026-07-31
> 范围：ZCode CLI Browser Use agent guidance（Skill、随包文档、fallback 文档）

## 1. 背景与问题

同一网页快照中，目标书名暴露为 `heading`，页面没有把它声明成 `link`：

- ZCode 把书名改写成猜测的 `link` role，`count()` 得到 `0` 后判定“书名标题本身不是链接”，没有执行点击。
- 正确做法是保留快照里已经证实的标题/文本定位，点击 `h3`：页面卡片的 JavaScript click handler 接收到冒泡事件，并在新标签打开详情页。
- 但若点击后只检查源标签 URL，源 URL 未变化时就会再次点击，轨迹中已观察到最终打开两个相同详情标签。

因此问题不在底层点击能力，而在 action planning 与 action 后观察协议：

1. agent 不应把快照里的真实语义角色替换成猜测角色。
2. 用户意图已经授权导航、目标文本唯一时，通用 heading/text 也可以成为点击目标。
3. 源标签 URL 未变化不能证明点击失败；页面可能通过 popup/new tab 完成导航。
4. 每次状态变更动作后必须先观察，再决定是否重试，避免重复副作用。
5. action 后不能把 controlled list 非空当作成功；必须判断本次动作的预期效果是否出现在源页面、
   controlled tab 或 claimable user tab 中。
6. action 可能打开 popup/new tab 且源标签没有出现预期效果时，若把两套 tab 查询拆成两个 observation
   cell，模型可能在看到第一套结果后重新决策并跳过第二套，仍然遗漏新窗口。
7. 新 URL 的标准轨迹应在 `tab.goto(url)` 后显式调用
   `tab.playwright.waitForLoadState({ state: "domcontentloaded" })`，再读取标题、URL 或 DOM；ZCode 的
   runtime `goto()` 虽然已经等待 Electron 导航完成，但 guidance 没有保留这一步，导致模型轨迹缺少显式等待。

## 2. 目标

- 让 ZCode 对 JavaScript 驱动的卡片、标题和可见文本采用快照证据，而不是依赖必须存在的 `<a>` / `link` role。
- 在源标签 URL 未变化时，先检查 agent 已控制标签和可认领用户标签，再考虑重新定位。
- action 后以预期 URL、标题或页面状态是否出现作为成功依据；已有源标签或无关 controlled tab
  仍存在不算动作效果。
- action 可能打开新窗口且源标签未出现预期效果时，在同一个 observation cell 中无条件读取
  `browser.tabs.list()` 与 `browser.user.openTabs()`，统一返回两套状态后只做一次模型决策。
- 约束为“一次状态变更动作对应一次观察周期”，避免重复打开标签、重复提交或重复购买。
- 新 URL 的标准轨迹固定为 `goto()` → 显式 `waitForLoadState({ state: "domcontentloaded" })` → 首次页面观察，
  使模型可见调用顺序稳定一致。
- 保持现有 locator strictness、actionability、安全审批、tab claiming 和多端 delivery 边界不变。

## 3. 非目标

- 不修改 Playwright locator、Electron CDP trusted input、popup 路由或 tab claiming 的运行时实现。
- 不修改 `goto()` 的底层完成条件，也不改变现有 URL/load-state wait 的 3000ms 运行时上限；本次只统一
  provider-visible guidance 的显式调用序列。
- 不新增聚合 tab API；现有 Node REPL cell 直接组合两个只读查询。
- 不新增协议字段，不改 `desktop-continuous` / `web-remote-replayable`。
- 不为特定网站增加 selector 或站点脚本。
- 不把通用点击升级成绕过审批的权限。
- 本次不新增 Conversation E2E；模型供应商差异与真实站点变化不适合作为确定性门禁。

## 4. Impact Brief

### 4.1 Feature Summary

| Field | Value |
| --- | --- |
| Developer intent | 补齐新 URL 显式 DOMContentLoaded 等待、非链接标题/卡片点击能力，并修复 popup 场景的重复点击风险 |
| Capability | `capability.browser-use-agent-guidance` |
| Change layer | guidance sequencing + validation + recovery |
| Operating mode | implementation-handoff |
| Primary seeds | `control-browser/SKILL.md`、Browser API manifest/included docs、`documentation.ts` fallback、Node REPL tool description、tab recovery runtime hint、契约测试 |
| Out of scope | 浏览器 runtime、CDP、协议、UI、远控同步、站点特化 |

### 4.2 UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display/draft owner | Default/inherit source | Validation/gating | Commit action | Authority/persistence | Mode boundary | Must remain isolated from |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 用户要求打开唯一标题对应的详情页 | Conversation prompt → Browser Use | Browser Skill + 动态文档 | 模型当前 turn | `domSnapshot()` 证据 | snapshot 目标真实类型、`count() === 1`、既有安全审批 | `locator.click()`，每观察周期至多一次 | browser backend/tab runtime；不新增持久化 | desktop 与 web remote 共用 agent guidance；各自沿既有 delivery 传递结果 | task snapshot、relay、workspace identity |
| 用户要求打开新 URL | Conversation prompt → Browser Use | Browser Skill + API semantics + included/fallback docs | 模型当前 turn | 用户或权威事实提供的 URL | `goto()` 成功后显式等待 `domcontentloaded`，再读取标题/URL/DOM | `tab.goto(url)` → `tab.playwright.waitForLoadState(...)` | browser backend/tab runtime；不新增持久化 | desktop 与 web remote 共用 agent guidance；各自沿既有 delivery 传递结果 | `goto()` runtime 完成条件、协议、task snapshot、relay |
| 点击后源 URL 未变化 | Browser Use action result | tab list / claim API | 模型当前 turn | 本次动作预期的 URL、标题或页面状态 | action 可能打开新窗口时，在同一 observation cell 中无条件并发读取 `browser.tabs.list()` 与 `browser.user.openTabs()`，统一返回后只判断一次 | activate/claim 呈现预期效果的标签；完整观察返回前禁止再次点击 | browser backend 的 tab ownership；不新增聚合 API 或持久化 | 不改变 desktop continuous 与 mobile replayable 语义 | 操作前 tab 选择、UI draft、remote command queue |

### 4.3 Shared And Divergent Behavior

| Concern | Shared across surfaces | Deliberately different | Why it matters for this change |
| --- | --- | --- | --- |
| UI/component | 无 UI 组件改动 | 无 | 该问题发生在模型工具规划层 |
| Option source | 所有 backend 都以真实 snapshot 为定位证据 | backend 能力集合仍可不同 | 不能把 IAB 观察结论假定成 HTML role |
| Default/inheritance | Skill、API semantics、动态文档与 Node REPL tool description 共同约束默认行为 | fallback 文档只保留最小关键规则 | 任一注入路径都不能回退到拆分 popup 观察 |
| Navigation sequencing | 新 URL 都采用 `goto` → `domcontentloaded` → observation | 已在目标 URL 的 tab 不重复 `goto`；click 导航继续按 action 后预期效果协议观察 | 固定新 URL 的模型轨迹，同时避免把规则误扩张到所有 action |
| Validation | 快照真实类型 + 唯一匹配；action 后匹配预期效果 | CSS/text/role 的具体 locator 与 URL/title/state 效果证据可按场景选择 | heading/text 是合法目标；controlled list 是否非空不是成功证据 |
| Commit effect | 每次状态变更后立即进入观察周期，并以预期效果是否出现判断成功 | 同页导航与新标签导航的效果证据不同 | 源 URL 不变或旧 controlled tab 仍存在都不能单独判定成功/失败 |
| Persistence/recovery | action 可能打开新窗口且源页无预期效果时，一个 cell 同时返回 controlled/claimable 两套 tab 状态 | 操作前目标 tab 选择仍先返回列表、后绑定；用户标签仍需显式 claim | 防止模型在两套观察之间重新决策 |

### 4.4 Feature Relationships

| Rank | From | Semantic edge | To | Condition | Why inspect it | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| must-inspect | `capability.browser-use-agent-guidance` | guides tool planning in | `capability.agent-core-runtime` | Browser Use 被加载到模型上下文 | 保证 Skill、included docs、fallback 一致 | `documentation.ts` |
| evidence-only | `capability.browser-use-agent-guidance` | covered by | `evidence.browser-use-agent-guidance-tests` | 打包与 fallback 两条文档路径 | 防止 guidance 漂移 | `browser-manifest.test.ts` |
| invariant-only | `capability.browser-use-agent-guidance` | must not change delivery | `boundary.desktop-continuous` | desktop 本地实时链路 | 不把 popup 观察变成 task 恢复状态 | 现有远控架构约束 |
| invariant-only | `capability.browser-use-agent-guidance` | must not change delivery | `boundary.web-remote-replayable` | 手机远控恢复链路 | 不绕过 shared-host/replayable 边界 | 现有远控架构约束 |

### 4.5 State Owners And Commit Sinks

| State/fact | Draft/display owner | Authoritative owner | Commit command/service | Persistence/cache | Evidence |
| --- | --- | --- | --- | --- | --- |
| snapshot 中目标的角色与文本 | 模型当前 turn | 当前页面 DOM snapshot | 无；只用于 locator 规划 | 不持久化 | `domSnapshot()` contract |
| 新 URL 导航后的 DOMContentLoaded 确认 | 模型当前 turn | browser backend 的当前 tab load state | `tab.playwright.waitForLoadState({ state: "domcontentloaded" })` | 不持久化 | Playwright facade + guidance contract |
| 点击是否发生 | 模型 action plan | browser backend | `locator.click()` | browser tab runtime | Playwright facade / desktop executor |
| 点击后是否出现新标签 | 模型观察结果 | controlled/user tab registries | `tabs.list()` / `user.openTabs()` / `user.claimTab()` | 既有 tab ownership | Browser docs 与 tab claiming contract |

### 4.6 Must-Preserve Invariants

| Invariant | Surfaces/modes | Proof needed | Evidence |
| --- | --- | --- | --- |
| 不把 snapshot-proven `heading` 改写为猜测的 `link` role | 所有 Browser Use backend | Skill、打包文档、fallback 均有明确约束 | BCP-218 契约测试 |
| 用户已授权导航且目标唯一时，heading/text 可以直接点击 | 所有 Browser Use backend | guidance 明确“真实类型优先” | BCP-218 契约测试 |
| 一次状态变更动作后必须观察，观察前不得重试 | 所有副作用动作 | Skill/workflow/playwright 文档一致 | BCP-219 契约测试 |
| action 后只以预期 URL、标题或页面状态是否出现判断成功，不以 controlled list 非空判断 | popup/new-tab | guidance 明确旧源标签/无关 controlled tab 不算效果，且没有预期效果时继续检查 claimable user tabs | BCP-219 契约测试 |
| popup 恢复的两套 tab 查询必须在同一 observation cell 中统一返回，之间不得插入模型决策 | popup/new-tab | Skill、API semantics、bundled/fallback docs 与 tool description 使用同一原子观察规则，并禁止 separate/dedicated list calls | BCP-219 契约测试 |
| 操作前 tab 选择与 action 后 popup 观察是两个不同协议 | 所有 tab 操作 | API/Skill 明确前者“观察后绑定”，后者“同 cell 返回两套状态” | BCP-219 + 既有 tab recovery tests |
| 新 URL 的 `goto()` 后、首次页面读取前必须显式等待 `domcontentloaded` | 所有 Browser Use backend | Skill、API semantics、included docs、Playwright docs 与 fallback 使用同一调用顺序 | BCP-223 契约测试 |
| 显式等待只对齐 guidance 轨迹，不改变 runtime timeout 或 navigation owner | desktop-continuous / web-remote-replayable | runtime/protocol/UI 无 diff；文档继续声明 3000ms 上限和不支持 `networkidle` | BCP-223 + diff 检查 |
| 不修改安全审批与 destructive action 边界 | 所有模式 | 现有 safety 文档与 runtime 测试继续通过 | 既有 Browser Use coverage |
| 不改变 desktop/mobile delivery | desktop-continuous / web-remote-replayable | 无 protocol/runtime/UI diff | diff 检查 + typecheck/lint |

### 4.7 Codegraph Evidence

当前工作区没有可调用的 Codegraph 工具；按 skill fallback 使用 symbol/path 直接扫描，结果作为等价的 depth-2 静态证据。

| Seed | Query | Direct callers / key path | Depth | Interpretation |
| --- | --- | --- | --- | --- |
| `loadBrowserDocumentation` | `rg` callers/callees | Browser MCP manifest → bundled docs / `FALLBACK_DOCUMENTATION` | 2 | 动态文档与 fallback 都必须更新 |
| `locator.click` | `rg` callers/callees | core Playwright facade → desktop locator executor → CDP input | 2 | 底层已经支持点击非 link 元素，不需要 runtime 改造 |
| `browser.tabs.list` / `browser.user.openTabs` | docs/API/source scan | Node REPL 可在同一 cell `Promise.all` 两个只读调用；ambient context 已并行读取两套 registry；随后按证据 `tabs.get` / `user.claimTab` | 2 | popup 恢复使用现有 API 即可，不需要 runtime helper |
| `buildJsToolDescription` / `TAB_CONTEXT_RECOVERY_HINT` | `rg` callers/callees | provider-visible Node REPL metadata 与 desktop stale-binding error 都会影响模型恢复规划 | 2 | 必须明确 action 后原子观察与操作前 stale-binding 恢复的区别 |
| `Tab.goto` / `PlaywrightAPI.waitForLoadState` | `rg` callers/callees | Browser facade 分别映射 navigate 与 Playwright action；Skill、included docs、API semantics 和 fallback 决定模型调用顺序 | 2 | runtime 已具备能力，只需锁定 provider-visible guidance 顺序 |

### 4.8 Graph Drift Candidates

| Candidate | Live-code evidence | Missing/stale graph relation | Proposed follow-up |
| --- | --- | --- | --- |
| provider-visible Browser Use guidance seeds | `buildJsToolDescription`、API manifest 与 desktop stale-binding error 都会影响模型对 tab 恢复的理解 | capability 已存在，但 code seeds 只覆盖 Skill/fallback，漏掉 tool description、API semantics 与 runtime error hint | 本次补齐同一 capability 的 code seeds，不新增产品节点 |

### 4.9 Graph Delta

| Status | Node/edge | Semantic reason | Evidence | Action |
| --- | --- | --- | --- | --- |
| confirmed | `capability.browser-use-agent-guidance.codeSeeds` | action 后恢复语义同时来自 Skill、API manifest、fallback/tool description 和模型可见 runtime hint | 用户要求全量统一 + `rg` 审计 | 增加 API manifest、`buildJsToolDescription`、`TAB_CONTEXT_RECOVERY_HINT` seeds |
| confirmed | `capability.browser-use-agent-guidance` label/aliases/codeSeeds | 该 capability 现在同时承载新 URL 显式 load-state 等待；Playwright 文档也是权威 guidance seed | 用户确认新 URL 轨迹形式 + provider-visible path scan | 增加 navigation wait 别名并登记 `docs/playwright.md` seed |
| none | 既有 agent core / evidence / delivery edges | 本次未新增 capability、owner 或 delivery 关系 | feature graph + 全量 `rg` 审计 | 保持现有 edges |

### 4.10 Unresolved Questions

| Question | Candidate answers | Scope difference | Owner |
| --- | --- | --- | --- |
| none | 目标语义已经由用户确认；真实模型/网站 smoke 可作为后续非阻塞验证 | 不影响本次契约实现 | — |

### 4.11 Planning Handoff

| Item | Destination | Status |
| --- | --- | --- |
| Spec update | 本文档 | complete |
| Case catalog | 不需要 Conversation E2E case catalog | not-needed |
| Coverage matrix | `docs/testing/browser-use-codex-parity-coverage-matrix.md` BCP-218/219/223 | complete |
| Decision backlog | 无未决产品语义 | not-needed |
| E2E handoff | guidance 契约测试足够；真实模型 smoke 非门禁 | not-needed |

## 5. 行为规范

### 5.1 新 URL 导航等待规范

```text
verified new URL
      |
      v
tab.goto(url)
      |
      v
tab.playwright.waitForLoadState({ state: "domcontentloaded" })
      |
      v
first title / URL / domSnapshot observation
```

1. 只有任务确实指向一个尚未打开的新 URL 时才执行 `goto()`；已在目标 URL 时不得重复导航。
2. 每次成功的 `tab.goto(url)` 后，首次读取标题、URL 或 DOM 前必须显式调用
   `await tab.playwright.waitForLoadState({ state: "domcontentloaded" })`。
3. 该调用是模型轨迹合同：即使 backend 的 `goto()` 已经等待导航完成，也不得从 guidance 示例中省略。
4. 不得把状态替换成不受支持的 `networkidle`，也不得用固定 `waitForTimeout()` 代替可观察的 load state。
5. 现有 routine URL/load-state wait 的 3000ms 上限保持不变；本次不修改 runtime timeout 语义。

### 5.2 定位规范

1. 先调用 `domSnapshot()`，定位器必须来源于当前快照。
2. 保留快照暴露的真实目标类型。若目标是 `heading`，不得为了“可点击”而猜测它是 `link`。
3. 用户已经明确要求打开/进入该唯一目标时，可对 snapshot-proven 的 heading、visible text 或 generic element 执行点击。
4. 点击通用元素仍必须满足 `count() === 1`、actionability 和安全审批；该规则不授权模糊命中或绕过确认。
5. DOM click 可以冒泡到祖先的 JavaScript card handler；HTML role 不是点击能力的前置条件。

### 5.3 Action 后观察规范

```text
fresh snapshot
      |
      v
snapshot-proven locator -- count === 1 --> click once
                                              |
                                              v
                                observe expected URL/title/state
                                      /                 \
                             effect present          effect absent
                                  |                       |
                            inspect/use result       can action open new tab?
                                                    /                  \
                                                  yes                  no
                                                   |                    |
                                      one observation cell:       targeted source
                                      Promise.all([               observation /
                                        browser.tabs.list(),      fresh snapshot
                                        browser.user.openTabs()
                                      ])
                                                   |
                                      return { controlledTabs,
                                               userTabs }
                                                   |
                                          one model decision
                                            /             \
                              expected effect found?       no effect
                                      |                       |
                              activate/claim/use          fresh snapshot,
                                                        choose new plan
```

- 一个观察周期只允许一次状态变更动作。
- 源标签 URL 未变化只表示“没有在源标签完成 URL 导航”，不表示点击失败。
- action 后必须判断本次动作预期的 URL、标题或页面状态是否出现；`browser.tabs.list()` 非空、旧源标签仍在
  或存在无关 controlled tab 都不算动作效果。
- action 可能打开 popup/new tab 且源标签未出现预期效果时，必须在同一个 observation cell 中无条件读取
  `browser.tabs.list()` 与 `browser.user.openTabs()`；推荐使用 `Promise.all`，并把
  `{ controlledTabs, userTabs }` 作为该 cell 的最终结果统一返回。
- 两套 tab 状态完整返回前不得让模型重新决策；禁止先单独返回 controlled tabs，再根据其内容决定是否查询
  user tabs。
- 统一结果返回后，模型只做一次效果判断：按预期 id/url/title/state 匹配 controlled 或 claimable tab，
  必要时在下一 cell 执行 `tabs.get` 或 `user.claimTab`。
- “操作前选择目标 tab”仍是另一条协议：先让模型看到候选列表，再在下一 cell 绑定目标；不得把该规则
  误用于 action 后 popup 效果观察。
- 完成上述观察前不得重复点击。
- 源页面、controlled 与 claimable tab 均没有呈现预期效果时，重新获取快照并选择新 locator；
  不得在旧证据上盲重试。

## 6. 验收用例

| Case ID | Setup | Action | Assertions | Evidence layers | E2E status |
| --- | --- | --- | --- | --- | --- |
| BCP-218 | snapshot 只有唯一 `heading`/visible text，没有 `link` role | 规划 locator | guidance 要求保留真实类型，允许用户授权下点击唯一通用目标，禁止猜 `link` | Skill + bundled docs + fallback contract | not-needed |
| BCP-219 | 点击可能触发 popup，源标签 URL/state 未出现预期效果，controlled list 仍包含旧源标签 | action 后恢复 | 同一 observation cell 无条件读取并统一返回 controlled/user tabs；两次查询之间没有模型决策；统一返回后只以预期 URL/title/state 判断一次；观察完成前不得再次 click | Skill + API semantics + bundled/fallback docs + Node REPL tool description contract | not-needed |
| BCP-223 | 任务提供一个尚未打开的新 URL | 创建 tab 并 `goto(url)` | Skill、API semantics、overview/workflow/playwright 与 fallback 都要求在首次页面观察前显式执行 `waitForLoadState({ state: "domcontentloaded" })`；不使用 `networkidle` 或固定 sleep | core Browser guidance contract | not-needed |

## 7. 剪枝决策

| Decision ID | Pruned combinations | Guard/invariant | Product reason | Representative coverage |
| --- | --- | --- | --- | --- |
| PRUNE-001 | 特定图书网站 DOM 与 selector | 规则必须依赖通用 snapshot 证据 | 避免站点特化和脆弱 fixture | BCP-218 |
| PRUNE-002 | 每个模型供应商 × reasoning effort | 文档契约是确定性门禁 | 模型输出存在采样差异，不适合作为提交门禁 | BCP-218/219/223 |
| PRUNE-003 | desktop/mobile 各跑一次 popup/导航 E2E | runtime 与 delivery 没有改动 | 现有 tab/runtime coverage 已验证底层能力 | BCP-219/223 + 既有 tab lifecycle tests |

## 8. 实施顺序

1. 回填 feature graph 与 Browser Use 覆盖矩阵。
2. 先补 `browser-manifest.test.ts` 中的失败契约。
3. 更新 Skill、Playwright/workflow/overview 文档与 fallback 文档。
4. 运行定向测试、`pnpm typecheck`、`pnpm lint`。
5. 更新本文档的验证记录并提交。

## 9. 验证记录

| 验证项 | 结果 |
| --- | --- |
| BCP-219 red phase | API semantics 与 Node REPL 模型可见工具描述的同 cell 双查询断言按预期失败，证明旧 guidance 仍允许模型在半份 tab 证据上重新决策 |
| BCP-223 red phase | `navigationWait` 缺少显式 `domcontentloaded` 调用时契约按预期失败，证明旧 guidance 缺少新 URL 的显式等待调用顺序 |
| `pnpm exec vitest run tests/browser-manifest.test.ts tests/node-repl-tools.test.ts tests/node-repl-browser-injection.test.ts` | 3 files / 37 tests 通过；覆盖 Skill、API manifest、overview/workflow/playwright、effective/fallback docs、tool description 与现有 tab registry 注入兼容性 |
| `pnpm exec vitest run packages/desktop/test/browserGuestManager.test.ts` | 1 file / 57 tests 通过；确认 stale-binding hint 明确限定为 action 前恢复，不与 action 后 popup 观察混用 |
| `pnpm --filter @zcode/browser-use-plugin test` | 6 files / 29 tests 通过 |
| `@zcode/core typecheck` | 通过 |
| `@zcode/browser-use-plugin build` | 通过 |
| ZCode CLI workspace typecheck | 23/23 tasks 通过；受影响的 core/browser-use-plugin 均实际执行 |
| 根仓库 `pnpm typecheck` | 通过 |
| 根仓库 `pnpm lint` | 通过，36 warnings、0 errors；warning 均不在本次变更文件 |
| feature graph YAML/edge/seed 校验 | 150 nodes、259 edges、217 code seeds；无重复 node/edge、悬空 edge 或缺失 code seed |
| Browser Use 矛盾文案复扫 | 新 URL 的 provider-visible 路径均为 `goto` → `domcontentloaded` → 首次观察，并统一声明 3000ms 上限；旧的“先返回 controlled list”“分开 observation”文案只保留在负向契约断言中 |
