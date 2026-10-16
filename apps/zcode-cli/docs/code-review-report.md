# zcode-cli 端到端深度 Code Review 报告

> 审查范围: `/apps/zcode-cli/packages` 下全部 15 个子包
> 审查日期: 2026-06-04
> 代码规模: ~96K 行源码 + ~49K 行测试

---

## 1. 总体架构评估

### 1.1 当前架构风格判断

项目采用**分层 Monorepo + Port/Adapter** 架构，意图实现：

```
cli (入口) → bootstrap (编排) → core (业务) → contracts (契约)
                                        ↕
                                    adapters (基础设施)
```

包依赖关系（实际）：

```
contracts ← core ← bootstrap ← cli
              ↑        ↑         ↑
           shared-types  adapters ← bootstrap
              ↑
           tui ← cli
           i18n ← bootstrap, cli, tui
```

**有 DDD 倾向**：contracts 包定义了 Port 接口，core 依赖接口而非实现，adapters 提供具体实现。但**实际落地严重偏离了这一意图**，core 内部存在大量结构性问题。

### 1.2 主要结构性问题 Top 5（按严重程度排序）

| # | 问题 | 严重程度 | 影响 |
|---|------|----------|------|
| 1 | **AgentRuntime God Object**: 1 个类承载 90+ 方法、40+ 状态字段，通过 prototype 猴子补丁安装 | P0 | 任何修改都有连锁风险，无法独立测试 |
| 2 | **Mixin via `this: AgentRuntimeInternal` 模式**: 30+ 方法文件全部绑定到同一巨大接口，形成"假拆分" | P0 | 拆了文件但没拆职责，所有方法共享全部状态 |
| 3 | **contracts 与 core 类型定义重复**: `PermissionDecisionResult`、`ToolScheduleItem` 等在两处各定义一份，字段不一致 | P0 | 运行时类型不匹配的隐患 |
| 4 | **deps.ts 集中重导出**: 209 行的重导出文件，让每个 methods 文件都能访问任何依赖 | P1 | 隐式耦合，无法看出真实依赖边界 |
| 5 | **shared-types 包几乎空壳**: 仅 35 行，4 个类型，与 contracts 职责重叠 | P2 | 认知负担，新开发者不知该放哪个 |

### 1.3 建议的目标架构方向

保持 Port/Adapter 思想，但需要严格执行：

1. **core 内部拆分为独立子模块**：agent-loop、compact、tool-execution、session-lifecycle 各自拥有独立状态和接口
2. **消除 God Object**：AgentRuntime 拆为多个协作服务，通过显式接口交互
3. **contracts 成为唯一类型权威**：删除 core/runtime/types.ts 中的重复定义，所有运行时类型归入 contracts
4. **deps.ts 按子模块拆分**：每个子模块只导入自己需要的 Port

---

## 2. 模块级 Review

### 2.1 @zcode/core（36K 行源码）

#### 2.1.1 模块定位

- **应该承担的职责**: Agent 循环编排、工具调度、上下文构建、compact 策略、权限决策
- **当前实际职责**: 上述全部 + 会话持久化 + 事件归约 + 消息序列化 + MCP 管理 + 内存管理 + 工作流调度 + 子 agent 编排 + 重试策略 + 诊断日志
- **偏差与后果**: core 包成了"什么都做"的万能层，任何需求都在此添加方法，导致单点修改风险极高

#### 2.1.2 依赖关系与调用链

- 依赖: `@zcode/contracts`, `@zcode/shared-types`, `cheerio`, `diff`
- 被依赖: `@zcode/bootstrap`, `@zcode/tui`, `@zcode/cli`
- **不合理依赖**: core 直接 `import cheerio` 做 HTML 解析（webfetch handler），这是基础设施关注点，应下沉到 adapters

#### 2.1.3 问题清单

##### P0-1: AgentRuntime God Object — 1 类 90+ 方法

- **证据**: `agent-runtime.ts` 定义了 40+ 私有字段的类，`internal.ts` 定义了 40+ 字段的接口，`internal-methods.ts` + `internal-turn-methods.ts` 合计定义 90+ 方法，`methods/index.ts` 通过 `proto.xxx = xxx` 安装全部方法
- **风险**: 任何方法修改都可能影响共享状态；无法独立实例化子模块做测试；新功能只能继续加方法
- **建议**: 拆分为 `TurnOrchestrator`、`CompactManager`、`PersistenceService`、`ToolDispatcher`、`ContextManager` 等独立服务

##### P0-2: Mixin via `this: AgentRuntimeInternal` — 假拆分

- **证据**: 所有 `methods/*.ts` 文件中的函数签名都是 `export function xxx(this: AgentRuntimeInternal, ...)` ，通过 `installAgentRuntimeMethods` 注入到 prototype。30+ 个文件看似独立，实际共享同一份状态
- **风险**: 文件拆分给人"已解耦"的错觉，实际耦合度与单体无差异；方法间隐式依赖共享字段
- **建议**: 将每组方法封装为独立类/模块，接收显式依赖注入

##### P0-3: 重复类型定义 — `PermissionDecisionResult` 等

- **证据**:
  - `runtime/types.ts:266` 定义 `interface PermissionDecisionResult { allowed, reason, modifiedInput, permissionUpdates }`
  - `permission/service.ts:37` 定义 `interface PermissionDecisionResult { decision, allowed, reason, modifiedInput, escalated, mode, ruleId, riskLevel, sideEffectScope }`
  - 两处字段完全不同！`runtime/types.ts` 的版本只有 4 个字段，`permission/service.ts` 的版本有 9 个字段
  - 同理 `ToolScheduleItem` 在 `agent/turn-state.ts:126` 和 `tool/scheduler.ts:18` 各有一份，字段不同（前者无 toolName，后者有）
- **风险**: 运行时可能因类型不匹配导致静默数据丢失
- **建议**: 统一到 `@zcode/contracts`，删除 core 内重复定义

##### P1-1: `deps.ts` 集中重导出 — 隐式耦合

- **证据**: `runtime/deps.ts` 有 209 行，从 `@zcode/contracts` 重导出 50+ 个值和 80+ 个类型，以及从自身其他模块重导出
- **风险**: 每个 methods 文件 `import { ... } from "../deps.js"` 时看不到真实来源，也不知道自己到底依赖了什么
- **建议**: 每个子模块直接从 contracts 导入自己需要的类型，删除全局 deps.ts

##### P1-2: `modelAdapter?: any` — 逃避免型系统

- **证据**: `agent-runtime.ts:120` 声明 `private modelAdapter?: any; // AiSdkModelAdapter - avoid circular dep`
- **风险**: 丧失类型安全，编译器无法检查调用是否正确
- **建议**: 在 contracts 中定义 `ModelPort` 接口（已存在但未使用），用 `ModelPort` 替代 `any`

##### P1-3: context-usage 方法不应该是 AgentRuntime 的方法

- **证据**: `context-usage.ts` 中 `estimatedMetric`、`estimatedMetricFromKnown`、`sumMetrics` 都是纯计算函数，通过 `this: AgentRuntimeInternal` 绑定，但实际不使用任何实例状态
- **风险**: 虚假耦合，无法独立测试，增加 God Object 体积
- **建议**: 提取为独立模块 `@zcode/core/src/context/usage-metrics.ts`，作为纯函数导出

##### P1-4: workflow 模块在 core 中职责过重

- **证据**: `workflow/` 目录下有 `lifecycle.ts`(590行)、`expert/`(10+文件)、`scheduler/`(8+文件)，合计约 5000 行代码
- **风险**: workflow 本身是一个独立子系统，不应嵌入 core
- **建议**: 考虑拆为 `@zcode/workflow` 独立包，通过 Port 与 core 交互

##### P2-1: 文件超出 400 行限制

- **证据**: 以下文件超过项目 AGENTS.md 规定的 400 行上限：
  - `workflow/lifecycle.ts`: 590 行
  - `subagent/runner.ts`: 557 行
  - `permission/service.ts`: 453 行
  - `runtime/types.ts`: 431 行
  - `runtime/helpers/model-errors.ts`: 422 行
  - `runtime/helpers/turn-errors.ts`: 408 行
  - `agent/session-history-hydrator.ts`: 403 行
  - 所有 runtime/methods/*.ts 文件（23 个）平均 300 行，但多个接近 400
- **建议**: 按项目规范拆分

#### 2.1.4 重构建议

**Phase 1 — 提取纯计算模块（可立即执行）**

```
core/src/context/
  usage-metrics.ts     ← 从 runtime/methods/context-usage.ts 提取 estimatedMetric/sumMetrics
  token-estimator.ts   ← 从 compact/index.ts 提取 estimateTokens/estimateMessageTokens
```

**Phase 2 — 拆分 AgentRuntime 为协作服务**

```typescript
// 目标结构（示意）
class TurnOrchestrator {
  constructor(
    private contextManager: ContextManager,
    private toolDispatcher: ToolDispatcher,
    private compactManager: CompactManager,
    private persistence: PersistenceService,
  ) {}
}

class CompactManager {
  constructor(
    private messageHistory: MessageHistory,
    private modelPort: ModelPort,
    private persistence: PersistenceService,
  ) {}
  // autoCompactIfNeeded, compactActiveConversation, etc.
}

class PersistenceService {
  constructor(
    private sessionStore: SessionStorePort,
    private eventStore: SessionEventStorePort,
  ) {}
  // persistUserPrompt, persistAssistantMessage, etc.
}
```

**Phase 3 — 迁移方法到对应服务**

每个现有 `methods/*.ts` 中的函数迁移到对应服务的同名方法，保持函数签名不变（仅移除 `this: AgentRuntimeInternal`，替换为显式依赖参数）。

---

### 2.2 @zcode/contracts（11K 行源码）

#### 2.2.1 模块定位

- **应该承担的职责**: 定义所有跨包共享的接口契约、Port 定义、事件 schema、工具 schema
- **当前实际职责**: 上述 + workflow 脚本 DSL + goal 格式化函数 + compact 边界解析函数 + 模型 catalog 常量
- **偏差与后果**: contracts 包含了业务逻辑函数（如 `formatGoalCompletionVerificationPrompt`、`formatTodoStateForModel`），违反了"契约层无逻辑"原则

#### 2.2.2 依赖关系与调用链

- 依赖: `zod`, `zod-to-json-schema`
- 被依赖: 几乎所有其他包
- **合理**: 无循环依赖，依赖方向正确

#### 2.2.3 问题清单

##### P0-4: contracts 包含业务逻辑函数

- **证据**:
  - `contracts/src/memory/index.ts` 导出 `formatGoalCompletionVerificationPrompt`、`formatGoalCompletionVerificationFailurePrompt`、`escapeGoalPromptText` 等格式化函数
  - `contracts/src/compact/index.ts` 包含 `getAutoCompactThreshold`、`shouldAutoCompact` 等策略函数
  - `contracts/src/rewind/index.ts` 包含 `evaluateRewindTarget` 等决策函数
- **风险**: contracts 修改可能影响所有下游；业务逻辑混入契约层增加理解成本
- **建议**: 将策略/格式化函数移入 core 对应模块，contracts 只保留纯类型和 schema

##### P1-5: contracts 包体积过大（11K 行）

- **证据**: 60+ 个源文件，包括完整的 tool schema 定义、workflow script DSL、model catalog 等
- **风险**: 编译变慢；改动 tool schema 会导致 contracts 整体重编译
- **建议**: 将 `tools/` 目录拆为 `@zcode/tool-schemas` 独立包，或使用 sub-path exports 已有的 `@zcode/contracts/tools` 做逻辑隔离

##### P2-2: session-store.port.ts 750 行

- **证据**: 单文件定义了全部会话存储接口，包括 message、session、todo、checkpoint、usage 等
- **风险**: 不符合 400 行规范；修改任一子接口影响整体
- **建议**: 按领域拆为 `message-store.port.ts`、`session-meta.port.ts`、`todo-store.port.ts` 等

#### 2.2.4 重构建议

```typescript
// contracts 应保留
export interface SessionStorePort { ... }       // Port 接口
export const WebFetchInputSchema = z.object()  // Zod schema
export type WebFetchInput = z.infer<>          // 派生类型

// contracts 应移出
export function formatGoalCompletionVerificationPrompt()  // → core/context/
export function shouldAutoCompact()                        // → core/compact/policy.ts
export function evaluateRewindTarget()                     // → core/runtime/helpers/rewind.ts
```

---

### 2.3 @zcode/adapters（23K 行源码）

#### 2.3.1 模块定位

- **应该承担的职责**: 为 contracts 中定义的 Port 提供具体实现
- **当前实际职责**: Port 实现 + 模型 catalog 管理 + 模型运行器（含重试、流式、诊断等） + 认证 OAuth + MCP 连接 + 配置合并 + 插件加载
- **偏差与后果**: model 子目录（30+ 文件，约 8K 行）承载了过多运行时逻辑

#### 2.3.2 依赖关系与调用链

- 依赖: `@zcode/contracts`, `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `cheerio`, `jimp`, `proxy-agent`, `ripgrep`, `zod`
- 被依赖: `@zcode/bootstrap`, `@zcode/cli`
- **不合理**: adapters 直接依赖 `cheerio`（webfetch HTML 解析）和 `jimp`（图片处理），这些是 core 中的工具 handler 通过 Port 调用的，但当前 core 直接 import cheerio

#### 2.3.3 问题清单

##### P1-6: model/runner 拆分过度 — 30 个文件但高度耦合

- **证据**: `model/` 下有 `runner.ts`、`runner-generate.ts`、`runner-stream.ts`、`runner-retry.ts`、`runner-runtime.ts`、`runner-status.ts`、`runner-debug.ts`、`runner-diagnostics.ts`、`runner-normalization.ts`、`runner-options.ts`、`runner-record.ts` 等 12 个 runner-* 文件
- **风险**: 拆分粒度过细导致跨文件追踪逻辑困难；runner.ts 仅 200 行但 orchestrate 其他 11 个文件
- **建议**: 合并为 3-4 个内聚模块：`runner-core.ts`（主循环）、`runner-stream.ts`（流式处理）、`runner-retry.ts`（重试策略）、`runner-normalization.ts`（输入输出归一化）

##### P1-7: 认证逻辑散落

- **证据**: `auth/` 下有 8 个文件：`bigmodel-oauth.ts`、`browser.ts`、`cli-oauth.ts`、`coding-plan-api-key.ts`、`credential-cipher.ts`、`localhost-callback.ts`、`shared-credentials.ts`、`index.ts`
- **风险**: 每种认证方式独立实现，无统一抽象
- **建议**: 定义 `AuthProvider` 接口，各实现遵循统一契约

##### P2-3: storage/session-store 文件层级过深

- **证据**: `storage/session-store/repositories/` 下 9 个文件，加上 codecs、migration 等，共 20+ 文件
- **风险**: 简单的 SQLite 存储拆得过于碎片化
- **建议**: 按聚合根合并，如 `message-repository.ts` + `session-repository.ts` + `migration.ts`

---

### 2.4 @zcode/bootstrap（11K 行源码）

#### 2.4.1 模块定位

- **应该承担的职责**: 组装 core + adapters，提供应用级 API，编排启动流程
- **当前实际职责**: 上述 + ZCode Protocol server + 自定义命令系统 + 工作流脚本运行器 + 模型选择 + 插件管理 + 会话管理
- **偏差与后果**: script-workflow 相关代码占 11 个文件（~3000行），属于独立子系统

#### 2.4.2 问题清单

##### P1-8: script-workflow 子系统嵌入 bootstrap

- **证据**: `app/script-workflow-*.ts` 有 11 个文件
- **风险**: bootstrap 的组装职责与 workflow 运行时逻辑混在一起
- **建议**: 拆为 `@zcode/workflow-runner` 独立包

##### P1-9: zcode-protocol 子系统嵌入 bootstrap

- **证据**: `zcode-protocol/` 下 13 个文件（~4000 行），包含完整的 JSON-RPC server
- **风险**: 协议层与 bootstrap 耦合
- **建议**: 拆为 `@zcode/protocol-server` 独立包

---

### 2.5 @zcode/tui（7.3K 行源码）

#### 2.5.1 模块定位

- **应该承担的职责**: 终端 UI 渲染、用户输入处理、展示层状态
- **当前实际职责**: 上述基本合理，但 `state.ts` 承载了过多展示逻辑

#### 2.5.2 问题清单

##### P1-10: tui 依赖 @zcode/core — 跨层调用

- **证据**: `tui/package.json` 中 `"@zcode/core": "workspace:*"`
- **风险**: TUI 层不应直接依赖业务核心层，应只依赖 contracts 中的类型
- **建议**: TUI 通过 contracts 中的接口与 runtime 交互，不直接 import core 实现

##### P2-4: app-*.ts 命名混乱

- **证据**: 88 个 `app-*.ts` 文件，命名无层级
- **风险**: 难以定位特定功能的代码
- **建议**: 按功能域建子目录：`components/`、`panels/`、`keyboard/`、`state/`

---

### 2.6 @zcode/cli（6.8K 行源码）

#### 2.6.1 模块定位

- **应该承担的职责**: CLI 入口、参数解析、命令路由
- **当前实际职责**: 上述 + TUI 启动 + runtime 加载 + 命令中心 + 登录流程

#### 2.6.2 问题清单

##### P1-11: cli 包中 tui-* 文件过多

- **证据**: `cli/src/` 下有 `tui-command.ts`、`tui-command-data.ts`、`tui-command-state.ts`、`tui-login-state.ts`、`tui-prompt-handler.ts`、`tui-runtime-loader.ts`、`tui-startup-locale.ts`、`tui-stderr.ts`、`tui-submit-metadata.ts`、`tui-workflow-panel.ts`、`tui-workspace-git.ts`、`tui-workspace-paths.ts` 共 12 个 tui-* 文件
- **风险**: CLI 包承担了本应在 tui 包中的职责
- **建议**: 将 tui-* 文件移入 `@zcode/tui` 包，cli 只负责入口编排

##### P2-5: 测试文件过大

- **证据**: `cli/tests/cli.unit.test.ts` 4573 行
- **风险**: 单文件过大，测试定位困难
- **建议**: 按功能域拆分测试文件

---

### 2.7 @zcode/shared-types（35 行源码）

#### 2.7.1 问题清单

##### P1-12: shared-types 与 contracts 职责重叠

- **证据**: `shared-types/src/index.ts` 仅定义了 `JsonValue`、`RunContext`、`GlobalLocale`、`GlobalOptions`、`RuntimeInfo` 共 5 个类型。其中 `RuntimeInfo` 在 core 的 `environment.ts` 中也有 `getRuntimeInfo` 函数
- **风险**: 新开发者不知道类型该放 shared-types 还是 contracts
- **建议**: 将 shared-types 合并到 contracts 中，删除 shared-types 包

---

### 2.8 @zcode/i18n（961 行源码）

#### 2.8.1 模块定位

- 基本合理，仅提供国际化字符串

##### P2-6: 无测试覆盖

- **证据**: 仅 75 行测试
- **建议**: 补充基本测试确保 key 完整性

---

### 2.9 插件包

- `@zcode/android-emulator-plugin`、`@zcode/ios-simulator-plugin`、`@zcode/document-skills-plugin`、`@zcode/skill-creator-plugin`
- 基本合理，通过 MCP 协议接入，与主系统解耦
- **问题**: 无测试覆盖

---

## 3. Dead Code 与冗余专项

### 3.1 Dead Code 候选列表

| 候选 | 位置 | 判断依据 | 建议 |
|------|------|----------|------|
| `PermissionDecisionResult` (runtime/types.ts) | `runtime/types.ts:266` | 与 permission/service.ts 定义重复，且字段更少（4 vs 9），实际消费方使用 service.ts 版本 | 删除 runtime/types.ts 版本 |
| `ToolScheduleItem` (turn-state.ts) | `agent/turn-state.ts:126` | 与 tool/scheduler.ts 定义重复，字段更少（3 vs 8） | 删除 turn-state.ts 版本 |
| `core/src/output.ts` | `output.ts` | 仅导出 `color`, `formatJson`, `supportsColor`，这些是 CLI 层关注点 | 移到 cli 包或删除 |
| `core/src/environment.ts` | `environment.ts` | 仅导出 `getRuntimeInfo`，返回值类型与 shared-types 中的 `RuntimeInfo` 重复 | 移到 bootstrap 或删除 |
| `AgentRuntime` 声明合并中的 `PermissionDecisionResult` import | `agent-runtime.ts:79` | 从 deps 导入了 runtime/types.ts 版本，但实际应使用 permission/service.ts 版本 | 统一使用 contracts 版本 |

### 3.2 重复逻辑地图

| 重复逻辑 | 位置 A | 位置 B | 差异 | 建议保留 |
|----------|--------|--------|------|----------|
| `PermissionDecisionResult` 类型 | `runtime/types.ts` | `permission/service.ts` | 字段数不同 | 移入 contracts，统一为一个 |
| `ToolScheduleItem` 类型 | `agent/turn-state.ts` | `tool/scheduler.ts` | 字段数不同 | 移入 contracts，统一为一个 |
| `estimateTokens` | `context/index.ts` | `compact/index.ts` | 可能实现不同 | 统一到 `context/token-estimator.ts` |
| `formatLocalIsoDate` | `contracts/time/local-date.ts` | `runtime/helpers/` 使用 | 单一定义 | 保留 contracts 版本 |
| Provider business error 解析 | `runtime/helpers/model-errors.ts` (422行) | `adapters/src/model/provider-finish-business-error.ts` | 两处都在解析 provider 业务错误 | 统一到 contracts 或 core |

### 3.3 冗余模式

**模式 1: 每个 methods/*.ts 函数都是 `this: AgentRuntimeInternal` 的方法**

30+ 个函数文件全部声明 `this: AgentRuntimeInternal`，然后通过 `proto.xxx = xxx` 安装。这意味着：
- 每个函数都能访问全部 40+ 状态字段
- 每个函数都能调用全部 90+ 方法
- 实际依赖只是其中一小部分

**建议**: 将函数按真实依赖分组，封装为独立服务。

**模式 2: WebFetch handler 拆分为 8 个文件**

```
webfetch.ts → webfetch-cache.ts, webfetch-constants.ts, webfetch-content.ts,
              webfetch-errors.ts, webfetch-network.ts, webfetch-processing.ts,
              webfetch-trace.ts, webfetch-types.ts, webfetch-url.ts
```

9 个文件处理一个工具，但实际逻辑约 300 行。过度拆分增加导航成本。

**建议**: 合并为 `webfetch/` 目录下 3 个文件：`handler.ts`、`network.ts`、`types.ts`。

---

## 4. 重构路线图与优先级

### P0 — 影响正确性/稳定性/维护成本最高的（必须改）

#### P0-A: 统一重复类型定义

- **改动范围**: `core/src/runtime/types.ts`、`core/src/permission/service.ts`、`core/src/agent/turn-state.ts`、`core/src/tool/scheduler.ts`
- **迁移步骤**:
  1. 在 `@zcode/contracts` 中定义权威的 `PermissionDecisionResult`、`ToolScheduleItem`
  2. core 中所有消费方改为从 contracts 导入
  3. 删除 core 中的重复定义
- **风险**: 低 — 纯类型迁移，编译器会捕获遗漏
- **验证**: `pnpm run typecheck`
- **PR 粒度**: 1 个 PR

#### P0-B: 修复 `modelAdapter?: any` 类型逃逸

- **改动范围**: `core/src/runtime/agent-runtime.ts`、`core/src/runtime/types.ts`
- **迁移步骤**:
  1. 确认 `ModelPort` 接口（contracts 中已定义）满足 core 的全部调用需求
  2. 将 `modelAdapter?: any` 改为 `modelAdapter?: ModelPort`
  3. 修复所有类型错误
- **风险**: 中 — 需确认 ModelPort 接口完整覆盖
- **验证**: `pnpm run typecheck` + 相关集成测试
- **PR 粒度**: 1 个 PR

#### P0-C: 将 contracts 中的业务逻辑函数移出

- **改动范围**: `contracts/src/memory/index.ts`、`contracts/src/compact/index.ts`、`contracts/src/rewind/index.ts`
- **迁移步骤**:
  1. 识别 contracts 中所有非纯类型/schema 导出
  2. 在 core 中创建对应模块接收这些函数
  3. contracts 保留 re-export 一段时间（过渡期），标记 `@deprecated`
  4. 下个版本删除 contracts 中的 re-export
- **风险**: 中 — 需更新所有下游 import 路径
- **验证**: `pnpm run typecheck` + 全量测试
- **PR 粒度**: 按子域拆 3 个 PR（memory、compact、rewind）

### P1 — 影响扩展性/协作效率（建议尽快改）

#### P1-A: 拆分 AgentRuntime God Object

- **改动范围**: `core/src/runtime/` 全部
- **迁移步骤**:
  1. **Phase 1**: 提取纯计算模块（无状态依赖）
     - `context-usage.ts` → `context/usage-metrics.ts`
     - `compact/policy.ts` 中的阈值计算 → `compact/calculator.ts`
  2. **Phase 2**: 提取 PersistenceService
     - 从 methods 中提取所有 `persist*` 方法
     - 注入 `SessionStorePort` + `SessionEventStorePort`
  3. **Phase 3**: 提取 CompactManager
     - 从 methods 中提取 `compact*.ts`、`microcompact.ts`
     - 注入 `MessageHistory`、`ModelPort`、`PersistenceService`
  4. **Phase 4**: 提取 TurnOrchestrator
     - 从 methods 中提取 `turn.ts`、`turn-loop.ts`、`turn-model-step.ts`、`turn-tools.ts`
     - 编排 CompactManager、ToolDispatcher、ContextManager
  5. **Phase 5**: AgentRuntime 变为薄 Facade
     - 只持有各服务的引用
     - 公开 API 不变，内部委托给各服务
- **风险**: 高 — 核心架构变更，需逐步推进
- **回滚策略**: 每个 Phase 独立可回滚；AgentRuntime Facade 保持 API 兼容
- **验证**: 每个 Phase 后运行全量测试 + 手动冒烟测试
- **PR 粒度**: 每个 Phase 1-2 个 PR

#### P1-B: 消除 deps.ts 集中重导出

- **改动范围**: `core/src/runtime/deps.ts`、所有 `methods/*.ts`
- **迁移步骤**:
  1. 每个 methods 文件改为直接从 `@zcode/contracts` 导入所需类型
  2. 从自身模块导入所需实现
  3. 逐步缩小 deps.ts，最终删除
- **风险**: 低 — 纯 import 路径变更
- **验证**: `pnpm run typecheck`
- **PR 粒度**: 2-3 个 PR（按 methods 文件分批）

#### P1-C: 拆分 bootstrap 中的子系统

- **改动范围**: `bootstrap/src/app/script-workflow-*.ts`、`bootstrap/src/zcode-protocol/`
- **迁移步骤**:
  1. script-workflow → `@zcode/workflow-runner` 包
  2. zcode-protocol → `@zcode/protocol-server` 包
  3. bootstrap 通过依赖引用
- **风险**: 中 — 需调整包间依赖
- **验证**: `pnpm run typecheck` + `pnpm run test:unit`
- **PR 粒度**: 2 个 PR

#### P1-D: 将 cli 包中 tui-* 文件移入 tui 包

- **改动范围**: `cli/src/tui-*.ts`（12 个文件）、`@zcode/tui`
- **迁移步骤**:
  1. 识别 tui-* 文件中对 cli 包其他模块的依赖
  2. 通过接口/事件解耦
  3. 逐个迁移
- **风险**: 低
- **验证**: `pnpm run typecheck` + `pnpm run test:unit`
- **PR 粒度**: 1 个 PR

#### P1-E: TUI 不直接依赖 core

- **改动范围**: `@zcode/tui` 的 import 语句
- **迁移步骤**:
  1. 审计 tui 对 core 的所有 import
  2. 逐个替换为从 contracts 导入类型 + 通过事件/接口交互
- **风险**: 中 — 可能需要新增 contracts 接口
- **验证**: `pnpm run typecheck`
- **PR 粒度**: 1 个 PR

#### P1-F: 合并 shared-types 到 contracts

- **改动范围**: `@zcode/shared-types`、所有引用方
- **迁移步骤**:
  1. 将 `JsonValue`、`RunContext`、`GlobalLocale`、`GlobalOptions`、`RuntimeInfo` 移入 contracts
  2. shared-types 保留 re-export 标记 deprecated
  3. 更新所有 import
- **风险**: 低
- **验证**: `pnpm run typecheck`
- **PR 粒度**: 1 个 PR

### P2 — 风格与工程规范类（可逐步治理）

| P2 项 | 改动范围 | PR 粒度 |
|-------|----------|---------|
| P2-A: 超 400 行文件拆分 | 8+ 文件 | 每个 1 PR |
| P2-B: TUI app-*.ts 按子目录组织 | `@zcode/tui/src/` | 1 PR |
| P2-C: adapters/model/runner-* 合并 | `adapters/src/model/runner-*.ts` | 1 PR |
| P2-D: webfetch 9 文件合并为 3 | `core/src/tool/handlers/webfetch*.ts` | 1 PR |
| P2-E: cli 测试文件拆分 | `cli/tests/cli.unit.test.ts` (4573行) | 1 PR |
| P2-F: contracts/session-store.port.ts 拆分 | 750 行 | 1 PR |

---

## 5. 推荐的工程化增强

### 5.1 目录结构与分层规范

建议的核心包目录结构：

```
core/src/
  agent/
    turn-orchestrator.ts     # 替代 methods/turn.ts + turn-loop.ts
    turn-state.ts            # 保留
    message-history.ts       # 保留
    session-history-hydrator.ts  # 保留
  compact/
    manager.ts               # 替代 methods/compact*.ts + microcompact.ts
    policy.ts                # 从 contracts 移入的策略函数
    calculator.ts            # 纯计算函数
  context/
    builder.ts               # 保留
    usage-metrics.ts         # 从 methods/context-usage.ts 提取
    sections/                # 保留
  permission/
    service.ts               # 保留
    broker.ts                # 保留
  persistence/
    service.ts               # 从 methods/message-persistence.ts + events.ts 提取
  tool/
    dispatcher.ts            # 替代 methods/tools.ts
    executor/                # 保留
    handlers/                # 保留
    registry.ts              # 保留
    scheduler.ts             # 保留
  subagent/                  # 保留
  workflow/                  # 远期拆为独立包
  runtime-facade.ts          # AgentRuntime 薄 Facade
  types.ts                   # 仅包含 Facade 公开类型
```

### 5.2 代码规范与静态检查

- 当前已有 `oxlint` + `oxfmt`，覆盖基本规范
- **建议增加**:
  - `eslint-plugin-max-lines` 或自定义 lint rule：单文件不超过 400 行
  - `eslint-plugin-boundaries`：禁止 tui 直接 import core 实现
  - `tsc --noEmit` 作为 CI 门禁（当前已配置）
  - `knip` 检测 unused exports（当前已配置但未在 CI 执行）

### 5.3 测试策略

| 层级 | 当前 | 建议 |
|------|------|------|
| contracts | ~2K 行，主要测 schema | 补充 Port 接口兼容性测试 |
| core | ~23K 行，集成测试为主 | 拆分后为每个服务补单测 |
| adapters | ~12K 行 | 补充 model runner 单测 |
| bootstrap | ~6.6K 行 | 补充组装逻辑单测 |
| cli | ~5K 行 | 拆分 4573 行的测试文件 |
| tui | ~5.5K 行 | 基本合理 |

**关键建议**: AgentRuntime 拆分后，每个子服务（CompactManager、PersistenceService 等）都应有独立的单元测试，不再依赖 `this: AgentRuntimeInternal` 的隐式状态。

### 5.4 可观测性

- 当前已有 `TraceContext` 传播和结构化日志，设计良好
- **建议增加**:
  - 每个 Phase 1-5 拆分完成后，为新服务添加独立的 `module` 标识
  - 在 `runtime-facade.ts` 中记录方法委托日志，便于追踪调用链
  - 为 `modelAdapter` 增加调用计时 metric（当前仅 `runner-record.ts` 有部分记录）

---

## 附录: Quick Wins（可立即修复，无需架构调整）

| # | 修复项 | 工作量 | 影响 |
|---|--------|--------|------|
| 1 | 删除 `runtime/types.ts` 中重复的 `PermissionDecisionResult`，统一使用 `permission/service.ts` 版本 | 0.5h | 消除类型不一致隐患 |
| 2 | 删除 `turn-state.ts` 中重复的 `ToolScheduleItem`，统一使用 `scheduler.ts` 版本 | 0.5h | 消除类型不一致隐患 |
| 3 | 将 `context-usage.ts` 中 `estimatedMetric`/`sumMetrics` 等纯函数提取为独立模块 | 1h | 减少 God Object 方法数 |
| 4 | 将 `modelAdapter?: any` 改为 `modelAdapter?: ModelPort` | 2h | 恢复类型安全 |
| 5 | 每个 methods 文件将 `import { ... } from "../deps.js"` 改为直接从 `@zcode/contracts` 导入 | 3h | 提升可读性 |
| 6 | 合并 `shared-types` 到 `contracts` | 1h | 减少包数量 |
