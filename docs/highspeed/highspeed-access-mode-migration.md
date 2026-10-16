# Highspeed 迁移到 Provider 重构后的模型契约

> 状态：实施中（2026-09-14）
> 范围：把 Highspeed 加速卡的单轮推理路由从已退役的 `turnRuntimeModel` 迁移到
> `modelSelection` + `modelExecution{selectionScope:"execution"}`，并为加速请求新增
> `zhipu-account` 的 `highspeed` Access mode。
> 关联：[highspeed-card-spec.md](./highspeed-card-spec.md)、
> `docs/working-memory/provider-refactor/steps/todo-142-start-offpeak-signing-exceptions.md`

## 1. 背景与问题

Highspeed 早于 Provider 重构落地，它用 `turnRuntimeModel`（`zcodeModelRuntimeConfigSchema`）
把「本轮用哪个模型」和「用什么端点/凭据打」打成一个包随发送下发：

```ts
// 已退役契约：静态事实与动态凭据混在一个对象里
turnRuntimeModel: {
  revision: `highspeed-${cardId}`,
  model: { providerId: "highspeed", modelId: card.model },
  provider: {
    providerId: "highspeed",
    kind: "anthropic",
    baseURL: `${origin}/api/v1/highspeed/anthropic`,  // 静态事实
    apiKey: { source: "inline", value: jwt },          // 动态凭据
    headers: { Authorization: `Bearer ${jwt}`, "X-Highspeed-Card-ID": cardId },
    models: [{ modelId: card.model }],
  },
}
```

Provider 重构删除了 `zcodeModelRuntimeConfigSchema` / `zcodeModelRefSchema` /
`zcodeModelProviderInputSchema` 整族契约，取而代之的规则是**静态/动态分离**：

- 端点、API 形态、模型能力等**静态事实**只能来自 ZCode Built-in Provider Config；
- 只有**单次执行的动态鉴权材料**（`apiKey` / `headers`）随发送下发。

同时官方版本请求安全校验的豁免判定从「endpoint 路径白名单」收敛到共享 Adapter 按
Access mode 判定，Todo142 明确禁止按 Provider ID、模型名、Key 内容或 endpoint 路径判定例外。
Highspeed 原来依赖的 endpoint 路径白名单豁免已随重构一并删除。

## 2. 迁移决策

Highspeed 与 Off-Peak 是**同一类问题**：单轮、非持久、动态凭据、隐藏 Provider、
共享 `zcode.z.ai` 网关且免于官方版本的请求安全校验。Off-Peak 已在重构中完成迁移，因此
Highspeed 直接复用同一套机制，不新建平行管道。

| 关注点                   | 旧 Highspeed                           | 迁移后（对齐 Off-Peak）                       |
| ------------------------ | -------------------------------------- | --------------------------------------------- |
| 端点/API 形态            | `turnRuntimeModel.provider.baseURL`    | Built-in Provider Config 的 `api.baseUrl`     |
| 模型                     | `turnRuntimeModel.model`               | `modelSelection{providerId, modelId}`         |
| 凭据                     | `provider.apiKey` + `provider.headers` | `modelExecution.requestAuth{apiKey, headers}` |
| 非持久语义               | 安装 turn overlay，轮末还原            | `modelExecution.selectionScope = "execution"` |
| 安全校验豁免（官方版本） | endpoint 路径白名单                    | 按 `access.mode` 判定                         |

`selectionScope: "execution"` 的语义严格强于旧 overlay：它根本不写入 session 常驻选择，
因此不存在「安装/还原成对」的时序，也不需要幂等清理。旧的
`applyTurnRuntimeModelForPrompt` / `host.applyTurnRuntimeModel` /
`host.clearTurnRuntimeModel` 一并退役。

## 3. 契约变更

### 3.1 新增 Access mode

`zcodeProviderAccountAccessSchema.mode` 增加 `"highspeed"`：

```ts
mode: z.enum([
  "start-plan",
  "individual-coding-plan",
  "team-coding-plan",
  "off-peak",
  "highspeed",
]),
```

> 命名边界：这里的 `highspeed` 指**加速卡**这一账号访问类别，与模型名
> `GLM-5.1-Highspeed`（一个普通快速模型变体）和 E2E 夹具里的
> `e2e-glmhighspeed` 无关，仅字面重合。

### 3.2 新增 Built-in Provider（静态事实）

`config/provider/zcode-builtin.json` 的 `providerConfigRules.providerRules` 按 Off-Peak
同构新增两个隐藏 Provider。Access 的 `accountType` 是必填枚举，且加速卡是对当前账号
Coding Plan 权益的抽取，因此**必须按账号 Family 拆分**，不跨 Family 静默迁移：

| providerId                        | accountType | baseUrl                                         |
| --------------------------------- | ----------- | ----------------------------------------------- |
| `account:zai-highspeed-card`      | `zai`       | `https://zcode.z.ai/api/v1/highspeed/anthropic` |
| `account:bigmodel-highspeed-card` | `bigmodel`  | 同上                                            |

两者均为 `visibility: "hidden"`、`api.type: "anthropic-messages"`，`builtinModelIds`
与同 Family 的 Coding Plan Provider 保持一致——加速卡回显用户当前选择的模型
（`card.model` 即请求时提交的 model），加速来自换端点而非换模型。

**站点能力规则必须同步新增。** `modelConfigRules.providerSiteRules` 按 `baseUrl` 匹配，
新端点没有规则就会静默落回 `modelRules` 的保守默认值。加速端点必须与 Coding Plan
站点（`api.z.ai` / `open.bigmodel.cn` / `zcode-plan`）逐项对齐，因此新增两条规则：

| 匹配                                                | 属性                                                                     | 与哪个站点对齐                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `https://zcode\.z\.ai/api/v1/highspeed/anthropic/?` | `inputFormat.supportsImage/supportsVideo = true`                         | 同 `zcode-plan`                                                  |
| 同上 + `apiTypeMatch: anthropic-messages`           | `supportsMidConversationSystem = true`、`supportsNativeWebSearch = true` | 同 `zcode-plan`，**不同于 `off-peak`**（Todo140 只关闭闲时搜索） |

理由是能力事实必须在同一会话内稳定，而不是随本轮是否加速抖动：

- `supportsMidConversationSystem` 决定 system 块能否留在对话中段。同一 transcript 里
  普通轮为 `true`、加速轮为 `false` 会让同一段历史被两种方式改写。全部 Zhipu 站点
  （含 `off-peak`）都是 `true`，此处没有歧义。
- `supportsNativeWebSearch` 决定 `shouldExposeWebSearch` 是否把 WebSearch 暴露给模型
  （`apps/zcode-cli/packages/core/src/runtime/methods/config.ts`，读的是**本轮 Active Model**）。
  取 `false` 会让加速轮的工具集少一个工具，等于把「只改变速度」变成「顺带改变工具集」。
- `inputFormat` 决定附件能否进入本轮。会话普通轮支持图片而加速轮不支持时，已经写好的
  图片输入会在发送瞬间失去合法性。

**迁移前的旧行为与此不同**：`buildHighspeedTurnRuntimeModel` 自己拼 `baseURL`，配置里
根本没有这个站点，于是加速轮拿到的是 `modelRules` 默认值（MCS、搜索、图片全 `false`）。
那不是设计结论，只是没有站点规则的副作用。若后端确认加速端点确实不透传 native
web search，只需把这一条属性改 `false`，不影响其余迁移面。

**测试环境发布包必须同步派生。** 生产文件 `config/provider/zcode-builtin.json` 是唯一编辑源，
`config/provider/zcode-builtin.test.json` 由 `pnpm provider:config:sync-test` 机械派生
（`ZCODE_ENV` 选择实际加载哪个）。派生脚本按端点白名单改写 `zhipu-account` 的 `baseUrl`
并复制站点规则，因此新增加速端点必须同时登记测试孪生端点，否则 `pnpm provider:config:check-test`
直接抛 `Unknown account Provider endpoint`，加速卡在测试环境也拿不到 Provider：

| 位置                                                                            | 内容                                                                                                                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/sync-test-builtin-provider-config.mjs` 的 `accountEndpoints`           | `https://zcode.z.ai/api/v1/highspeed/anthropic` → `https://zcode.z.ai/api/v1/highspeed/anthropic`                                          |
| `scripts/test/sync-test-builtin-provider-config.test.mjs` 的 `pairs` 与数量断言 | 该测试独立维护一份端点表，用于校验脚本的白名单没被改错；新增内置账号 Provider 后 `providerRules` 数量与派生站点规则副本数（当前 10 / 9）要一起更新 |

### 3.3 单轮执行材料

`HighspeedPrepareTurnResult` 的 `accelerated` 分支不再返回 `turnRuntimeModel`，改为
返回可直接投影到协议的执行材料：

```ts
| {
    kind: "accelerated";
    card: HighspeedCardSnapshot;
    nextDrawAt: number;
    /** Mock 只保留加速业务语义；省略该字段即继续走 session 普通推理路由。 */
    execution?: {
      modelSelection: ModelSelection;
      requestAuth: { apiKey: string; headers: Record<string, string> };
    };
  }
```

发送时按已有协议字段提交，不新增协议字段：

```ts
sendText({
  modelSelection: execution.modelSelection,
  modelExecution: {
    selectionScope: "execution",
    requestAuth: execution.requestAuth,
  },
  highspeedMeta, // 卡快照仍随输入事实进入 message.data，不含凭据
});
```

`highspeedMeta` 的语义不变：它是**投影用的卡快照**，不含凭据与 header，可持久化；
凭据只在 `modelExecution.requestAuth` 里，仅 idle `startNow` 接受，不进普通
`CommandInbox`，因此队列持久化面不变——这与旧规则「队列只持久化不含凭据的卡元数据」一致。

### 3.4 安全校验豁免

官方版本的请求安全校验按 `access.mode` 判定豁免：`highspeed` 与 `start-plan`、`off-peak`
同属免校验的账号模式。不恢复 endpoint 路径白名单——Todo142 禁止按 endpoint 路径判定例外。
具体实现只存在于官方版本，不在本文展开。

### 3.5 声明式单轮退回：`modelExecution.selectionFallback`

**这是本次迁移在 staging 契约上新增的字段**（`packages/shared/src/model-execution.ts`）。
旧实现靠 overlay 还原接口把卡过期后的剩余请求切回原模型；`selectionScope: "execution"`
既然从不改写 Session Selection，就没有「还原」这一步，必须由发起方**声明**什么错误算
「本轮执行凭据失效」：

```ts
selectionFallback: {
  providerId: string,
  // 按声明顺序匹配，首个命中的规则决定退回原因；providerErrorCode 缺省表示该 provider 的任何失败
  rules: Array<{
    reason: "highspeed_card_expired" | "highspeed_request_failed",
    providerErrorCode?: string,
  }>,
  // 退回目标：发起方抽卡时的提交选择（会话原模型 + 档位）。缺省才退回 runtime 会话常驻选择。
  target?: ModelSelection,
}
```

加速卡声明 `[{ reason: "highspeed_card_expired", providerErrorCode: "3402" }, { reason: "highspeed_request_failed" }]`：
卡过期按原因区分提示，其余任何失败（鉴权、限流、5xx、网络、超时、流中断）同样退回。

CLI 侧只做纯匹配（`turn-execution-fallback.ts`，由 `turn-model-step.ts` 调用）：本轮 execution
Selection 的 `providerId` 命中声明值，且失败归因未指向其他 provider 时，按规则顺序取首个命中项退回一次。
**不按 provider id 前缀、模型名或错误文案硬编码**，这是 Todo142 的同一条纪律。退回原因由命中的规则
给出，CLI 不自行解释错误码。

退回目标先取声明的 `target`，再取 runtime 会话常驻 Session Selection。execution 作用域从不改写
Session Selection，正常情况下两者相同；但会话常驻选择只存在于 runtime 内存，冷恢复落在 Registry
刚就绪、账号权益未解析的窗口时它会校验失败而不绑定，之后只发加速轮也不会再绑定（见下方回归约束），
所以发起方必须把抽卡时的提交选择作为 `target` 随声明下发。退回请求不再携带本次执行的
`requestDependencies`，即走用户自己的常规鉴权。

边界必须保持：

- **只退一次**：退回后清空 `state.selectionFallback`；普通模型若再失败，整轮按真实错误失败。
- **无处可退时必须失败**：声明的 `target` 与会话常驻 `modelSelection` 都缺失或都不可解析时，
  本轮按真实错误失败。旧实现里 `if (fallbackModel)` 恒真，把这个分支掩埋成了别的错误；
  现在按候选顺序尝试建模，候选不可解析（Registry 中不存在）只跳过不中断，全部落空时记录
  `model.execution_selection.fallback_unavailable` 的 `warn` 并返回原错误。
- **回归约束（2026-10-09 日志复盘）**：退回目标曾只依赖 runtime 会话常驻选择。桌面重启后冷恢复
  在 Provider Registry ready 后 600ms 内完成，此时账号 provider 仍 `entitled:false`、未发布模型，
  持久化选择校验 `provider-not-found` 而不绑定；之后两轮全是加速轮，runtime 一直无常驻选择，
  3402 时降级静默跳过、整轮失败。`target` 由发起方声明后不再依赖这段时序。
- **不降级的失败**：用户取消与上下文超窗不匹配任何规则；超窗继续交给 reactive compact。事件持久化、
  投影等无 provider/network 归因的本地 runtime 失败也不得被兜底规则误判成加速请求失败。
- **退回优先于同模型 stream recovery**：失败处理顺序为 声明式退回 → stream recovery →
  Start Plan admission 重试 → 超窗 compact → 整轮失败。若失败命中退回声明但所有退回目标都不可解析，
  必须直接按真实错误失败，不能继续在加速模型上做 stream recovery。若退回排在 recovery 之后，流中断会先在
  加速模型上重试到预算耗尽。`TurnExecutionModelFallback` 到达投影时必须先把被废弃的 text/reasoning
  流标记为 `interrupted`，并将尚未定稿的 `inputStreaming` 工具行标记为 `cancelled`；原模型后续输出
  必须打开新行，不能与加速输出拼接，也不能把废弃输出误标为完成。
- **执行句柄 0 次重试**：带 `selectionFallback` 且 Selection 指向声明 provider 的执行作用域模型句柄
  绑定 `ModelRetryBudget.SingleAttempt`（`createTurnModel(..., { retryBudget })`），适配层把该请求的
  `maxAttempts` 收敛为 1；退回后的会话模型句柄沿用 taskType 默认预算。

### 3.6 协议校验：`modelExecution` 不得独立出现

`modelExecution` 只描述「怎么打」，Selection 才是「打谁」。二者分离后必须在协议层
保证不会出现「带凭据但没有选型」的请求，否则执行期会拿加速卡凭据去打会话默认 Provider。
`packages/shared/src/zcode-protocol-v4/command.ts` 的三条命令各加一条 superRefine：

| 命令            | 迁移前 | 迁移后                                            |
| --------------- | ------ | ------------------------------------------------- |
| `sendText`      | 已有   | 保持                                              |
| `editUserQuery` | 无     | **新增** `modelExecution requires modelSelection` |
| `sendQueuedNow` | 无     | **新增** 同上                                     |

`editUserQuery` / `sendQueuedNow` 是 Highspeed 唯二能重新发起加速轮的入口，
迁移前它们靠 `turnRuntimeModel` 自带模型所以无需校验。

### 3.7 Access 解析：加速卡不是独立套餐

`off-peak` 与 `highspeed` 都不是独立套餐，而是「已连接的个人/团队 Coding Plan」派生出的
执行入口：请求期鉴权分别来自 ticket 与加速卡 JWT，本身没有可校验的套餐 Key。
`accountProviderConnectionResolver.ts` 把 staging 里三处 `mode === "off-peak"` 字面判断
抽成 `isCodingPlanDerivedMode(mode)`，同时覆盖两种派生模式：

1. Coding Plan availability 校验的候选集合（派生模式不算已配置套餐）；
2. availability 投影（派生 Provider 的可用性跟随当前 Coding Plan 选择）；
3. `resolveCurrentAccountAccess`：派生模式只要求当前选择是 individual/team Coding Plan，
   不按 `selection.kind === mode` 直接比对。

因此加速卡 Provider 的静态 `access.mode = "highspeed"` 会被解析成用户**当前**的
individual/team Coding Plan 访问事实，账号切换后不会冻结旧权益。

### 3.8 节省时间统计：`CodingPlanRegularTpsRequest.accountAccess`

`packages/shared/src/usage-stats.ts` 的 `CodingPlanRegularTpsRequest` 从
`organizationId` / `projectId` 改为必填 `accountAccess`：

```ts
accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
```

Bug 原因：此前该请求只带 org/project，请求期鉴权靠 host 自行按 provider 猜账号。
Provider 重构后 Coding Plan 授权统一由 `accountAccess` 解析（Team scope 已内含其中），
缺失时 `resolveAuthorization` 必定返回 `null`，「节省时间」会静默不展示。
缓存键随之改为整个 access 对象，而不再是 org/project 二元组。

### 3.9 事件载荷：`TurnExecutionModelFallbackPayload` 字段改名

`ModelRef` 已随重构删除，退回事件的两个字段同步改名（`contracts/src/events/session.events.ts`）：

| 迁移前                   | 迁移后                               |
| ------------------------ | ------------------------------------ |
| `fromModelRef: ModelRef` | `fromModelSelection: ModelSelection` |
| `toModelRef: ModelRef`   | `toModelSelection: ModelSelection`   |

这是**持久化事件载荷的形状变更**，但该事件是 Highspeed 独有且只在卡过期时产生，
没有跨版本兼容面：迁移前的 highspeed 分支从未发布。

### 3.10 Renderer 发送路径

`packages/ui/src/v4/SessionPane.tsx` 的 `dispatchCommand` 在第 6 个参数
`telemetrySeed` 之后插入第 7 个位参 `highspeedCard`，staging 原来的第 7 位
`onEnvelopeCreated` 顺延到第 8 位。全部调用点已核对，没有把回调误传成卡快照的站点。

草稿会话首发不能再复用 `createSession.firstInput`：抽卡必须拿到真实 `sessionId`
（用于 in-flight draw 归属与卡复用），因此首发统一走 `createSession` + 独立 `sendText`。
**代价：无附件首发也多一次往返。** 这是为了让抽卡与发送共享同一个会话身份，
避免 firstInput 路径上出现「卡已抽出但会话 id 未知」的悬挂状态。

## 4. 时序（迁移后）

```text
Renderer                       Highspeed service            CLI admission            Adapter
   | prepare(task, model)              |                          |                     |
   |---------------------------------->| draw / reuse card        |                     |
   |                                   |                          |                     |
   |<-- accelerated{card, execution} --|                          |                     |
   |                                                              |                     |
   | sendText{modelSelection, modelExecution{execution, auth},     |                     |
   |          highspeedMeta}                                       |                     |
   |-------------------------------------------------------------->|                     |
   |                                          selectionScope=execution                   |
   |                                          => 不写 session 常驻选择                    |
   |                                          => 无需安装/还原 overlay                    |
   |                                                              |                     |
   |                                          resolve provider by providerId             |
   |                                          (Built-in Config: baseUrl/api/models)      |
   |                                                              |-------------------->|
   |                                                              |  access.mode=highspeed
   |                                                              |  => 免官方版本安全校验
   |                                                              |  => 直接带 requestAuth 发请求
```

## 5. 不变的语义

以下既有规则不受本次迁移影响，实现时必须保持：

- Automation 派发轮（本轮存在 `automationId`）不参与抽卡；即使错误地收到执行材料，
  CLI 也必须忽略并继续隐藏 Automation 写工具。
- 1 秒 fallback、`next_draw_at` 冷却权威、单 in-flight draw、外来卡静默普通发送。
- 卡在 Turn 中过期（`HTTP 400 / provider_code=3402`）时保留上下文，剩余模型请求切回
  发送前的原始 session 模型，并只提示一次。原始模型仍须从当前有效的 workspace model
  catalog 解析。
- 运行态以 Core `activeTurn` 为最终事实；携带执行材料不改变 `queue` 准入语义。
- Mock 抽中仍只回 `accelerated` 业务状态、不带 `execution`，消息流继续走 session
  普通 provider/model 与原推理接口。

## 6. 已知遗留偏差

以下两项在本次迁移中被发现，但**属于 staging 自身的既有债务**，不在本次迁移范围内修复，
记录在此以免后续被误当成迁移引入：

### 6.1 `v4-native-boundary` 无桥禁令已红

`v4-native-boundary.test.ts` 断言 `zcode-protocol-v4/` 下任何文件不得 import
`zcode-protocol/`。staging 自身已有 3 处违反（`session-flow.ts`、`goal-compact.ts`、
`prompt-turn.ts`）。本次迁移让 `fork-edit-retry.ts` 与 `queue.ts` 也从
`../../../zcode-protocol/model-execution.js` 取 `createModelExecutionContext`，
违规清单增加 2 行。

选择与 staging 保持同一 import 写法（`session-flow.ts` 取的就是同一个符号、同一个路径），
不为加速路径单独造 shim；正解是把 `model-execution.ts` 搬进 v4 树并一次性修掉 5 处，
这属于 staging 的 M4 收尾工作。

### 6.2 CLI 测试文件不参与 typecheck

`apps/zcode-cli/packages/bootstrap/tsconfig.json` 的 `include` 只有 `src/**/*`，
测试文件不进 `tsc --noEmit`。后果已经实际发生过：`transcript-hydration.test.ts` 里
Highspeed 相关夹具在 Provider 重构后仍使用已删除的 `providerID` / `modelID` 键名，
所有 selection 静默变成 `undefined`，「加速轮不参与普通模型切换基线」这条断言长期**假通过**
（0 个 marker 对 0 个 marker）。修键名后该测试才真正生效。

## 7. 验证

- `pnpm typecheck`、`pnpm lint`
- shared：`zcodeProtocolV4Command.test.ts`
- services：`highspeedCardService.test.ts`
- provider-node：`builtin-provider-build.test.ts`（含 `sync-test` 契约：生产文件与派生测试发布包一致）
- ui：`highspeed/highspeedSend.test.ts`
- CLI bootstrap：`v4-native-commands.test.ts`、`v4-native-queue.test.ts`、
  `v4-native-fork-edit-retry.test.ts`、`automation-port.test.ts`、
  `transcript-hydration.test.ts`、`session-persistence.test.ts`
- e2e：`conversation-session-highspeed-card.test.ts`
