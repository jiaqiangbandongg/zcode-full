# node_repl 三工具规格（T2，历史实现）

> 2026-07-13：本 spec 记录旧 core built-in 路线，已由
> `docs/browser-use/2026-07-13-node-repl-mcp-runtime-spec.md` 取代。当前官方 browser-use 插件通过真实
> `node_repl` MCP server 暴露 `mcp__node_repl__js*`；旧 handler 仅留兼容代码，不再由插件启用。

> 状态：已实现。
> 上位：`2026-07-07-browser-use-cdp-node-repl-spec.md`；依赖 T1 `NodeReplSession`。
> 范围：把 `NodeReplSession` 引擎包装成 agent 的三个内置工具（`js`/`js_reset`/`js_add_node_module_dir`）。通用基建，与 browser 解耦。

## 1. 工具（内置，无 mcp__ 前缀）

| 工具名 | 入参 | 输出 | 语义 |
|---|---|---|---|
| `js` | `{ code: string }` | `{ result?, logs, error? }` | 在该 session 的持久 REPL 执行代码 |
| `js_reset` | `{}` | `{ ok: true }` | 重建 context，清空跨调用状态 |
| `js_add_node_module_dir` | `{ dir: string }` | `{ ok: true, dirs: string[] }` | 追加模块解析目录 |

## 2. 三段式落点

- **contracts** `apps/zcode-cli/packages/contracts/src/tools/node-repl.ts`（新）：
  - `JsInputSchema`/`JsOutputSchema`、`JsResetInputSchema`/`...Output`、`JsAddModuleDirInputSchema`/`...Output`（zod），各配 `toToolJsonSchema()` 的 JsonSchema。
  - 在 `contracts/src/tools/index.ts` 加 `export * from "./node-repl.js"`。
- **core handler** `apps/zcode-cli/packages/core/src/tool/handlers/node-repl.ts`（新）：
  - 模块级 `const sessions = new Map<SessionId, NodeReplSession>()`（跨工具调用持久，key=`context.sessionId`）。
  - `getSession(ctx)`：无则 `new NodeReplSession({ injectedGlobals })`（T2 阶段 injectedGlobals 为空；T6 注入 browser execute + agent）。
  - 三个 `ToolEntry` 导出：`jsToolEntry`/`jsResetToolEntry`/`jsAddModuleDirToolEntry`。
  - `js` handler：`session.run(code, { signal: ctx.abortSignal })` → 返回 `{result,logs,error}`；大 logs 走 `resultBudget` artifact（遵 CLAUDE.md 大结果落盘）。
  - session 生命周期：暂随 Map 常驻（P0 够用）；后续可在 session close 时 dispose（T9 生命周期任务处理）。
- **注册** `handlers/index.ts`：三 entry 加进 `builtInTools`；`RegisterBuiltInToolsOptions` 加 `includeNodeRepl?: boolean`，仅该开关开时注册（desktop 开、纯 CLI 视需要）。

## 3. ToolEntry 关键字段

- `metadata`: `readOnly:false`、`destructive:false`、`concurrentSafe:false`（共享 context 必须串行）、`sideEffectScope:"system"`、`riskLevel:"high"`、`needsApproval:true`、`timeoutMs`（js 默认 60s，js_reset/add_dir 短）。
- `permission`: `permission:"node_repl"`、`riskLevel:"high"`、`sideEffectScope:"system"`、`needsApproval:true`、`patternSources:["code"]`（js）。理由：vm 与 bash 同权，能跑任意 JS。
- `timeout`/`cancellation`: 复用默认策略；js 的 handler 把 `ctx.abortSignal` 透传给 `run`。
- `formatModelContent`: 把 `{result,logs,error}` 组织成模型可读文本（error 优先、logs 次、result 末）。

## 4. 安全与错误

- handler 内 `run()` 已结构化返回 error，不 throw；handler 再包一层 try/catch 兜底 session 获取失败。
- 大输出：logs 超阈值走 artifact（`resultBudget` strategy:"artifact"），只回预览 + 引用。
- 并发：`concurrentSafe:false` 让 runtime 串行化同 session 的 js 调用（共享 vm context 不可并发）。

## 5. 验证点（T2 单测 `packages/core/tests/node-repl-tools.test.ts`）

- `js` 执行 `globalThis.x=1` 后再 `js` 读到（同 sessionId 复用 session）。
- 不同 sessionId 隔离（各自 session）。
- `js_reset` 后状态清空。
- `js_add_node_module_dir` 累加并回显 dirs。
- js 抛错 → 输出含结构化 error，不 throw。
- 大 logs → 走 artifact 预览（若测桩 artifactStore）。
- schema：JsInputSchema parse/reject；JsonSchema 生成非空。
- 注册：`includeNodeRepl` 开时三工具在 registry，关时不在。

## 6. 聊天区展示规格

### 6.1 变更摘要与澄清记录

| 字段         | 结论                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| 用户可见目标 | 普通用户只看到“正在做什么、是否完成、得到什么结果”，不暴露工具实现名或原始协议结构                      |
| 摘要标题     | 新发起的 `js` 必须提供 `input.title`，UI 优先原样展示；仅旧记录缺失标题时按状态显示兜底文案             |
| 操作图标     | 浏览器操作卡片使用 Lucide `square-mouse-pointer`，表达网页指向与点击语义                               |
| 结果层级     | 展开工具后先展示结果；执行代码和错误栈收进二级“查看执行细节”                                            |
| 结果清理     | 专用卡片移除投影文本中的 `=> ` 完成值标记；底层结果、持久化内容与模型通信保持原样                        |
| 结果呈现     | 保留内层“结果”标题与结果区边框；移除包裹结果、图片和执行详情的最外层卡片；复制和换行操作继续保留        |
| 详情入口     | “查看执行细节”默认使用弱提示文字色，hover 时变为主文字色；所有状态保持透明背景                          |
| 代码清理     | 执行内容移除输入开头的空白行，同时保留首个有效行自身的缩进                                              |
| 原始数据     | `toolId`、`toolName`、`kind`、`raw` 等原始 JSON 不在普通聊天区展示，只保留给开发者调试入口              |
| 辅助工具     | `js_reset` 显示“重置操作环境”，`js_add_node_module_dir` 显示“配置运行目录”，成功时不展示 `{ ok: true }` |
| 用户确认     | 2026-07-13：用户确认界面不得吐出 `js`、`javascript` 等技术术语，并确认上述用户友好方案                  |

`input.title` 是用户可见产品文案。工具契约必须要求模型使用当前用户语言描述本次操作目标，不能把实现名当标题。动态标题原样保留，不由 UI 猜测或翻译；运行时继续兼容缺少标题的旧调用，UI 只为旧记录提供本地化 fallback。

### 6.2 领域与状态边界

| 领域                     | 决策                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| UI renderer              | 新增专用展示与输出归一化；不复用通用 fallback 的 Parameters / Result / raw JSON             |
| Tool identity            | 三个工具归入同一个展示 family，以精确工具名分流，不用 title/kind 模糊猜测                   |
| Agent runtime / protocol | 不修改执行、权限、结果预算、事件或 schema；继续消费现有 input/output/raw                    |
| Desktop / Web / mobile   | 共用 `packages/ui` renderer；窄屏纵向排列，不引入桌面专属交互                               |
| Continuous / replayable  | 只改变最终 UI 投影，不改变 `desktop-continuous` 与 `web-remote-replayable` 的交付和恢复语义 |
| Theme / locale           | 只用语义 token；新增中英文文案，动态 `input.title` 保持原文                                 |

状态权威仍是 tool call 的 `status/input/output/raw`。UI 允许从 provider 投影后的字符串、`{ type: "text", value }` 或 `rawOutput` 结构中归一化同一结果，但不得把解析结果写回 session/store，也不得依据 UI 文案改变工具状态。

### 6.3 候选组合与剪枝

| Case ID   | 前置                                | 展示结果                                                                         | 状态     |
| --------- | ----------------------------------- | -------------------------------------------------------------------------------- | -------- |
| NRP-UI-01 | `js` running，存在用户友好 title    | 摘要显示 title +“处理中”；不展示工具实现名                                       | accepted |
| NRP-UI-02 | `js` completed，文本结果            | 摘要显示 title +“已完成”；展开后结果优先，代码在二级详情                         | accepted |
| NRP-UI-03 | `js` completed，无 title、无输出    | 摘要显示“操作已完成”；展开结果显示“没有可展示的结果”                             | accepted |
| NRP-UI-04 | `js` failed，结构化 error/stack     | 摘要显示“操作失败”；可读原因进入结果，代码与 stack 进入二级详情                  | accepted |
| NRP-UI-05 | `js` 结果超过预算并持久化           | 展示清理后的 preview、结果大小和“查看完整结果”；不展示 `<persisted-output>` 包装 | accepted |
| NRP-UI-06 | `js_reset` completed                | 显示“已重置操作环境”，不展开成功 JSON                                            | accepted |
| NRP-UI-07 | `js_add_node_module_dir` completed  | 显示“已配置运行目录”及目标目录，不展开成功 JSON                                  | accepted |
| NRP-UI-08 | 桌面或手机、明暗主题、中英文 locale | 复用同一纵向布局和语义 token，静态文案随 locale 变化                             | accepted |
| NRP-UI-09 | 浏览器操作工具摘要                  | 使用 Lucide `square-mouse-pointer`，其他工具图标不受影响                          | accepted |
| NRP-UI-10 | 新发起的 `js` 调用                  | 工具契约要求提供用户可读 `title`；流式与完成态均优先显示该标题                    | accepted |
| NRP-UI-11 | 已投影的完成值文本以 `=> ` 开头     | 用户结果只显示正文，不显示技术标记；其他工具和底层结果不受影响                   | accepted |
| NRP-UI-12 | 展开普通文本结果                    | 显示“结果”标题、正文和操作按钮，保留结果区边框；不显示最外层卡片                 | accepted |
| NRP-UI-13 | hover“查看执行细节”                 | 文字由弱提示色变为主文字色，不出现背景色                                         | accepted |
| NRP-UI-14 | 执行内容以一个或多个空白行开头      | 展示时移除空白行，并保留首个有效行的缩进                                         | accepted |

以下组合按不变量剪枝：provider/model 不改变展示语义，只保留一种结构化和一种文本投影代表；workspace identity 不参与展示判定；continuous/replayable 不改变最终 tool call 卡片，只各自负责既有事件交付；运行环境 reset/add-dir 的成功 payload 没有额外用户信息，因此不展示原始对象。

### 6.4 验证证据

- identity 单测：三个精确工具名都进入专用 family，其他未知工具仍走 fallback。
- parser 单测：覆盖 title/code、代码开头空白行、字符串输出、完成值标记清理、text wrapper、结构化 logs/result/error、持久化大结果 envelope。
- renderer 单测：覆盖专用路由、用户友好摘要、保留标题和内层边框且无外层卡片的结果区、透明详情入口、二级执行详情、reset/add-dir，以及普通视图不出现 Parameters、Result、原始 JSON 和工具实现名。
- 本变更不新增 conversation E2E：桌面与手机共用同一 renderer，先以组件测试证明响应式 DOM 合同；若后续引入端侧差异或 replay 恢复专属状态，再补 catalog/matrix 和正式 E2E。
