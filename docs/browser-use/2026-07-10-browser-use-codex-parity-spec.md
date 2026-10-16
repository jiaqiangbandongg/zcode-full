# Browser Use 完整行为规格

> 状态：目标规格；以行为和职责同构为准，采用 clean-room 实现。
> 范围：Browser Use 的 backend、对象图、选择、生命周期、Playwright facade、安全与 response meta 合同；旧版本轨迹只作历史背景。
> 优先级：先保证效果与边界正确，再替换/扩展 backend 实现；禁止伪造“可用”能力。
> 实施记录：2026-07-10 已完成 Slice A；Slice B 的 IAB scope/generation/lifecycle/response meta 与 Slice C 的 member-level capability manifest 已实现。Chrome extension/CDP producer 当前只保留注册口，不纳入本轮交付。
> DOM-first 增量：2026-07-10 已完成默认提示/示例回显、screenshot guidance lookup、IAB 有界语义 DOM 和对应合同测试；common `Tab.playwright` 对象图与 IAB clean-room executor 已进入 Slice C，跨源 frame/shadow DOM 仍需真实页 E2E 收口。
> IAB 行为收口：2026-07-10 起不再把“方法名齐全”视为 Playwright 行为完成。本轮以同一份
> Playwright injected runtime 驱动 snapshot 与 locator，以 CDP `Input` 驱动可信 click/type/press，
> 并把 `BrowserUser`、`Tabs.finalize({ keep })`、真实 tab identity、URL 脱敏和 backend cancel
> 作为 IAB 完成门槛。Chrome extension 与独立 CDP provider 继续只保留接口，不计入本轮。
> 2026-07-12 语义收口：URL、CUA/DOM CUA、Locator media download、undocumented helper、正则 guidance、
> `networkidle` 与 `expectNavigation` 按动态有效面重新冻结，详见
> `2026-07-12-browser-use-codex-runtime-semantics-alignment-spec.md`。
> 2026-07-14 pointer action 收口：`click` / `dblclick` / `setChecked` 不再依赖单个
> `checkElementStates()` probe。实现必须按以下顺序完成 selector target identity、
> visible/enabled、滚动、连续 bounding rect 稳定、frame chain 顶层坐标换算、逐层 hit-target
> 检查和 CDP trusted input；缺失或畸形的 CDP payload 必须作为结构化执行错误返回。

## 1. 产品目标

ZCode Browser Use 最终应让同一份 browser-use skill/browser-client 在以下三类 backend 上工作：

- `iab`：ZCode in-app browser。
- `extension`：ZCode 自有 Chrome extension + native host，控制用户 Chrome。
- `cdp`：独立、受 feature/security gate 的 CDP backend。

Playwright 是三类 backend 之上的统一 `Tab.playwright` facade，不是 backend。模型对 `agent.browsers` 的选择、对象图、错误、capability、安全确认、tab 生命周期和 response meta，由本规格统一冻结，三类 backend 保持一致。

## 2. 已确认的边界决策

| 决策               | 结论                                                             | 原因                                                                        |
| ------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------- | --------------------------------- |
| backend enum       | `iab                                                             | extension                                                                   | cdp`           | 三类 backend 共用同一 observable contract |
| Playwright         | Tab API 层                                                       | 避免错误建成第四 backend                                                    |
| Chrome 资产        | ZCode clean-room 自研                                            | 不依赖任何第三方私有插件或二进制                                            |
| IAB transport      | 保留 ZCode Protocol adapter                                      | 兼容 local/remote shared-host 架构                                          |
| browser identity   | descriptor 的 runtime id，不用 type 代替                         | 支持多个 Chrome profile/window/peer                                         |
| workspace identity | `workspaceIdentity?.trim()                                       |                                                                             | workspacePath` | 遵守隔离语义                      |
| client mode        | 每次 request 必带                                                | 保持 desktop continuous / web replayable 边界                               |
| API 支持           | capability/API manifest 动态裁剪                                 | 不暴露必定抛错的假方法                                                      |
| 低层结果           | protocol 保留结构化 result                                       | facade 才 direct-return/throw                                               |
| 安全               | command/action-time policy 独立于 js gate                        | 防止一次批准后无限副作用                                                    |
| 页面观察           | 普通导航/阅读/交互默认使用可见语义 DOM                           | DOM 比图片便宜且能提供稳定定位依据                                          |
| 模型截图           | 仅在用户明确要求视觉结果、布局/渲染判断或 DOM 无法表示目标时发送 | 禁止“打开页面后顺手截图”和 snapshot+screenshot 双观察                       |
| 文档装载           | screenshot guidance 为按需 lookup，不进入默认完整 API            | 避免通用提示反复强化 `emitImage(screenshot())`                              |
| response meta      | 不自动生成客户端预览截图；模型截图仍按视觉分支显式获取           | 产品明确选择：避免普通导航生成大体积截图元数据                              |
| 实现来源           | clean-room 自研，不复制任何第三方私有源码                        | 合规与可维护性                                                              |

## 3. 目标分层

```text
Node REPL runtime（通用、与 browser-use plugin 解耦）
  └─ plugin browser-client bootstrap
      ├─ BackendDiscovery
      ├─ BrowserRegistry / selection
      ├─ API manifest interpreter
      ├─ Documentation composer
      ├─ SecurityPolicy / confirmation
      ├─ ResponseMeta collector
      └─ Browser → Tabs → Tab common APIs
          ├─ playwright
          ├─ cua
          ├─ dom_cua
          ├─ content
          ├─ clipboard
          └─ dev/capabilities

Backend providers
  ├─ IabBackendConnection
  │   └─ ZCode Protocol → shared host → desktop main → webview guest/CDP
  ├─ ExtensionBackendConnection
  │   └─ native pipe → ZCode native host → Chrome extension
  └─ CdpBackendConnection
      └─ native pipe/direct gated host → CDP targets

Official plugins
  ├─ browser: shared client/API/docs + IAB-oriented entry
  └─ chrome: same shared client/API/docs + extension host/install/diagnostics
```

## 4. Backend-neutral 契约

### 4.1 Descriptor

```ts
type BrowserBackendType = "iab" | "extension" | "cdp";

interface BrowserCapabilityDescriptor {
  id: string;
  description: string;
}

interface BrowserBackendDescriptor {
  id: string;
  generation: number;
  type: BrowserBackendType;
  name: string;
  capabilities: {
    browser?: BrowserCapabilityDescriptor[];
    tab?: BrowserCapabilityDescriptor[];
  };
  apiSupportOverrides?: Record<string, boolean>;
  metadata?: Record<string, string>;
}
```

约束：

- `id` 是 runtime connection identity，可同时存在多个同 type backend。
- `type` 只表示 backend family。
- `list()` 只返回真实可达、完成 handshake 的 backend；不允许 facade 伪造 available。
- metadata 不包含 secret；Chrome 可包含 profile/instance/window selection 所需的非敏感标识。

### 4.2 Session context

```ts
interface BrowserSessionContext {
  requestId: string;
  browserId: string;
  browserGeneration: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  turnId?: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  sessionContext: "live" | "cached";
}
```

约束：

- requestId 从 browser-client 到 backend 端到端不变。
- requestId 是进程内请求生命周期的 correlation key，不是可覆盖的 latest-value 状态。只要同一
  host bridge 或 main manager 中仍有该 ID 的运行中 entry，任何同 scope 或跨 scope 的重复请求都必须
  在 backend dispatch 前以 `duplicate_request_id`、`sideEffect: "none"` 失败；随机 UUID 只负责生成，
  不能替代状态所有者边界的机械唯一性校验。
- pending/running entry 的 timeout、transport failure、result 和 `finally` 清理必须 compare-and-delete：
  只有 Map 当前仍指向闭包捕获的同一 entry 时才能删除，旧请求的迟到清理不得删除后来登记的状态。
- workspaceKey 只用于身份/隔离；文件和命令 cwd 用 workspacePath。
- remote workspace 必须带 workspaceIdentity 和 remoteSessionId。
- AbortSignal/timeout 必须能取消尚未开始的请求，并尽可能终止 backend 动作；若动作可能已发生，错误必须明确“不确定是否已产生副作用”。
- stale connection/generation 不能接收新请求。

### 4.3 Port

```ts
interface BrowserBackendPort {
  list(context: BrowserDiscoveryContext): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    context: BrowserSessionContext;
    command: BrowserCommand;
    signal?: AbortSignal;
  }): Promise<BrowserCommandResult>;
  turnEnded?(context: BrowserSessionContext): Promise<void>;
  closeSession?(context: BrowserSessionContext): Promise<void>;
}
```

首切面只注册 IAB adapter，但协议、facade 和 registry 不允许再依赖单一 IAB 常量。

### 4.4 IAB scope 与 generation 冻结

IAB 的可见性、默认 tab、活动 tab、pending request 和 cleanup 均按以下 scope 隔离：

```text
(browserId, browserGeneration, windowId, workspaceKey, remoteSessionId?, sessionId, clientMode)
```

- `tabId` 是 main 分配的 opaque runtime id，不再使用 `sessionId` 或 renderer pane id 冒充 tab identity。
- renderer attach 必须命中 main 已登记、属于同一 `windowId` 且 generation 未过期的 tab；closed/stale/跨窗口 attach 一律拒绝。
- descriptor generation 改变后，旧 Browser/Tab 对象必须失败，不能自动漂移到新 connection。
- `BrowserViewReady` 是 renderer 创建或恢复 logical shell 的唯一 authority，也是可重放的
  create/ready 请求：guest 未 attach 时可再次发送；`BrowserViewAttachGuest` 是 ready ack。
  `visibility=show` 不是 ready 的别名，不具有创建或恢复 authority。
- `list/get/selected` 只能观察当前 scope 的 tab。
- human IAB tab 从 renderer attach 起按 `windowId/workspaceKey/sessionId` 归属；只有 owner session 能通过
  `BrowserUser.openTabs()` 发现并 claim，空 URL 与精确 `about:blank` 不进入 user tab 结果。释放控制权仍保留
  原 session ownership，不能发布给其它对话。完整边界见
  `docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md`。

### 4.5 IAB lifecycle 冻结

- `tabs.new()` 必须通过 backend 分配 tabId、请求 renderer 创建 guest、等待 ready ack 后返回。
- `BrowserViewReady` 到达时，renderer 必须按事件携带的 identity
  `(workspaceKey, remoteSessionId?, sessionId, browserId, browserGeneration, tabId)` 幂等创建或恢复对应
  `browser-use` logical shell，不能用事件
  到达瞬间的 active workspace / active session 回填归属。若 origin session 仍是当前作用域，则激活 tab
  并展开右侧栏，让用户看到正在使用的 IAB；若用户已经切到其它 session/workspace，则只在后台创建并
  mount `<webview>`，以便 `dom-ready` 产生 ready ack，不得抢占当前右侧栏，切回 origin session 后再
  恢复显示。面板内容是否 mount 仍不能只依赖可见状态，否则后台 ready 会因收不到 attach ack 而超时。
- `visibility=show` 只是现存 logical shell 的选择信号。renderer 只能激活上述 scope、generation 与
  `tabId` 完全匹配的 shell；未命中时必须忽略，不得创建、恢复或 mount shell。`visibility=hide` 也只能
  隐藏同一 scope/generation 当前激活的 shell。inactive guest 的 attach 不得把 scope visibility 回放成
  该 tab 的 show；scope 可见与 tab active 是两个独立状态。
- create/selection 的有序边界冻结为：

  ```text
  main 创建 logical tab
      |
      v
  BrowserViewReady(scope + generation + tabId)  -- 可重放至 attach ack
      |
      v
  renderer 幂等创建/恢复 shell + mount webview
      |
      v
  BrowserViewAttachGuest                         -- ready ack
      |
      v
  visibility=show/hide                           -- 只选择/隐藏现存 shell
      |
      v
  close                                           -- terminal
      |
      +--> delayed visibility 必须忽略，禁止重建 shell
  ```

  同一 sender 必须先投递 Ready、再投递首次 visibility；renderer 即使在同一 React batch 内接收两者，
  也必须按接收顺序更新 lifecycle state，不能依赖上一轮 render 才刷新的 ref。renderer 状态丢失或需要
  恢复时，producer 必须先重放 Ready，再重放 visibility，禁止只用 visibility 恢复 shell。旧
  `browserGeneration`、不同 `remoteSessionId` 或已经 close 的 tab 的 visibility 一律忽略。

- ZCode 在这里采用“browser use 对其所属对话可见”的产品语义；visibility capability 只控制现存
  logical shell 的显隐，不承担 logical shell 恢复。
- `close()` 把 tab 标记为 closed、detach CDP、取消 waiter 并只通知 owner window；迟到 attach 不得复活 tab。
- `finalize()` 把 tab 标记为 deliverable；IAB 页面在 session 存续期间保持可见。
- `turnEnded()` 取消该 turn 尚未完成的 request/waiter；已下发动作按 uncertain side-effect 语义返回。
  ZCode IAB 采用进程内默认持久语义：所有 agent-created active/handoff tab 都继续可见、可控，不能因
  模型漏调 finalize、已有 handoff、turn 成功/失败而自动关闭。显式 deliverable 和 claimed user tab
  在 turn end 释放给用户，但仍保持可见。
- `tabs.finalize({ keep })` 只给列入 `keep` 的 tab 应用 `handoff`/`deliverable` 状态；未列入的 tab
  保持原 lifecycle，遗漏不具有关闭语义。只有模型显式 `tab.close()` 或用户手动关闭才关闭单个 tab。
- `closeSession()` 取消该 scope 的 pending request，清理 session 级配置并把仍存活的 IAB tabs 释放给
  原 session 的 user-tab 集合，不关闭 webview，也不允许其它 session 枚举或 claim。进程生命周期见
  `docs/browser-use/2026-07-12-browser-tab-process-lifetime-spec.md`，对话隔离见
  `docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md`。
- window close 额外执行 window-scope cleanup，避免 main singleton 残留 owner/guest。
- host bridge 与 main manager 都必须覆盖同 scope、跨 scope 的并发重复 requestId 回归；断言重复请求
  不下发、原请求的结果/取消/turn/session cleanup 关联保持不变。
- renderer lifecycle 测试必须走真实 hook 订阅并覆盖相邻事件：同一 batch 的 `Ready(A) → Ready(B) →
visibility(B)` 保留两份 shell 且激活 B；`close(B) → delayed visibility(B)` 不得重建 B；旧 generation
  与不同 remote session 的 visibility 不得改变当前 active tab。main 测试必须覆盖
  `attachGuest({ active: false })` 不产生 show 事件。

## 5. Discovery 与 selection

BrowserRegistry 每次需要时刷新或按 TTL/peer event 更新 descriptor。选择规则冻结为：

### 5.1 `get(idOrType)`

- 优先按精确 id。
- 未命中时按 type alias。
- 同 type 多实例时使用 preferred instance 规则，否则稳定选择第一项。
- 无匹配抛 `BrowserBackendUnavailableError`，列出当前可用 descriptor，不静默降级到另一 backend。

### 5.2 `getDefault()`

1. IAB。
2. preferred extension instance/window。
3. 任一 extension。
4. 其余第一个 backend。
5. 空列表抛 unavailable。

### 5.3 `getForUrl(url)`

- 单 backend 直接返回。
- local/file target 优先 IAB。
- 用现有 IAB/extension tabs 做 exact → origin+pathname → hostname → hostname hierarchy 匹配。
- 多候选优先 IAB，再 preferred extension。
- fallback：IAB → extension → 其余。
- 只有一个 backend 时走快路径直接返回；多 backend 下 URL parse 失败明确报错，不把原串发送给任意 backend。
- `file:` 只属于选择提示：它可以让多 backend 选择 IAB，但 `Tab.goto()` 仍只允许 http/https/about:blank。

所有选择规则必须做纯函数单测，并覆盖多个同 type backend、peer 消失和 preferred instance 变化。

## 6. Browser-client 与插件边界

最终状态：

- Node REPL 是通用 runtime，不因 browser-use plugin 被禁用而消失。
- browser/chrome plugin 携带同一 build 产物的 browser-client、API manifest 和 docs manifest。
- skill 在 fresh kernel 中显式 import 并执行一次 setup；重复 setup 幂等。
- ZCode 可保留内部自动 bootstrap 作为迁移兼容，但模型文档和稳定 contract 以插件 asset 为准；迁移期结束后移除 core 私有 facade 实现。
- plugin disable 只移除相应 skill/client/backend 产品入口，不应破坏通用 Node REPL。
- official asset staging 的 SEA/Desktop/remote/prebuild 四条链必须包含 `scripts` 和必要平台资产。

## 7. API manifest 与对象图

需要 clean-room 定义覆盖完整 observable signatures 的 manifest。运行时必须：

1. 按 backend `unsupportedByDefaultIn` 建立基础支持集。
2. 合并 backend overrides、capability 和产品 feature gate。
3. 从对象 graph 隐藏 unsupported member。
4. 生成当前 backend 的有效 API 文档。
5. 条件拼装安全、上传、Chrome、IAB、capability guidance。
6. 自动测试 manifest、facade、docs 和 backend command mapping 不漂移。

本轮 manifest 采用 member 级结构，每项至少包含 `name/kind/signature`，可选包含 `command`、`unsupportedByDefaultIn` 与 `requiresCapabilities`。interpreter 的合并顺序冻结为：

1. `unsupportedByDefaultIn` 建立 backend family 基线。
2. `requiresCapabilities` 校验 descriptor 的 browser/tab capability id。
3. `apiSupportOverrides["Object.member"]` 做 connection 级最终覆盖。
4. unsupported member 同时从 runtime proxy、`in` 结果和有效 documentation 中隐藏。

manifest 不再声明某个 backend 固定可用，也不允许文档列出 runtime object graph 已隐藏的方法。

必备对象族：

- Browsers/Browser/BrowserUser/Tabs/Tab。

## 8. Locator pointer action 冻结语义

`click`、`dblclick` 和需要切换状态的 `setChecked` 共用以下 pointer-target pipeline：

1. 在 Playwright isolated world 中严格解析 selector；零匹配进入 routine wait，多匹配立即 strict
   violation，不能用 `first()` / `last()` / `nth()` 自动消歧。
2. 非 `force` 操作检查 `visible`、`enabled`；`force` 只跳过这两个 actionability state 和最终
   receives-events 拒绝，不跳过 selector 唯一性、可点击矩形、frame identity 与 trusted input。
3. 按候选 scroll alignment 滚动后，至少观察两个连续 animation frame；只有 bounding rect 完全
   相同时才可进入点击。元素 detach、重新解析到不同节点或 execution context 被销毁时重新解析，
   直到 routine timeout。
4. target 必须携带实际 CDP target/session/frame identity。子 frame 中的本地坐标逐层映射到顶层，
   每层 iframe owner 都执行 hit-target 检查；同 frame 内继续使用 Playwright injected
   `expectHitTarget`。OOPIF 不得仅依赖累计 `getBoundingClientRect()` 偏移。
5. 最终动作只通过 CDP `Input.dispatchMouseEvent` 产生 trusted input；点击前后的 target/context
   失效必须返回带明确恢复指引的结构化错误，不能伪装成功。
6. `Runtime.evaluate` / `DOM.*` 的成功 response 必须经过运行时 payload 校验。缺少 `result.value`、
   `count`、坐标或 frame owner 的返回属于 backend execution error，不得降级为 locator 未命中。

验收必须包含真实 Electron/CDP 页面，不得只用 mock `Runtime.evaluate`：普通 link/button、标题内嵌
link、持续动画、overlay、同源 iframe、OOPIF、navigation/context-destroyed race、空 payload 和
畸形 payload 均为必测状态。

- Playwright API、Locator、FrameLocator、Download、FileChooser。
- CUA/DOM_CUA。
- Content、Clipboard、Dev logs、Dialog。
- Browser/tab capability collections 和 documentation。

## 8. Playwright facade

### 8.1 语义

- 这是受限 Playwright-like API，不暴露任意 Playwright BrowserContext/process。
- wait API 属于 `tab.playwright`，不属于 `Tab` 根对象；固定等待的准确签名是
  `waitForTimeout(timeoutMs: number): Promise<void>`，因此禁止在 `Tab` 根对象增加
  `tab.waitForTimeout(...)` 兼容别名。
- `waitForTimeout` 接受非负整数，先校验目标 tab 仍属于当前 scope，再执行可取消的固定等待；
  transport 的命令预算为 `timeoutMs + 2000ms`。固定 sleep 只用于没有更具体页面状态可等待的场景，
  常规流程仍优先 fresh snapshot 或后续的 targeted wait API。
- locator 构造是纯描述；调用 action/query 时才下发 backend command。
- 最新相关 `domSnapshot()` 是 locator 构造与失败恢复的唯一事实源。snapshot 未出现的 label、
  accessible name、placeholder、text、attribute 或 selector 禁止猜测，也禁止把猜测 locator 当成页面探针。
- click/fill/press/select/check 前，若 selector 本身不能证明唯一，必须先 `count()`；`count() === 0`
  时不得继续等待或执行该 locator，必须重新 snapshot 并基于新事实重建；大于 1 时必须收紧 scope，
  不得用 `first()/last()/nth()` 掩盖歧义。
- locator timeout、strict-mode 或 selector parse 失败后，禁止原样重试 locator；先获取 fresh snapshot，
  再使用更稳定的 role/name、`data-*`、`href` 或 scoped selector。
- 常规 Playwright operation timeout 冻结为：默认 3000ms，显式 timeout 也最多
  3000ms；下载事件是例外，仍默认 3000ms、最大 120000ms。`waitForTimeout()` 是用户明确请求的
  固定等待，不受常规 operation timeout 上限影响。
- locator strictness、frame scope、timeout、load state、download/file chooser 和 navigation wait 有统一语义。
- `evaluate` 在页面上下文执行传入脚本；调用方负责控制脚本范围并验证预期结果。
- locator/action 错误必须携带可操作信息，不泄漏 backend 内部 secret；client 添加操作上下文时不得
  把原始 error message/stack 重复拼接到最终错误。

### 8.2 Backend adapter

- IAB：基于 webview guest CDP 实现 DOM snapshot、Runtime、DOM/Accessibility/Input/Page 组合。
- extension：通过 `chrome.debugger` 转发同一受控 CDP/DOM command contract。
- cdp：直接执行允许列表内的 CDP command。
- 不允许把 IAB DOM snapshot 的简化 ref API冒充完整 Playwright locator。

### 8.3 当前 Playwright 交付边界

IAB 本轮按冻结的静态接口交付了以下 **method-name object graph**：

- `PlaywrightAPI` 16 个 member：DOM snapshot、坐标元素信息/标注截图、页面脚本 evaluate、navigation/load/URL/fixed wait、download/filechooser event，以及 locator/frame locator builders。
- `PlaywrightLocator` 32 个 member：builder/filter/集合、严格 action、读取、状态、select/check、evaluate 与 media download。
- `PlaywrightFrameLocator` 7 个 builder member、`PlaywrightDownload.path()`、`PlaywrightFileChooser.isMultiple()/setFiles()`。

locator builder 只组合 selector，终结操作才跨协议下发；IAB 的
`waitForEvent("filechooser")` 和 `setFiles` 保持明确 unsupported 行为；download 通过 guest
session 的 `will-download` 生命周期生成受 tab scope 约束的 download object。

2026-07-10 深度审计确认：这只证明 **接口集合和部分 client-side contract**，不能写成“完整 common
object graph 已行为对齐”。当前 executor 仍是页面内 clean-room selector/runtime，不是本规格 8.2
要求的 CDP DOM/Accessibility/Input/Page 组合，至少存在以下未收口项：

- locator click/press/fill/check/select 使用 synthetic DOM event/property mutation，不具备可信输入和完整 actionability。
- role/accessible name 是手写子集；不穿透 shadow DOM，只能访问同源 iframe。
- 当前 IAB 明确拒绝 `networkidle`。`expectNavigation` 无 URL 时允许旧页面已完成 load
  立即满足；传 URL 时才以目标 URL + waitUntil 证明导航。不得把当前 IAB 行为误写成 upstream Playwright 保证。
- `evaluate` 直接在页面上下文执行传入脚本；root `Tab.evaluate` 与 Playwright evaluate 均属于可执行页面脚本的能力。
- root `screenshot({ref})` 接受 ref 但 executor 忽略；这不是已实现能力。

因此跨源 iframe、shadow DOM、AX、trusted input、actionability、navigation wait、页面脚本执行和真实
download 都必须经合同/E2E 验证；在这些用例通过前，只能宣称“Playwright 方法名集合齐全”。

### 8.4 DOM-first 观察与截图兜底

观察策略按“能回答下一步问题的最便宜证据”冻结：

1. 普通打开、导航、阅读、搜索、表单定位和状态确认，locator 流程先返回
   `playwright.domSnapshot()`；只有 ref/dom_cua 兼容流程才先返回 `snapshot()`。页面打开本身不是截图理由。
2. REPL 示例必须让观察结果成为最后表达式（默认例如 `await tab.playwright.domSnapshot()`；兼容 ref 路径可用 `await tab.snapshot()`），或显式 `nodeRepl.write(...)`。只把结果赋给局部变量不算模型已观察。
3. 默认禁止在同一观察单元同时调用 DOM 观察（`playwright.domSnapshot()` 或兼容 `snapshot()`）与
   `screenshot()`；若 DOM 已经足以回答问题，不再用截图重复确认。
4. 只有三类情况进入模型 image block：用户明确要求截图/视觉检查；需要判断布局、样式、像素或图片内容；DOM snapshot 无法表示 canvas、自绘控件等目标且需要视觉坐标兜底。
5. screenshot 的选项教程不进入默认 documentation，只有满足上述视觉分支时才按名称 lookup；但
   “截图结果必须进入 image block”的输出契约必须留在默认工具说明和 API semantics 中。模型一旦决定
   调用 `screenshot()`，必须在同一个 JS cell 中使用
   `nodeRepl.emitImage(await tab.screenshot())`，禁止把 `screenshot()` 作为最终表达式或把
   `Uint8Array` 直接回灌模型。
6. IAB 兼容接口 `snapshot()` 在保留可动作 `elements/ref` 的同时，还要返回有界的可见语义 DOM 节点，
   至少覆盖 heading、paragraph、list、landmark、table、image alt 和稳定定位属性。它不替代第 8.5 节的
   Playwright AI/ARIA 字符串合同。
7. `dom_cua.get_visible_dom()` 复用同一份丰富 DOM 观察，不得只是名称像 DOM、结果仍只有可交互元素。
8. ZCode 不在导航/点击后自动抓取客户端 preview screenshot。普通 browser command 的 response meta 只携带 marker、backend、browserId、tab/open-tab、sessionEnded 与脱敏 URL；截图只能由模型在视觉分支显式调用。`tab.screenshot()` 只产生内部 PNG bytes，模型调用必须写成 `nodeRepl.emitImage(await tab.screenshot())`，只有该路径才成为模型 image block。
9. `nodeRepl.emitImage(...)` 产生的图片除进入 provider-visible image block 外，还必须通过有界的
   `ToolResult.display` 图片元数据进入工具卡片。UI 在实时 `desktop-continuous` 事件与
   `web-remote-replayable` snapshot/replay 中都直接渲染图片，不再只显示
   `[Attached image/*: MCP image]`；该占位仅用于模型文本投影，工具卡片拿到真实图片时必须隐藏它。
   display 图片载荷必须限制单图、总量和数量，不能绕过 tool result budget 形成无界协议消息；relay/main
   仍只透传，不保存或解释图片业务状态。
10. `nodeRepl.emitImage(...)` 产生的 browser screenshot 在 MCP bridge 进入模型前必须受 200 KiB
    base64 单图预算约束：不超预算时保持原图；超预算时复用统一 `ImageProcessorPort`，按 2000 最长边、
    153600 B decoded binary、204800 B base64 预算生成可见 image block。只有压缩失败时才把原图保存为
    artifact 并返回文本引用，禁止把 `Uint8Array` 展开成数字 JSON，也禁止因通用 MCP 阈值直接丢失
    browser use 的视觉观察。
11. 模型显式调用 `tab.screenshot()` 并按第 5 条通过 `nodeRepl.emitImage(...)` 返回截图时，
    工具结果必须同时包含 image block 和原始截图 artifact 的绝对文件路径文本。路径文本必须是
    独立的 provider-visible text block，使不支持多模态的模型仍可把该路径交给图片识别 MCP；
    路径对应的文件保留 browser backend 返回的原始 PNG bytes，不受第 10 条模型可见图片压缩策略影响。
    截图来源必须在 Node REPL 结果中显式标记，普通 `nodeRepl.emitImage(...)` 不得因此额外落盘。
    截图失败时不生成空文件或虚假路径。轮尾自动截图属于 UI 展示链路，不进入模型对话、
    不计入 token，也不生成本条的 artifact 路径文本。

显式截图与轮尾展示的边界固结如下：

```text
模型 js cell
  -> tab.screenshot()
  -> Browser backend 返回原始 PNG
  -> nodeRepl.emitImage(PNG)
  -> Node REPL 标记对应 image index
  -> core artifact store 保存原始 PNG
  -> 模型工具结果: [绝对路径 text] + [有界 image block]

turn ended
  -> 自动截图
  -> UI display only
  -X-> Node REPL / MCP 模型内容 / artifact 路径文本
```

本边界来自 2026-07-10 轨迹回归：模型在“访问 baidu.com”中同时调用 `snapshot()` 和 `screenshot()`，但 snapshot 仅赋值未回显，最终工具结果为 `(no output)` + image，导致模型只能依赖截图。该行为分类为 `bug-candidate`，目标行为分类为 `accepted`。

实现后的同提示运行时复验只产生 `navigate + snapshot`，没有 `screenshot`/`emitImage`，最终 provider request 的 image block 数为 0。百度 snapshot 返回 30 个 action elements 与 54 个 semantic DOM nodes；大结果预览按 schema 顺序优先展示 `dom`，再展示 `elements`。

### 8.5 `playwright.domSnapshot()` 合同

`tab.snapshot()` 是 z-code 为兼容早期 ref/action 工作流保留的结构化接口，不属于 common
Playwright API。locator 工作流的事实源必须是
`tab.playwright.domSnapshot(): Promise<string>`；两者不得再共用同一“snapshot 合同”的表述。

IAB 的 `playwright.domSnapshot()` 冻结为以下可观察合同：

1. 从 `document.body || document.documentElement` 生成 Playwright `mode: "ai"` 的 ARIA 语义树，
   禁止返回 `outerHTML`、整页 `textContent` 或手写 role/name 猜测结果。
2. 使用固定版本的 Playwright injected runtime，在 CDP isolated world 中执行，避免页面覆盖原生对象或
   修改全局变量污染快照结果。
3. 只展开 Playwright ARIA snapshot 已渲染、未 `aria-hidden` 且可见的 iframe；子 frame 失败时保留
   iframe 本身，不让单个跨源/OOPIF frame 使整个快照失败。
4. IAB iframe 展开总预算为 1000ms，单个子 frame 最多 500ms；同层 frame 并发读取，递归结果按原
   ARIA tree 的 iframe 行原位缩进插入。
5. 返回模型前删除 Playwright 内部 `[ref=...]` 与 `[cursor=...]`；删除没有自身语义的 `img` 行；
   对只有结构作用的匿名 `generic` / `listitem` / `group` 压平但保留其 children。
6. public API 不增加 `maxElements` / `includeHidden` 参数。顶层失败走现有结构化
   `execution_error`，abort/timeout 继续复用 browser command 生命周期。
7. `tab.snapshot()` 继续提供 `elements/ref` 的兼容操作能力；默认 locator 文档与
   重试决策改用 `playwright.domSnapshot()`，只有进入 ref/dom_cua 兼容路径时才调用
   `tab.snapshot()`。

验收必须覆盖：ARIA role/name/state、隐藏节点、open shadow root、同源 iframe、跨源/OOPIF 可降级、
ref/cursor 清洗、匿名容器压平、空图片删除、子 frame 超时和大 DOM 不返回 HTML dump。extension/CDP
backend 后续复用同一个 Playwright command/result 与归一化函数，不允许再引入 backend-specific
返回格式。

2026-07-10 对 Playwright `1.57.0`—`1.61.1` 的 injected runtime 做字符串集合和真实页面行为比对，
代表性 role/name/state/shadow DOM 输出在 `playwright-core@1.59.1` 上符合本节合同；`1.61.1` 会额外输出
`[invalid]`，因此 IAB 固定使用 `1.59.1`，不追随最新版漂移。随后使用 Electron `41.0.3` 的真实
`webContents.debugger` 与 Chromium site isolation 复验：主文档
heading、open shadow root 内 button、跨站 OOPIF 内 heading/button 均进入同一 ARIA 文本；hidden 文本、HTML
dump 与内部 ref 均未进入结果。复验同时发现 OOPIF 导航时 target 注册晚于 iframe node frameId 的竞态，IAB
现按同一 aria-ref 刷新 target 后重试，并在两次连续真实运行中稳定展开子 frame。

### 8.6 Locator evidence 与失败预算回归

2026-07-10 的 Bilibili 运行轨迹中，首次 `domSnapshot()` 只出现无名称 `textbox`，模型却猜测
`getByPlaceholder("搜索")`。真实页面 placeholder 是动态推荐词，因此 selector 正确返回 0 个节点，但 IAB
旧实现按 30000ms 默认预算持续轮询，最终同一 timeout message 又被 client stack 包装重复输出。后续模型改用
snapshot 已明确支持的 `getByRole("textbox")` 后成功，证明问题不是 placeholder selector API 缺失，而是
locator evidence discipline、timeout 预算与错误包装三个独立缺陷。

该回归冻结以下验收：

1. 默认文档和 browser skill 必须明确禁止猜测 locator，并给出 `count() === 0` 的立即重建流程。
2. IAB locator、URL/load-state wait 和 evaluate 的 routine timeout 统一经
   3000ms normalizer；大于 3000ms 的显式值被截断，小于 3000ms 的值保留。
3. locator client 包装后，原始 timeout message 在 `message/stack` 中只出现一次，同时保留操作上下文。
4. 不通过给动态 placeholder 增加模糊匹配或兜底成功来修复；页面没有 `placeholder="搜索"` 时匹配失败是
   正确语义。

### 8.7 IAB locator/action 执行合同

IAB 的 locator 与 `domSnapshot()` 必须共享固定版本的 Playwright injected selector runtime，禁止继续
维护第二套手写 role/name/text/label selector：

1. `parseSelector/querySelectorAll/elementState` 在 CDP isolated world 中执行，open shadow root 的观察与
   定位结果必须一致；frame locator 按 frame boundary 逐段解析，同源 frame 和 OOPIF 都使用各自 execution
   context，不能依赖页面主 world 的 `iframe.contentDocument`。
2. click/check 类 action 在完整 routine timeout 内重复检查 strictness、visible、stable、
   enabled 和 hit target；元素已存在但仍被遮挡、动画中或不可用时继续等待，而不是
   立即假失败。fill/type 只检查 visible/enabled/editable，不等待 stable，
   也不使用 click 的 hit-target/receives-events 条件。
3. click/dblclick 与非 clipboard shortcut 的 press 使用 CDP `Input` 产生 browser trusted input；type 以及
   fill 的 `needsinput` 分支在指定 tab 内解析当前 focused frame，并在该
   CDP target / execution context 中派发虚拟 `paste`。禁止继续使用顶层 `Input.insertText`，因为 Electron
   embedder 的 composer 可能在 click 与 type 两条命令之间重新取得 app focus，导致文本越过 guest 边界。
   `selectOption` 等 Playwright 本身允许由 injected script 完成的 DOM mutation，仍必须复用 injected runtime
   并验证最终状态。
4. locator query 与 evaluate 的执行上下文按各自 API 合同处理；页面覆盖原生对象、污染全局变量或 CSP 不能
   改变 selector 结果。
5. selector parse、strict、timeout 和 abort 继续返回统一结构化错误；动作已下发后取消必须标记
   `sideEffect: "uncertain"`。
6. 单元素 action/query/frame locator 的 selector resolve 规则：原始匹配为 0 时
   保持未找到语义，原始匹配为 1 时直接使用；原始匹配大于 1 时仅允许“恰好一个可见元素”作为唯一
   fallback。零个或多个可见元素都必须保持 strict violation，禁止自动选择 `first/last/nth`。集合操作
   `count()` / `allTextContents()` 继续返回原始匹配集合，不应用该 fallback。
7. strict violation 必须复用固定版本 Playwright injected runtime 的 `strictModeViolationError`，让模型看到
   有界的候选 DOM preview 与推荐 selector；禁止只返回 `resolved to N elements` 后让模型继续猜测。
   fallback 选中的元素必须贯穿 actionability、DOM mutation/read 与 frame owner 解析，不能 probe 选中
   可见元素后又在后续阶段退回原始集合的第一个元素。

本节验收对应 BCP-066/067/094/095/096/190/191；在真实 shadow DOM、同源 iframe、OOPIF、overlay、disabled、
动画和 `event.isTrusted` 用例通过之前，不得宣称 IAB Playwright 行为完成。

### 8.8 fill 超时与 kernel reset

2026-07-14 z.ai 轨迹中，`count()` 已经证明输入框唯一存在，但 `fill()` 在 injected
`checkElementStates(["stable", ...])` 内持续等待。该单次 CDP probe 没有被 locator 的 3000ms
预算中断，最终命中外层 MCP 30000ms hard timeout，并返回 `AbortError: aborted`。Node REPL
虽已重建 kernel，但错误没有告诉模型旧 binding 已清除，因此后续继续使用 `browser` / `zaiTab`，
又产生连续 `ReferenceError`。

本次修复边界经用户确认，冻结如下：

1. 仅拆分 fill/type 与 click/check 的 actionability；click/check 已有 stable 和 receives-events 语义
   保持不变，不以“解决 fill”为由放宽点击安全条件。
2. locator actionability 的每个异步 probe 都必须受剩余 locator 预算约束；底层
   `Runtime.evaluate.timeout` 不能代替 host 侧 deadline race。单个 probe 卡住时必须在最大
   3000ms 内返回 locator timeout，不能外溢到 MCP 30000ms timeout。
3. pointer action 的稳定性约束作用于 locator 当前命中的可见目标几何，而不是首次命中的 DOM node
   身份。响应式表格等页面在相邻 animation frame 用等位新节点替换旧节点时，probe 必须重新解析
   同一 selector；只要新目标保持唯一、可见、enabled、几何稳定且通过 hit-target，就继续派发可信
   CDP input。不得因为旧 node detach 而在完整 3000ms 内反复返回零匹配。
4. AbortSignal timeout 必须保留 `signal.reason`，使 MCP hard timeout 与用户主动取消可区分。
   取消或超时导致 kernel reset 后，当前 tool error 必须显式说明 kernel 已重置、旧
   binding 已清除，并指示重新建立 browser/tab binding；不得静默重置后让模型继续使用旧变量。
5. 验收组合为：fill 遇持续动画仍可输入；被覆盖但可编辑的输入框仍可 fill；disabled /
   readonly 仍失败；click 遇动画/覆盖仍等待；未决 probe 在 3000ms 内结构化超时；MCP
   hard timeout 后错误明确包含 kernel reset 恢复指引。

### 8.9 输入目标所有权与虚拟 clipboard

2026-07-15 运行日志记录到同一 IAB tab 的 click 成功后约 501ms 才执行 type；这段空窗允许 ZCode
composer 的 requestAnimationFrame autofocus 抢回 Electron window focus。旧 executor 随后调用
`Input.insertText`，没有重新解析网页 active element、frame target 或 input identity，因此存在文本进入
embedder 主输入框的实际串写风险。

type 与 fill `needsinput` 分支的输入合同冻结如下：

1. `cua_type` 与 `dom_cua_type` 共用 type handler，不调用 `Input.insertText`；handler 先构造 browser-scoped
   clipboard items，再在指定 `tab_id` 内执行 virtual paste。
2. focused target 从当前 document 的 `activeElement` 开始，递归穿透 open shadow root 与同源 iframe；遇到
   OOPIF 时切换到对应 CDP target/session，遇到同进程 frame 时创建该 frame 的 isolated execution context。
3. paste 只在最终 target/context 中构造 `DataTransfer` 与 `ClipboardEvent("paste")`。页面未处理事件时，
   fallback 按 selection 更新 input/textarea，或向 contenteditable 插入文本并派发 `input`。任何分支都不
   调用 OS clipboard，也不向 embedder renderer 发送键盘文本。
4. Playwright fill/press 在聚焦 locator 时给实际输入元素写入一次性 target token；virtual paste 前必须校验
   当前 active element 仍持有同一 token。目标已经漂移时明确失败，禁止把文本发送给新焦点。
5. CDP attached OOPIF session、isolated world 与 object handle 必须在命令结束后释放；frame cycle、无法检查
   focused frame、无效 Runtime result 都返回结构化 execution error，不能回退到顶层 `Input.insertText`。

状态与时序冻结为：

```text
embedder composer autofocus                 browser command(tabId)
          │                                            │
          │                                   resolve tab guest
          │                                            │
          └──── 不参与 browser 输入 ────────► activeElement
                                                       │
                                     shadow root / iframe / OOPIF
                                                       │
                                             target + context
                                                       │
                                     locator token 校验（若存在）
                                                       │
                                               virtual paste
```

验收覆盖 plain input、textarea、contenteditable、open shadow root、同源 iframe、OOPIF、locator target token
漂移、无 editable focus，以及“host composer 已重新 focus 但 type 仍只能修改 guest page”。desktop 与手机
remote 共用同一 shared-host executor；本变更不新增 runtime，不改变 `desktop-continuous` /
`web-remote-replayable` 或 workspace identity 边界。

2026-07-15 使用 Electron `41.0.3` 真实 `BrowserWindow + <webview> + webContents.debugger` 复验：guest input
先获得 DOM focus、随后 host composer 抢回 app focus 时，旧 `Input.insertText("OLD")` 的结果为
`guest="" / host="OLD"`；新 virtual paste 的结果为 `guest="NEW" / host=""`。同源 iframe 与跨站 OOPIF
分别得到 `frame="FRAME" / host=""`、`frame="OOPIF" / host=""`。OOPIF 首次 attach 还复现了
`DOM frameId` 先于 `Target.getTargets` 注册的竞态；实现现在有界等待目标出现后 attach，并在 paste 后 detach。

## 9. IAB adapter 改造

现有 BrowserGuestManager 只作为 IAB provider 内部实现。必须修复：

- guest key 加 browserId/window/workspaceKey/session/tab 归属，禁止全局 activeKey 跨窗口命中。
- list/get/selected 只返回当前 context 可见 tabs。
- `tabs.new()` 真实创建并等待 guest ready ack。
- close 通知贯穿 main → preload → platform → UI，且不可重新 attach 已关闭 tab。
- finalize/handoff/deliverable 和 session/turn cleanup。
- ready 使用 request/ack 或可重放状态，不依赖一次性广播。
- session close 释放 REPL、pending request、dialog、guest/lease。
- screenshot(ref)、实时 url/title、完整 wait/capability 与文档保持一致。

IAB 的 desktop-continuous 主链继续 direct continuous；手机 web remote 只通过 shared host attachment 使用同一 IAB provider，并保持 replayable 边界。

## 10. Extension backend

ZCode 自研内容：

- MV3 Chrome extension，使用自有 extension id。
- 三平台 native messaging manifest 安装器。
- 自有签名 native host 与版本化 registry。
- native host ↔ extension 的 framing/JSON-RPC、重连和 heartbeat。
- Chrome profile/instance/window preference。
- debugger attach/detach、tab lease/claim/group/finalize。
- user tabs/history 的授权和最小权限读取。
- downloads/file chooser/clipboard/dev logs。
- plugin、extension、native host 的 install/upgrade/remove/stale process reconcile。
- 安装/权限/运行/profile 的诊断命令和产品 UI。

禁止：

- 使用任何第三方 extension/native host id。
- 分发或启动第三方签名二进制。
- 复制第三方 service worker/native host/browser-client 源码。

## 11. CDP backend

- 独立 backend，不等于“IAB 内部碰巧用 CDP”。ZCode 首选把它建成可插拔远端/cloud provider，而不是把 Playwright 进程改名为 CDP。
- 默认 feature-gated；只连接明确配置/授权的 endpoint。
- target/context 生命周期独立管理。
- raw full CDP 是单独 capability，受 allow/block policy 和 enterprise/product gate。
- 无 full CDP capability 时，common Playwright/CUA API 仍只能用受控 command contract。
- 不能自动扫描并接管任意本机 debugging port。

## 12. 安全模型

安全检查位置在 browser-client/backend command boundary，独立于 `js` 工具 gate。

### 12.1 必须确认

- 外发通讯、提交表单和对外发布。
- 购买、付款、下单、金融交易。
- 删除数据、取消服务、权限/账户/密钥/扩展变更。
- 上传本地文件、传输敏感或个人数据。
- 登录或使用已保存身份执行有副作用动作。
- camera/mic/location/notification 等 browser permission。

### 12.2 允许或按策略预授权

- 页面读取、DOM snapshot、普通截图。
- 用户明确要求的导航和无副作用查询。
- download 是否确认按产品策略冻结，但必须安全命名、隔离路径并可审计。

### 12.3 防绕过

- policy deny 后，raw CDP、evaluate、另一 backend、CUA 或页面脚本都不能绕过同一意图。
- 网页内容不能授予权限，也不能要求模型忽略 policy。
- credential UI 注入 secret 时不得把 secret 回传模型或日志。

## 13. Response meta 与观测性

每次 browser command 更新 tool response meta：

- browser-use marker。
- backend type、browserId、openTabIds。
- 当前 URL。
- 不因普通动作附加 screenshot；只有模型显式调用 screenshot API 时才返回图像结果。
- tab ownership/lifecycle 状态（如需要）。

内部归一化字段冻结为 `browserUse/backendType/browserId/browserGeneration/openTabIds/tabId/currentUrl/lifecycle`；Node REPL 对模型/客户端暴露时还必须形成 `browser_use`、`zcode/browserUse` 和 `zcode/toolSurface` 外层 marker。`currentUrl` 进入 meta 前必须移除 credential、query 和 hash。失败结果同样带不含敏感数据的 meta。取消发生在 backend action 下发前时错误标记 `sideEffect: "none"`；下发后无法证明动作未发生时标记 `sideEffect: "uncertain"`。

ZCode **不在**成功的导航/点击/输入等 side-effect cell 结束后自动截图，也不把截图放进 `zcode/toolSurface` 供工具面板预览：不得因普通页面动作调用 screenshot，也不得把显式 screenshot 结果自动复制成 preview meta。这一取舍只影响工具面板预览，不改变 DOM-first 观察、显式视觉截图或 tab 生命周期。

### 13.1 Provider-visible IAB ambient context

2026-07-12 复盘两轮图灵社区轨迹后，新增以下冻结语义：

1. 每个普通输入在进入 agent runtime 前，由 desktop shared host 以只读命令读取当前 window/workspace 的
   IAB tab 摘要。`feat/web-app` 的无附件主路径由 v4 `command/sendText` 收集并随 payload 传递；仍处于兼容期的
   附件路径继续走 legacy `session/send`。两条路径都至少合并当前 session 的 controlled tabs 与可 claim 的
   user tabs，去重后只保留 tab 数量和当前 URL；不得读取 cookie、storage、页面正文或敏感表单值。
2. 结果通过 strict `browserAmbientContext` 字段传递，字段有界且可选。v4 handler 必须把该字段继续传给
   `sendInput`，由 core 仅在本轮 provider input 中投影；不得因为主发送链路迁移到 v4 而静默丢失。desktop 使用
   `desktop-continuous`，手机远控仍通过 shared-host attachment 使用 `web-remote-replayable`，并继续携带
   `workspaceIdentity` / `remoteSessionId`；不得为手机另起 browser runtime。
3. core 将它只投影到本轮 provider-visible user content：

   ```text
   <in-app-browser-context source="ambient-ui-state">
   This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.
   # In app browser:
   - The user has the in-app browser open with N tab(s).
   - Current URL: ...
   </in-app-browser-context>

   ## My request for ZCode:
   <真实用户输入>
   ```

   session store、UI message、标题生成、输入历史与 repo snapshot sidecar 继续使用真实用户输入，不保存或展示
   ambient wrapper。读取失败、无 IAB backend 或无 tab 时不注入；失败不阻断 prompt，也不记录完整 URL。

4. ambient context 只是事实，不是 browser selection 指令。模型仍按用户正文决定是否使用 Browser；一旦需要
   延续当前页面，操作前应先复用已有 browser binding，检查 `tabs.list()`，再检查
   `browser.user.openTabs()` 并 claim。该逐步流程只用于操作前选择目标 tab；若 action 可能打开
   popup/new tab 且源 tab 未出现预期效果，必须在同一个 observation cell 中无条件读取并统一返回
   controlled/user 两套 tab 状态，不能在两次查询之间让模型重新决策。
5. model docs、skill 与 `js` tool description 必须一致禁止循环猜 URL/path/resource ID。允许一次由用户条件直接
   推导出的 focused URL；失败或无法验证后切到 fresh DOM、站内搜索，或目的型 connector/API/CLI，并在得到
   权威 ID/URL 后直接验证目标页。
6. App 与 Agent 允许短暂版本错位。旧 Agent 对 `browserAmbientContext` 返回 `-32602` 时，App 必须同时识别
   `Invalid params` 与带字段摘要的 `Invalid params — ...`，从结构化 Zod issues 确认只有可降级字段后，删除该字段
   重试一次；不得把兼容错误直接暴露为用户第二轮发送失败。`dev:local-cli` 启动前必须重建 desktop agent bundle，
   不能因为仓库里存在旧 `dist/zcode.cjs` 就优先启动过期协议实现。

### 13.2 Electron navigation already committed

Electron `<webview>` 在站点把 `www` 重定向到移动域名或由 SPA 接管路由时，`loadURL()` 可能以
`ERR_ABORTED (-3)` reject，但 guest 已经提交新 document。导航结果按以下顺序判定：

1. 非 `ERR_ABORTED`、超时、取消和真实网络错误保持原结构化失败语义。
2. 仅对 `ERR_ABORTED` 做有界复核：当前 URL 必须不再是导航前 URL，当前 document 的 `location.href` 必须
   与 webContents 当前 URL 一致且 `readyState` 已到 `interactive | complete`，目标 URL 与最终 URL 必须相同，
   或仅存在受支持的 `www.` / `m.` host alias 且 path/search 相同。
3. 满足复核条件则按成功返回最终 state；否则仍返回 `execution_error` + `sideEffect:"uncertain"`。禁止只看
   error 文本或只因 URL 改变就吞掉失败。

## 13.3 轨迹验收序列

IAB 应支持以下序列：

1. fresh kernel 建立 browser runtime 后，skill 必须统一把当前选择结果绑定到 `globalThis.browser`：显式 IAB
   使用 `get("iab")`，带目标 URL 使用 `getForUrl(url)`，两者都不得先创建 `iab` alias 再调用
   `browser.*`。绑定成功后一次读取完整 `browser.documentation()`；额外文档通过
   `agent.documentation.get(name)` 读取。`js` 的模型可见结果预算至少为 64 KiB，当前有效 API 文档在该
   预算内不得转成 artifact 预览。
2. `tabs.new()` 会自动展开并激活 IAB；仅当任务明确需要隐藏或再次显示浏览器时，才读取并调用
   `browser.capabilities.get("visibility").set(false | true)`。
3. `browser.user.openTabs()` 只返回未被当前 run 控制的用户 tab。每个新的逻辑 tab 操作批次都必须先用
   一条独立 JS 调用把完整 `browser.tabs.list()` 结果返回给模型，检查 id/url/title/active；下一条 JS
   调用才按稳定 id 或明确 URL/title 匹配并调用 `tabs.get(info.id)`。SDK 内部静默 list 或在同一 cell
   隐藏结果不算模型已观察；多 tab 时禁止按数组位置猜目标。
4. `tabs.get(info.id)` 不只是创建 agent binding：backend 必须把目标设为该 scope 唯一 active tab，并通知
   renderer。仅当 origin workspace/session 当前在前台时才展开并展示；后台对话只更新自己的 selected/
   preferred tab，不能切换用户当前对话或右侧栏。JS timeout/reset 后仍按 list→match→get 恢复，不得直接把
   `TabInfo` 当作 tab，也不得在未检查 controlled tabs 与 user tabs 前创建重复 tab。
5. action 可能打开 popup/new tab 且源 tab 未出现预期 URL/title/state 时，必须在一个 JS observation
   cell 中用 `Promise.all([browser.tabs.list(), browser.user.openTabs()])` 读取两套状态，并把
   `{ controlledTabs, userTabs }` 作为最终结果统一返回；模型只能在完整结果上做一次效果判断，再在下一
   cell 执行 `tabs.get` 或 `user.claimTab`。禁止先返回 controlled list，再决定是否查询 user tabs。
6. 导航成功后用 `playwright.domSnapshot()` 获取 AI/ARIA 页面状态，不主动截图。
7. 可用 `tabs.finalize({ keep: [{ tab, status: "deliverable" }] })` 标记交付/接续状态；ZCode IAB 不再
   清理未列入 `keep` 的 tab。无论模型是否调用 finalize，所有未被模型或用户显式关闭的 tab 都在当前
   ZCode 进程内持续保留；退出 ZCode 后不承诺恢复。
8. 所有 browser command 都携带 session/turn/sessionContext，并返回脱敏的 browser-use meta；ZCode 不附加自动 preview screenshot。
9. stale/missing tab、locator strict violation、locator timeout 的模型可见错误必须给出可执行且有界的
   恢复动作：先刷新 DOM 或枚举并重新取得 tab，再重建 locator；禁止重试同一 locator、用
   `first/last/nth` 掩盖歧义或在没有 snapshot 证据时猜 selector。JS 工具只输出一次错误标题与
   message，stack 只追加 frames，不能把同一错误正文重复两遍。
10. 每条能够对应到真实 tab 的 browser-use 命令都向 origin renderer 发送带
   `workspaceKey + sessionId + browserId + browserGeneration + tabId` 的 operation 事件。对应 browser-use 标签在事件到达后 5 秒内用
   鼠标图标替代 favicon，并在图标外层容器执行 900ms 一次的透明度 + 缩放呼吸动画；不得只给 SVG 套用通用
   `animate-pulse`，以免 14px 图标仅有缓慢透明度变化而无法被用户感知。同一 tab 的后续操作刷新 5 秒截止时间。截止后恢复
   已缓存的页面真实 favicon（缺省仍回退地球图标），不得为了状态提示覆盖或清空 favicon。动画必须遵守
   `prefers-reduced-motion`，且后台 workspace/session 的事件不得误标其它同路径 tab。
10. 第二个真实用户 turn 如果 IAB 仍可见，provider request 必须带有 bounded ambient context；模型不应先把
    finalize 后的空 `tabs.list()` 当成 backend 断线，也不应在没有证据时猜详情页 ID。
11. `ERR_ABORTED` 且最终 document 已提交到等价 redirect/SPA URL 时 `goto()` 返回成功；同错误但仍停旧页时
    返回失败。

日志：

- 高频 command、CDP、stream trace 用 debug。
- backend connect/disconnect、session create/close、extension host lifecycle 用 info。
- retry/degrade 用 warn，handshake/crash/security invariant 失败用 error。
- 不记录 credential、敏感输入或完整页面私密内容。

## 14. 多端、workspace 与远程约束

- `workspaceKey = workspaceIdentity?.trim() || workspacePath` 用于 backend cache、tab ownership、queue、request correlation 和持久化。
- workspacePath 仅用于 cwd、文件和路径展示。
- remote workspace 的 browser context 必须带 workspaceIdentity + remoteSessionId。
- desktop `desktop-continuous` 不拼接 web replayable 运行态恢复。
- mobile `web-remote-replayable` 不能绕过 snapshot/gap 恢复和阻塞确认。
- relay/main 不持有 browser task/stream/queue 业务状态；backend registry/lease 属于 shared host/provider。
- owner/lease 仍用于运行中 task、跨 host command、blocking interaction 和 stale run 防护。

## 15. 交付切面

### Slice A：Backend foundation（本规格首个实现切面）

- shared/contracts 定义 descriptor/type/context/list result。
- BrowserControlPort 支持真实 list/discovery 和 browserId-aware execute。
- ZCode Protocol 新增严格 schema 的 browser list，execute 带 browserId/context。
- services/host 暴露 IAB adapter descriptor；facade 通过 registry，不再硬编码 IAB。
- 实现第 5 节 selection 纯函数与单测。
- 当前只发现 IAB，不宣称 extension/cdp available。

实施结果：上述项目已完成。兼容期 execute context 为 optional，但新 broker 始终发送；`remoteSessionId` 因现有 session workspace ref 没有该字段而只能先预留 schema，实际贯穿移入 Slice B。desktop IAB descriptor 的 runtime id 在 host 生命周期内稳定，stale id 会在进入 main 前被拒绝。

### Slice B：IAB correctness

- workspace/window/session 隔离、真实 tabs.new/close/finalize、ready ack、cleanup。
- requestId/turnId/AbortSignal/clientMode 贯穿。
- response meta 和 command logging 修正。

实施结果：IAB provider 已完成 scope/generation、真实 tab ready/close、显式 user tab claim、agent-created 与 claimed-user 生命周期、`Tabs.finalize({ keep })`、handoff/deliverable、turn/session/window cleanup、abort 反向取消、browser-use 外层 meta 与 URL 脱敏。kernel reset 后通过单调 runtime generation 拒绝旧 binding，同时保留 backend 受控 tab 供新 runtime 恢复。产品按本规格第 13 节明确不生成自动 preview screenshot。extension/CDP 继续只保留 descriptor/registry/manifest 扩展口。

### Slice C：Manifest + common API

- clean-room API manifest/interpreter/proxy/docs。
- 默认 documentation 只装载 included guidance，截图等视觉说明按需 lookup。
- IAB snapshot 补充有界可见语义 DOM；模型提示和示例强制 DOM-first、观察结果回显。
- Playwright locator/wait/download/file chooser、clipboard/dev/content/capabilities。
- action-time confirmation。

实施结果：member-level manifest/interpreter/runtime proxy/docs 已与当前 IAB capability 动态绑定，补齐 common Playwright 的方法名集合、locator/frame locator、受信任 CDP input 与 IAB download object；IAB file chooser 明确不支持。`playwright.domSnapshot()` 已使用 AI/ARIA 输出及 3000/1000/500ms 顶层/iframe 预算，navigation wait 与 `expectNavigation` 采用并发等待语义，`networkidle` 按 IAB 实现明确拒绝。`tab.snapshot()` 仍是 z-code ref/action 兼容入口但不进入有效 common manifest；clipboard/dev/content/pageAssets/raw CDP 等未由 IAB descriptor 宣称，未来 backend 只能在真实实现后通过 capability/override 暴露。

### Slice D：Plugin/runtime 解耦

- Node REPL 独立化和 browser-use plugin 解耦。
- shared browser-client 产物进入 browser/chrome plugin 与四条打包链。
- fresh kernel 显式 bootstrap、lazy/deferred tool surface。

### Slice E：Extension

- ZCode Chrome extension/native host、安装/升级/诊断/profile selection。
- user tabs/history/claim/finalize 和安全确认。

### Slice F：CDP

- P0：CLI 显式 `--browser-use=headless` 创建 managed CDP provider；真实 launch/handshake 后发现 backend，
  按 session 隔离 BrowserContext，turn 保留 tab，session/app close 回收自己启动的 Chromium。
- P0 只宣称真实实现的 navigation/DOM/Playwright/CUA/screenshot/viewport/dialog 子集；user
  profile/history/claim、file chooser/download、clipboard/dev/raw CDP 等通过 manifest override 隐藏。
- P1：gated external CDP attach、target lifecycle、完整 CDP capability/security；外部 browser ownership
  与 managed launch 分开定义，禁止 attach 模式关闭用户 browser。

### Slice G：完整性收口

- 三 backend E2E、跨 backend 黑盒合同、desktop/mobile/remote 回归。
- API/docs/capability contract snapshot。
- plugin lifecycle/upgrade/disable/extension removal 回归。

## 16. 非目标与禁止的临时方案

- 不增加名为 `playwright` 的 backend。
- 不让 `get("extension")` 返回 IAB 或 stub。
- 不在 list 中报告未 handshake 的 backend。
- 不以 workspacePath 代替 remote workspace identity。
- 不把手机 remote browser runtime独立启动在 relay/main。
- 不通过 unrestricted evaluate 快速伪装 Playwright API。
- 不复制或 vendor 任何第三方私有资产。

## 17. 完成定义

“Browser Use 完整交付”只有在以下条件全部满足时才能宣称：

- 三 backend descriptor/discovery/selection 行为通过跨 backend 黑盒合同测试。
- manifest 声明的 observable API interfaces/members 均为 implemented 或按 capability 条件隐藏；没有公开但必定抛 NotImplemented 的 member。
- Playwright/CUA/DOM_CUA、tabs/user/content/clipboard/dev/dialog/capability 行为通过合同测试。
- action-time confirmation 和防绕过用例通过。
- response meta、timeout/kernel reset、turnEnded/finalize/cleanup 通过。
- Desktop local、remote workspace、mobile replayable 都通过隔离与恢复验证。
- browser/chrome plugin install/disable/upgrade 与 extension/native-host 状态机通过。
- `pnpm typecheck`、`pnpm lint`、相关 unit/integration/E2E 全部通过。

在此之前，版本说明必须明确当前完成的 slice 和未实现能力，不能用“Browser Use 已完整交付”。
