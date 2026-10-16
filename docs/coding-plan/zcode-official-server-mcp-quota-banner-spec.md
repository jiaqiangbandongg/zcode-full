# ZCode 官方 Server MCP：不可用时的输入框提示（额度耗尽 / 无 Coding Plan 权益）规格

- 状态：T1（服务端错误码 → 输入框提示）已实现；T2（退登换 API Key 的本地分类）未实现，见 §10.2
- 当前统一鉴权与 scope 事实见 `zcode-official-server-mcp-auth-spec.md`；本文只维护 quota/banner 产品行为。
- 前置：`zcode-official-server-mcp-client-phase-1-spec.md`（下称 "phase-1"）。信任判定口径、身份头集合、
  凭证解析与失败分类全部沿用 phase-1，本文不重复
- 涉及仓库：`z-code`（客户端）与 `zcode-server`（服务端），两侧共用同一组 tool error code
- 驱动需求：官方 Server MCP 有权益门槛与每日配额。两者任一不通过时，用户在界面上得不到任何解释，
  只能看到模型"工具调用失败了"然后自行猜测
- 文中行号取自 2026-08-20 的 staging，仅用于定位，会随代码漂移；§4 的契约以服务端
  `internal/domain/servermcp/toolerror.go` 为准

## 1. 目标

官方 Server MCP 因**权益不足**或**当日配额耗尽**而不可用时，在输入框上方给出一条可读提示，
说明是哪一种原因、是哪一类额度、何时恢复，并在权益不足时给出升级入口。

形态复用现有的 `ConversationQuotaBanner`——即 Coding Plan 用户当前看到的那条额度提示。

## 2. 现状：为什么现在什么都不会显示

### 2.1 服务端两种失败都只有文本

官方 MCP 的每次 tool call 都要过 `Service.authorize`（`internal/domain/servermcp/service.go:155`）：

1. `CheckEligibility` —— 无可用 Coding Plan 时返回 `ErrCodingPlanRequired`
   （`internal/domain/servermcp/billing.go:58`）；
2. `CheckQuota` —— 当日桶配额耗尽时返回 `ErrQuotaExceeded`
   （`internal/domain/servermcp/quota.go:63`）。

两者都被 `fmt.Errorf` 拍成字符串再层层包裹，最后 5 个 local tool handler 直接
`return nil, nil, fmt.Errorf(...)`（`internal/interfaces/web/controller/mcp_controller.go`）。
go-sdk 在 `mcp/server.go:381` 把 handler 返回的普通 error 兜成
`CallToolResult{IsError: true}` + 纯文本 content。

结果：**客户端只拿到一段自由文本**，没有错误码、没有桶名、没有恢复时间——而这些字段在
`CheckQuota` 里本来全都有（`used` / `limit` / `conf.NextRefreshAt(now)`），只是被字符串化丢掉了。

### 2.2 客户端拿不到"错误态"

MCP 的 in-band `isError: true` 在 CLI 侧算**成功执行**：`turn-tools.ts:269` 只把 `isError` 传给
模型消息，`result.success` 仍为 `true`。因此 v4 的 `toolCall` row 是 `status: "success"`、
没有 `error.code`。

⇒ 提示不能依赖 row 的错误态，只能靠**工具结果自身携带结构化标识**。

### 2.3 "退登换 API Key" 这条路径根本不会发请求

这是本次要覆盖的第二个场景，也是最容易被漏掉的一个：

用户先以 Coding Plan 登录、配好了官方 MCP，之后退出登录改用 API Key。此时
`resolveOfficialMcpCredentials`（`packages/services/src/official-mcp/officialMcpCredentials.ts:173`）
判定为 `official_auth_plan_required`，按 phase-1 §6.3.3 **一个字节都不会发出**；官方 MCP 连接失败，
工具不进注册表，模型也就无从调用。

⇒ 服务端的权益错误码在这条路径上**永远到不了客户端**。而该失败分类目前只写进日志
（`apps/zcode-cli/packages/adapters/src/mcp/index.ts:898`），没有进入 `McpServerStatus`，UI 取不到。

### 2.4 MCP 路由不验套餐

`internal/interfaces/web/router.go:163` 用的是 `WithCodingPlanContext()`——只解析身份头、**不 verify**，
头缺失直接回 400（`/api/v1/mcp/usage` 才用带 verifier 的 `WithCodingPlan`）。套餐失效是在 tool call
内部被 `CheckEligibility` 拦下的，走 in-band isError，不是 HTTP 错误。

### 2.5 banner 有现成范式

`provider-limited`（`packages/ui/src/v4/sessionQuotaBannerState.ts:198`）就是"用后端 message 直接展示 +
可关闭"的实现，新 kind 照抄即可，不需要新的 UI 组件。

## 3. 范围

### 3.1 范围内

- 服务端把两类失败类型化，并在 tool result 上带出结构化标识；
- 客户端解析该标识，经 tool result display → v4 row → banner；
- 客户端把本地 `official_auth_plan_required` 分类提升进 MCP 状态，覆盖 2.3 的场景；
- 双语文案、去重与优先级规则、相应测试。

### 3.2 范围外

- 阻断输入（`blocksSubmit` 保持 `false`）：MCP 不可用不影响模型对话；
- 额度数值展示：输入框浮层里已有 MCP 额度那一格，本文只做"不可用"提示；
- 服务端配额策略本身（桶划分、各等级额度）；
- v4 `SessionPane` 以外的界面（现有 quota banner 也只在这里）。

## 4. 协议契约：tool error content 里的 `error_code`

> 本节已按服务端 2026-08-20 的实现修正。设计初稿曾假设标识放在 `CallToolResult._meta` 的
> `com.zcode/mcp-unavailable` 键上；服务端最终选择把它渲染进 **tool error content 的 JSON 文本**，
> 客户端按后者实现。

### 4.1 形态

服务端 `internal/domain/servermcp/toolerror.go` 的 `ToolError.Error()` 输出一行 JSON，作为
tool error 的 text content 下发（`IsError: true`）：

```json
{"error_code":"quota_exceeded","message":"daily quota exceeded for bucket search_image (5/5), retry tomorrow or upgrade your coding plan","request_id":"..."}
```

两条产出路径：本地工具 handler 返回 `ToolErrorFor(err, requestID)`（go-sdk 把普通 error 兜成
`IsError` 结果），上游转发用 `ToolErrorResult` 直接构造同形结果。

### 4.2 code

| code | 含义 | 客户端行为 |
|---|---|---|
| `quota_exceeded` | 当日桶配额耗尽 / 无可用配额 | 提示"今日额度用完"，可关闭，无动作 |
| `coding_plan_required` | 无可用 Coding Plan（缺上下文或验签不过） | 提示"需要 Coding Plan"，可关闭，挂升级入口 |
| `internal_error` | 其它一切失败的兜底掩码 | **不识别、不提示**——详情只在服务端日志，用户无法自助解决 |

### 4.3 约定

- `error_code` 是唯一的分流依据。**不做文案匹配兜底**：那会让服务端改一句话就静默失效；
- `message` 是英文，只用于日志与排障。界面文案一律走 i18n，因此客户端不把它搬到 banner 上
  （这一点与 `provider-limited` 不同——后者的 message 是中文业务文案）；
- `request_id` 用于与服务端日志对账；
- 解析严格：必须是 JSON 对象且 `error_code` 命中已知 code，否则整体忽略；
- 单一声明处：`packages/shared/src/official-mcp-tool-error.ts` 的
  `OFFICIAL_MCP_TOOL_ERROR_CODES` 与 `parseOfficialMcpToolError`，被 CLI core、v4 row schema、
  UI 三处消费，避免新增 code 时一侧识别、另一侧丢弃。
- 客户端遇到未知 `code`、字段缺失或类型不符时**整体忽略**，不做兜底猜测，也不弹提示；
- `IsError` 仍为 `true`、`content` 仍带同一段文本——模型侧行为不变，标识只是附加信息。

## 5. 服务端实现（`zcode-server`，已完成）

### 5.1 `ToolError` 统一承载

`internal/domain/servermcp/toolerror.go`：

- `ToolError{Code, Message, RequestID}`，`Error()` 渲染成 §4.1 的 JSON；`Unwrap()` 返回内部
  sentinel（`ErrQuotaExceeded` / `ErrCodingPlanRequired`），既保住 `errors.Is` 语义，
  又不把内部错误链暴露给客户端；
- `ToolErrorFor(err, requestID)` 把服务错误映射成客户端可见形态：已是 `ToolError` 的直接透传
  （补 request id），两个 sentinel 映射到对应 code，**其余一切**（上游、网关、基础设施失败）
  统一掩成 `internal_error`，细节只留服务端日志；
- `ToolErrorResult(err, requestID)` 是给裸 handler（上游转发）用的版本，直接构造 `IsError` 结果。

### 5.2 拦截点

- `CheckQuota`（`quota.go`）三种情况都返回 `ToolError{Code: quota_exceeded}`：桶无归属、
  该等级无配额、当日已用满（文案含桶名与 used/limit）；
- `CheckEligibility`（`billing.go`）两种情况返回 `ToolError{Code: coding_plan_required}`：
  缺 Coding Plan 上下文、验签不过；
- 5 个本地 tool handler 与上游转发都已接上（`mcp_controller.go`）。

### 5.3 客户端未使用的字段

服务端文案里带了桶名与 used/limit，但**没有** `next_refresh_at`。因此界面不承诺具体恢复时刻，
只说"明天恢复"——自然日重置这一点由 `QuotaConfig.NextRefreshAt` 保证，输入框浮层里的 MCP 额度
那一格另有精确重置日期可看。
## 6. 客户端实现（`z-code`，已完成 T1）

| 触发源 | 场景 | 信号 | 状态 |
|---|---|---|---|
| T1 | 有凭证、请求已发出：配额耗尽 / 套餐失效 | tool error content 的 `error_code` | 已实现 |
| T2 | 退登换 API Key、未登录：请求不发出 | 本地 `official_auth_plan_required` | 未实现，见 §10.2 |

### 6.1 契约单一声明处

`packages/shared/src/official-mcp-tool-error.ts`：`OFFICIAL_MCP_TOOL_ERROR_CODES` 与
`parseOfficialMcpToolError`。放 shared 是因为三个分属不同包的消费者要同源——CLI core（解析结果）、
v4 row schema（校验 code）、UI（按 code 决定文案与动作）。

`McpToolDescriptor` 增加 `official?: boolean`（见 §6.2）。

### 6.2 只信 http 官方 MCP（安全相关，不能省）

不判来源的话，**任意 MCP server 都能在结果里塞同样的 payload，伪造一条 Coding Plan 提示**。
凭证不会外泄，但会误导用户去购买 / 升级套餐。

判据是**结果由谁产出**，而不是"插件是谁"（SG-02 修正）：

| 形态 | 结果产出方 | 能否伪造 `error_code` | 是否置位 |
| --- | --- | --- | --- |
| `http` + `auth.type=zcode_official` | ZCode 后端（连接存活即意味着逐请求 origin 校验通过且 fail closed） | 不能——插件只能把请求打到真实 ZCode，响应体不由它写 | ✓ |
| `stdio` + `auth.type=zcode_official` | 插件进程自己 | **能**，任意字符串 | ✗ |
| 其它 | 第三方 server | 能 | ✗ |

**刻意不按"插件是否来自官方 marketplace"判定**：那会让非官方安装源（本地自测、
zcode-plugins-test）的官方插件直接失效，而它也不是真实屏障（详见 `isOfficialMcpOriginTrusted`
的"已知残留风险"一节）。

已知代价：stdio 官方插件（video-agent-kit）的失败不再触发提示。实际不构成能力损失——它输出的是
自己的错误文案（`[ERROR] zcode_speech transcription failed: …`），本来就不匹配
`parseOfficialMcpToolError` 的严格解析。若将来 stdio 确实要透传服务端的结构化失败，需要另设一条
经宿主背书的通道，而不是放宽这里。

- `apps/zcode-cli/packages/adapters/src/mcp/index.ts`：`normalizeMcpToolDescriptor` 调用处按
  `config.type === "http" && config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE` 传入 official；
  `descriptor.ts` 透传；
- `apps/zcode-cli/packages/core/src/mcp/index.ts` 把标记带进 `mcpPresentation`；
- `core/src/tool/types.ts` 的 `mcpPresentation` 同步加字段。

### 6.3 结果级 display → v4 row

- `core/src/tool/executor/result-display.ts`：`createMcpToolDisplay` 增加可选的 `output` 入参，
  官方来源时从 `output.content` 的 text block 里读 `error_code`，命中则在 `mcp_tool` display 上
  追加 `unavailable: { code }`。`createToolResultDisplay` 把结果透传进去（`call-runner.ts` 已经
  拿 `output` 调它，无需改调用方）；
- **两个 `.strict()` schema 同步加同一字段**，否则 row 会被校验拒掉：
  `apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts`（`mcpToolResultDisplayPayloadSchema`）
  与 `packages/shared/src/zcode-protocol-v4/rows.ts`（`toolCallMcpDisplaySchema`）；两处的 code
  枚举都取自 §6.1 的单一声明；
- `product-projection.ts` 已经把 `payload.result.display` 整体透传进 `toolCall` row，投影层零改动。

### 6.4 banner

- `packages/ui/src/v4/mcpUnavailableBannerNotice.ts`：`resolveMcpUnavailableNotice(rows)` 从窗口
  内**最新**一条带 `display.unavailable` 的 `mcp_tool` row 产出 `{ code, serverName, toolName, rowId }`。
  取最新而非第一条：同一会话可能先撞额度、后换连接又撞权益，提示要跟随最近事实；
- `sessionQuotaBannerState.ts`：新增 kind `mcp-quota-exhausted` / `mcp-plan-required`，
  **插在 `provider-limited` 之后、Start-Plan-only 早退之前**（Coding Plan 会话一定命中那道早退，
  放其后永远不生效）；新增 `mcpServerName` / `mcpNoticeRowId` 两个 state 字段，后者进 dismiss key；
- `ConversationQuotaBanner.tsx`：`MESSAGE_IDS` 两条映射，`server` 作为文案变量传入；
- `useV4SessionQuotaBanner.ts`：新增入参 `mcpUnavailableNotice`（由调用方从 rows 解析——它是会话
  事件投影，与 entitlement 服务无关，不放进这个 hook 里取）；
- `SessionPane.tsx`：`useMemo` 解析 notice 后传进 hook。渲染条件不动——有 composer error 时仍以
  错误为先。

## 7. 展示规格

| 项 | `mcp-quota-exhausted` | `mcp-plan-required` |
|---|---|---|
| 文案 | `chat.quota.mcp.quotaExhausted`（点名 server，说明明天恢复） | `chat.quota.mcp.codingPlanRequired`（点名 server，说明需要 Coding Plan） |
| 动作 | 无（等自然日重置） | 复用 banner 现有 `onUpgrade`（Coding Plan 升级 / 购买对话框） |
| 可关闭 | 是 | 是 |
| 阻断输入 | 否 | 否 |
| 优先级 | 6 | 8，均低于所有模型额度 kind |
| 去重键 | `kind` + `serverName` + `rowId` | 同左 |

两条硬要求：

- **优先级低于模型额度 kind**：模型额度耗尽直接影响对话本身，不能被 MCP 提示挡住；
- **文案走 i18n 而不是服务端 message**。这与 `provider-limited` 不同：后者的 message 是中文业务
  文案，可以直接展示；官方 MCP 的 message 是英文（`daily quota exceeded for bucket ...`），
  直接展示在中文界面上不可接受。服务端 message 只进日志。

去重键带 `rowId` 的效果：关闭一次提示后同一次调用不再弹，之后再有新的失败调用会重新弹；
换一个 MCP server 也会重新弹。

i18n key 已补 en-US / zh-CN 双份。

## 8. 测试

服务端：`toolerror_test.go` 已覆盖 code 映射与 `internal_error` 掩码。客户端：

- shared：`packages/shared/test/officialMcpToolError.test.ts` —— 正常解析、可选字段缺省、
  `internal_error` 与未知 code 不识别、非 JSON 文本不做文案兜底；
- core：`apps/zcode-cli/packages/core/tests/tool-result-display.test.ts` —— 两种 code 的产出并过
  strict schema、**非官方来源必须忽略**、未知 code / 非 JSON / 成功结果都不产出标识；
- ui：`packages/ui/test/v4SessionQuotaBannerState.test.ts` —— 按 code 分流、不阻断输入、
  模型额度 kind 优先级更高、dismiss key 跟随 server 与 rowId、`resolveMcpUnavailableNotice`
  取最新一条。

## 9. 验收

1. 服务端：`go test ./internal/domain/servermcp/... ./internal/interfaces/web/controller/...`；
2. 客户端：`pnpm typecheck`（改了两个 strict schema，注意跨包编译）+ `pnpm lint` + 上述 vitest；
3. **配额**：把某个桶的每日额度配小（`internal/config` 的 mcp quota 配置）→ 本地起服务端 →
   在 zcode 里把该桶的官方 MCP 工具调到超限 → 输入框上方出现提示并点名 server；关闭后不再重复弹；
   之后再触发一次新的失败会重新弹；
4. **权益**：让 `CheckEligibility` 失败（去掉 Coding Plan 上下文或让 verify 失败）→ 提示切换为
   "需要 Coding Plan"，并带升级入口；
5. **伪造校验**：用本地第三方 MCP（`scripts/dev-official-mcp-server.mjs` 配成非官方 auth）在结果里
   返回同样的 `{"error_code":"quota_exceeded"}`，确认 banner **不**出现。

## 10. 已知缺口与取舍

1. **`rows.window` 是窗口视图**：会话滚动很远后旧标识可能不在窗口内，banner 随之消失。
   刚发生的调用一定在窗口内，可接受；若要严格保留，需把它提升为会话级 state 而不是 row 字段。
2. **T2（退登换 API Key）未实现**。那条路径上客户端本地就判 `official_auth_plan_required`、
   请求根本不发出，服务端 code 永远到不了客户端；要覆盖它需把该分类从日志提升进 `McpServerStatus`
   并让 UI 回落到它。代价是 API Key 模式下每个新会话都会提示一次（可关闭），是否要做由产品定。
3. **MCP in-band `isError` 仍保持 row `status: "success"`**（未改现状），banner 也不接管
   composer error——两者是独立的信息通道。
4. **`internal_error` 不弹提示**。它是服务端对其它一切失败的兜底掩码，用户无法自助解决。
5. **服务端不下发 `next_refresh_at`**，所以文案只说"明天恢复"，不承诺具体时刻。精确重置日期在
   输入框浮层的 MCP 额度那一格里可看。
6. **official 标记必须全链路不丢**：Plugin 配置 → descriptor → `mcpPresentation` → display 构造点，
   任何一环丢掉，就退化为"任何 MCP 都能伪造 Coding Plan 提示"。改动这几处时需保持该不变量。
