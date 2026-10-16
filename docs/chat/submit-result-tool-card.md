# submit_result 工具卡（「已提交结果」）

## 发布状态

设计定稿，随本 spec 之后的提交实现。前置事实：

- actor 侧板**不是**独立的转写渲染器——`WorkflowActorSessionSidePane` 挂载的是嵌套只读
  `SessionPane`（`packages/ui/src/app-shell/WorkflowActorSessionSidePane.tsx:86-101`，其文件注释
  明说实时流 / 冷恢复 / 回看全走既有 SessionPane 链路），所以 `submit_result` 以普通 v4
  `toolCall` 行到达，由主会话同一套 ToolCallBlocks registry 渲染；
- `submit_result` 不在 UI 已知工具表里（`packages/shared/src/tool-identity.ts` 的
  `ZCODE_KNOWN_TOOL_NAMES` 止于 `CreateWorkflow`）→ family `"unknown"` →
  `FallbackToolCallBlock`：扳手图标、首字母大写出来的标签「Submit_result」、以及**整个 toolCall
  对象**的 `JSON.stringify(…, null, 2)` 裸 `<pre>`（`renderers/fallback.tsx:63-67`，还用着
  off-token 的 `text-ui-xs`）；
- 载荷全部在**输入**侧：工具输出 schema 只有 `{status: "accepted"}`
  （`apps/zcode-cli/packages/contracts/src/tools/submit-result.ts:29-33`），输入是单键
  `{result: <unknown>}`——每次 ask 的具体 JSON Schema 走指令尾注而非工具声明（声明冻结以保
  prompt cache）。

（2026-09-01 用户裁决）驳回态卡改为不可展开的扁平行——逐字段违规面板整体撤除（连同
`parseSubmitResultViolations` 与 `violationsHeading` 词条），驳回原文经失败态 `statusTooltip`
（悬停可复制）保留可达；接受/停止态展开行为不变。

## Feature Summary

| Field | Value |
| --- | --- |
| Change | ToolCallBlocks registry 注册 `submit_result` 专用渲染器：标签「已提交结果」（相位分档），body 智能渲染 `input.result`（字符串 → 正文 prose；对象/数组 → 语法高亮 JSON CodeBlock），默认折叠可展开；驳回态是不可展开扁平行（驳回原文走失败态 tooltip，见发布状态 2026-09-01 裁决） |
| User-visible surfaces | 工具卡（actor 侧板与主会话共用同一 registry——修一处两面都好）。无新 display kind、无协议改动、无 CLI 改动 |
| Existing behavior | fallback 渲染：「Submit_result」+ 整个 toolCall 的裸 JSON dump |
| State owner | 无新状态。纯读时投影：`toolCall.input.result` 直读（`RespondToCoordinator` 直读 `input.summary` 的同款先例） |
| Out of scope | display union 新成员；CLI/引擎改动；per-ask schema 感知的字段级渲染；通用 zh/en key-parity 测试 |

## Clarification Log

| Round | Question | User answer | Boundary fixed |
| --- | --- | --- | --- |
| 1 | body 怎么渲染提交对象 | **智能分流**：字符串 → prose，对象 → JSON CodeBlock | 归一化后按类型分流；两条路径都有既有 idiom（run 错误文案的 prose 论证 / `mcp.tsx` 的 CodeBlock 块） |
| 1 | 默认展开还是折叠 | **默认折叠**，可展开 | 与其余工具卡同规；折叠头部给一行 result 概要 |
| 1 | 驳回（schema 违规重试）显示什么 | **驳回标签 + 违规行** | handler 的违规文案格式稳定（`<path>: expected …, got …`），重试循环在转写里可读 |

## Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| 路由注册 | `packages/shared/src/tool-identity.ts`：`ZCODE_KNOWN_TOOL_NAMES` 加**字面** `"submit_result"`，`TOOL_FAMILY_BY_NAME` 归 family `"workflow"`（Record 是 total 的，TS 强制成对）；`resolveRenderer.ts` 的 `workflow` case 内按 `identity.toolName` 分派新渲染器 | 大小写不敏感匹配已有（`normalizeZCodeToolName` 走小写表），但下划线必须字面在场——wire 名就是 `submit_result`，仓库里唯一的 snake_case 工具 | 不新造 family（`message` family 对 `RespondToCoordinator` 的同款先例：family 内按名分派）；CLI 侧不改名 | `RespondToCoordinator` 先例（`resolveRenderer.ts:74-76`） |
| 数据源 | 渲染器直读 `toolCall.input.result`；接受态输出恒为「The result was accepted.」无信息量，不读 | `input` 经 `toolCallRowAdapter.ts:38-55` 已是解析对象；流式首帧可能是 `{}` 或半成品（`inputPreviewComplete: false`） | **不加** display union 成员——那要契约 + v4 + UI parser + producer 四处锁步（`toolDisplay.ts:125-128` 记档过漏一处静默降级的偏斜坑），而载荷本来就全在输入侧 | scout 双方一致结论 |
| result 归一化 | 字符串先试一次宽容 `JSON.parse`，解析出对象/数组则用解析值；解析失败或本就是字符串 → 按 prose 对待 | 这是引擎侧实盘结论的**读侧镜像**：`engine/scheduler.ts:252-278` 记档「真实模型常把 `result` 序列化成 JSON 字符串」并做同款单次宽容 parse；UI 侧 `toRecord`（`respond-to-coordinator.tsx:13-29`）同 idiom | 只在读时归一化，绝不改写任何数据；不做多层递归 parse（引擎也只做一次） | `scheduler.ts:252-278` + `toRecord` 先例 |
| body 渲染（prose 分支） | 归一化后是字符串 → 正文体渲染（pre-wrap、语义 token、**非 mono**） | 人话是 prose——`WorkflowRunSidePane.tsx:329-336` 对 run 错误文案引 DESIGN.md 的同一条论证（mono 留给路径/命令/代码/标识符/终端数据） | 不做 markdown 渲染（result 字符串没有 markdown 契约，渲染成富文本是无据的猜测） | DESIGN.md + run 错误文案先例 |
| body 渲染（JSON 分支） | 对象/数组/其余非字符串 → `JSON.stringify(…, null, 2)` 进 `CodeBlock language="json"`，`mcp.tsx:283-294` 的容器 idiom（`max-h` 滚动 + `rounded-xl border border-border bg-card`） | CodeBlock 尊重用户 code 字号设置（DESIGN.md:189/220）；顺带修正 fallback 的 off-token `text-ui-xs`（DESIGN.md:203 把 xs 留给徽章/计数器） | 不手搓 `<pre>`（那会绕开 code 字号设置） | `mcp.tsx` idiom + DESIGN.md |
| 折叠与流式门 | 默认折叠（`canToggle`）；**`hasDetails` 门**：`input` 里 `result` 键在场才提供展开/`renderContent`（`send-message.tsx:112,192-193,206` 逐字 idiom）；折叠头部一行截断概要（result 归一化后的单行压缩） | `ToolSnapshotFieldNotice` 保留（每个非 fallback 渲染器与 ToolLayout 的固定搭配，`send-message.tsx:208-215`） | 不给空首帧一个空面板的展开入口；不用 `summaryAction`（它会整个短路 body，`ToolLayout.tsx:101/109/286`） | `send-message.tsx` 先例 |
| 标签相位 | i18n 新块 `chat.toolCall.submitResult.*`，两 locale 紧邻 `respondToCoordinator` 块：completed → `submitted`「已提交结果」/ "Result submitted"；pending/in_progress → `submitting`「正在提交结果」/ "Submitting result"；failed → `rejected`「提交被驳回」/ "Submission rejected"；stopped → `stopped`「提交已停止」/ "Submission stopped" | 缺 key 静默渲染裸 key（`IntlProvider.tsx:109` `messages[id] ?? id`）→ 两 locale **必须**同 commit 落齐 | 不复用 respondToCoordinator 的 key（语义不同：那边是「回复」，这边是「提交结果」） | i18n 机制事实 |
| 驳回态 body | （2026-09-01 用户裁决）`failed` 时卡是不可展开的扁平行：无 toggle 入口、无展开 body。驳回原文经失败态 `statusTooltip`（悬停可复制）保留可达 | 相位标签「提交被驳回」+ 失败态状态标签与 tooltip | 逐字段违规面板整体撤除（`parseSubmitResultViolations`、`violationsHeading` 词条一并删除）；不在 UI 复述 schema | 用户裁决 + 失败态 tooltip idiom |
| 测试归属 | `packages/ui/test/` 新 `submitResultToolCallBlock.test.tsx`（渲染各态）+ `packages/shared` 的 tool-identity 断言扩展 | 无既有 e2e fixture 含 submit_result 行（scout 穷尽扫描证实）——单测自造 toolCall 即可，e2e 不在本期 | — | scout 验证的阴性事实 |

## 数据流

```
actor 会话（真实持久会话）
  → v4 toolCall 行 {toolName: "submit_result", input: {result: <JSON | JSON-string>}, output: {text: "The result was accepted." | 违规文本}}
  → toolCallRowAdapter（input 原样透传；流式帧经 preview 重建，inputPreviewComplete=false）
  → resolveToolCallIdentity：ZCODE_KNOWN_TOOL_NAMES 命中 "submit_result" → family "workflow"
  → resolveRenderer：workflow case 按 toolName 分派 → SubmitResultToolCallBlock
      标签：相位 → chat.toolCall.submitResult.{submitting|submitted|rejected|stopped}
      body（hasDetails 门后，默认折叠）：
        normalize(input.result)：string 且可 parse 为对象/数组 → 解析值
        ├─ string → prose 正文（pre-wrap、非 mono）
        └─ object/array/其他 → CodeBlock language="json"（mcp.tsx 容器 idiom）
      failed 分支：卡为不可展开扁平行；驳回原文经失败态 statusTooltip 可达（无展开 body）
```

## Invariants

- 纯 UI 投影：不写任何状态、不改 CLI/协议/display union；修一处（registry）两面（主会话 +
  actor 侧板）同时生效。
- 归一化只在读时发生：`JSON.parse` 至多一次（引擎同款宽容度），失败即按字符串对待，绝不抛错
  毁卡。
- 空/半成品流式帧绝不提供空面板的展开入口（`hasDetails` 门）。
- 两 locale 的 `chat.toolCall.submitResult.*` 同 commit 落齐——缺 key 渲染裸 key 是静默降级。
- mono 只给数据（JSON 分支），人话（prose 分支、违规行前的标签）走正文 token。

## Tests

| Case | 位置 |
| --- | --- |
| 路由：`submit_result` 命中 family `workflow`；resolveRenderer 分派到新渲染器；`CreateWorkflow` 仍分派到原渲染器（family 内分派不误伤） | `packages/shared` tool-identity 断言 + `packages/ui/test/`（照 resolveRenderer 既有测试模式） |
| completed + 对象 result → 标签「已提交结果」+ 展开后 JSON CodeBlock | `packages/ui/test/submitResultToolCallBlock.test.tsx`（新） |
| completed + 纯字符串 result → prose 正文（无 CodeBlock） | 同上 |
| completed + JSON 字符串 result（`"{\"a\":1}"`）→ 解开为对象走 CodeBlock 分支 | 同上 |
| 流式空帧（`input` 无 `result` 键）→ 无展开入口、无空面板 | 同上 |
| failed → 标签「提交被驳回」+ 不可展开扁平行（无 toggle、无 body）；驳回原文走失败态 statusTooltip | 同上 |
| stopped → 「提交已停止」 | 同上 |
| 两 locale key 在场（`submitting`/`submitted`/`rejected`/`stopped` × zh/en） | 同上（或 i18n 断言测试） |

## Follow-ups（记录在案，不在本特性范围）

| Item | 为什么现在不做 |
| --- | --- |
| per-ask schema 感知的字段级渲染（key-value 卡） | ask 的 JSON Schema 只活在指令尾注，UI 不可达；要送达 UI 得动协议 |
| 通用 zh/en key-parity 测试 | 仓库缺此测试是既有事实（scout 证实），补齐是独立的一轮基建 |
| e2e fixture 含 submit_result 行 | 本期单测自造 toolCall 足够；e2e 场景与 workflow e2e 骨架一起设计 |
