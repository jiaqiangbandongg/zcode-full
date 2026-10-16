# 01 Core Model Adapter 边界清理

> 状态：已完成
>
> 日期：2026-08-24
>
> 来源审查：[`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> 相关目标设计：[`../design/model/model.md`](../design/model/model.md)、[`../design/registry/model-creation.md`](../design/registry/model-creation.md)

## 1. 任务目标

删除 Core 对 `AiSdkModelAdapter` 的直接依赖和 Compatibility Model fallback，使所有 Core 模型请求只能
通过标准链执行：

```text
Provider Registry
        |
        v
ModelFactory
        |
        v
Core AgentRuntime
        |
        v
Active Model
        |
        v
AiSdkModelAdapter
        |
        v
Provider API
```

本任务不删除 `AiSdkModelAdapter` 这个 Provider API 执行实现。它仍然负责消息和工具编码、Provider 参数、
请求鉴权、AI SDK 调用、重试、流恢复、Usage / Event 归一化和网络状态观测。要删除的是以下旁路：

```text
Core AgentRuntime
        |
        `-> modelAdapter -> Compatibility Model / 旧 ModelTextRequest
```

完成后，Core 只认识 `ModelSelection`、`ModelFactory` 和 `Model`，不持有、检查或调用 Adapter。

## 2. 已确认原则

### 2.1 Model 是 Core 唯一可执行抽象

Core 只能调用：

```ts
model.generateText(request);
model.streamText(request);
```

Core 不得直接调用 Adapter，也不得自己拼装 Provider-specific 请求。

### 2.2 ModelFactory 是根执行 Model 的唯一生产入口

所有生产模型执行入口必须取得正式 `ModelFactory`。缺少 Factory 时不得回退到 Adapter，不得由 Core
补齐 Properties、Options、Provider Connection 或默认模型能力。

`Model.bind()` 是合法的派生入口：它只能从已有 Model 创建同一 providerId/modelId、同一 Properties、同一
Option Specs 和同一 Executor 的绑定 Model。它不重新查询 Registry，也不构成第二条根 Model 创建链。

### 2.3 Adapter 只存在于 Bootstrap / ModelFactory 下游

允许：

```text
createZCodeApp
      |
      v
AiSdkModelAdapter
      |
      v
ApiProviderModelRuntime / ModelFactory
      |
      v
Model
```

禁止：

```text
Core / Workflow 业务逻辑 / Service / UI -> AiSdkModelAdapter
```

### 2.4 测试遵守同一抽象

模型调用测试使用 Fake Model / Fake ModelFactory。不能为了保留旧测试而建立 test-only Adapter fallback，也
不能简单把旧 Adapter mock 套一层兼容 Factory，让测试继续保护旧 `ModelTextRequest` 形态。

Bootstrap 集成测试若需要控制模型结果，直接提供标准 `ModelRequest -> ModelResult/ModelEvent` Executor，再
由测试装配创建 Model；不得把旧 `AiSdkModelTextRequest` Adapter mock 包装成兼容 Factory。

### 2.5 缺失依赖显式失败

生产 `AgentRuntime` 应取得正式 Factory。若确有只读 state-only 构造，必须保证它无法执行模型请求；不能
用缺少 Factory 作为隐式进入另一条执行路径的开关。

state-only Runtime 不得暴露需要创建 Model 的 Subagent 工具。Bootstrap 的 state-only Adapter 必须在唯一
`createModel()` 边界明确拒绝执行，不能继续伪装已经删除的 `generateText/streamText` 公共入口，也不能依赖
双重类型强转把缺失的 `createModel()` 隐藏到运行时。

## 3. 删除范围

### 3.1 Core Runtime 字段和依赖

删除：

- `AgentRuntimeDeps.modelAdapter`；
- `AgentRuntime.modelAdapter`；
- `AgentRuntimeInternal.modelAdapter`；
- Parent / Child Runtime 对 `modelAdapter` 的复制和传递；
- Core 对 `AiSdkModelAdapter` 具体方法存在性的运行时判断。

### 3.2 Compatibility Model

删除 Core `runtime-model.ts` 中：

- `createCompatibilityModel`；
- `resolveCompatibilityConnection`；
- `toCompatibilityRequest`；
- `resolveCompatibilityProviderOptions`；
- `COMPATIBILITY_CONTEXT_WINDOW`；
- `COMPATIBILITY_MAX_OUTPUT_TOKENS`；
- Compatibility Model 专用的 output token / thinking budget 计算；
- Compatibility Model 专用的 `ModelRef` / `ModelSelection` 转换；
- Core 为 Compatibility Model 硬编码的 input/output format；
- Core 根据 Endpoint、providerKind 或 modelId 为 Compatibility Model 推断能力的逻辑。

`createRuntimeModel()` 若保留，只能委托给正式 Factory：

```ts
export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: RuntimeModelFactoryInput,
): Model {
  return runtime.modelFactory(input);
}
```

如果实施后该 helper 不再提供额外语义，则继续内联并删除。

### 3.3 Adapter 存在性门禁

删除或改写以下形式：

```ts
if (!this.modelFactory && !this.modelAdapter) return;
if (!runtime.sessionStore || !runtime.modelAdapter) return false;
typeof this.modelAdapter?.streamText === "function";
```

处理规则：

- Title、Memory、Compact、Subagent 等只读取自己的产品开关和必要业务依赖；
- `Model` 契约已经提供 `streamText()`，是否启用流式只读取 `modelStreaming`；
- 正常生产 Runtime 不用 Adapter 或 Factory 的“存在性”表达某项 Agent 功能是否可用；
- state-only 路径不能因为移除门禁而意外触发模型执行，需要通过实际调用边界验证。

### 3.4 Workflow 与 Child Runtime 装配

以下执行形态必须使用正式 Factory：

- Main Agent Runtime；
- Workflow Child；
- Script Workflow Child；
- Foreground / Background Subagent Child；
- Workspace generateText。

Workflow 和 Script Workflow 当前可选的 `modelFactory` 改为必需依赖。Child 有独立 Selection 时，通过
同一个标准 Factory 创建 Child Model；不向 Child 传递父 Runtime 的 Adapter。

### 3.5 旧 ModelPort

删除没有有效生产引用的：

- `ModelPort`；
- `ModelPortOptions`；
- 对应 barrel export；
- 只服务于该接口的注释和测试类型。

不能把 `modelAdapter: any` 改为 `ModelPort` 来延长旧抽象生命周期。

### 3.6 Adapter 旧直接执行入口

完成 Core 和测试迁移后，审计并删除 `AiSdkModelAdapter` 的旧公共入口：

```ts
generateText(AiSdkModelTextRequest);
streamText(AiSdkModelTextRequest);
```

标准创建入口保留：

```ts
createModel(options): Model;
```

以下 Bootstrap / Adapter 组合能力本任务暂时保留：

- `replaceRegistryConfig`；
- `resolveReasoningDisabledProviderOptions`；
- `addStatusSink`；
- `setModelIoFullRetentionEnabled`。

## 4. 明确保留与非目标

### 4.1 保留的 Adapter 实现

保留 `AiSdkModelAdapter` 及其内部：

- AI SDK Runtime；
- SDK Factory / Endpoint / Header 执行投影；
- Provider 请求编码；
- Request Auth 消费；
- Retry / Stream Recovery；
- Model I/O 与 Status / Telemetry；
- Usage / Stream Event 归一化。

### 4.2 本任务不处理

以下问题分别进入后续清理项，不与本任务混做：

- `ModelConnectionPort` 及 Core 的 Connection/capability 推断；
- `ModelRef`、`variant`、Result/Event Identity 收口；
- 旧 Model Catalog 和 models.dev 数据；
- Account Provider 动态凭据生命周期；
- reasoning disabled 的具体模型 hardcode；
- Adapter 内部 AI SDK Execution Registry 的最终命名和进一步瘦身。

本任务可以删除 Compatibility Model 专属的 Connection 调用，但不以“全仓 `ModelConnectionPort = 0`”作为
完成条件。

## 5. 实施前事实

M4 合入后的初步静态扫描显示：

- 17 个 Core 生产文件仍引用 `modelAdapter`；
- `createRuntimeModel` 有 15 处静态引用，覆盖 Turn、Compact、Memory、Title、Goal 和 workspace
  generateText；
- Workflow Child 和 Script Workflow Child 的 Factory 类型仍为可选；
- 约 29 个 Core / Bootstrap 测试文件只提供 Adapter，没有提供 Factory；
- `workspace/readState` 使用禁止模型请求的临时 Adapter 创建临时 App；该 Adapter 可以继续留在 Bootstrap
  组合边界，但不能再注入 Core；
- 并行 M4 conformance review 正在修改 `runtime-model-lifecycle.test.ts`，正式实施前需要先取得无重叠的稳定
  工作树。

因此本任务边界明确、风险可控，但不是一次 trivial 删除。

## 6. 测试先行计划

### 6.1 测试工具

先建立或扩展统一测试工具：

```ts
createTestRuntimeModel(...);
createTestModelFactory(...);
createUnavailableTestModelFactory(...);
```

用途分别为：返回可执行 Fake Model、记录 Factory 创建输入，以及为不应执行模型的测试提供明确失败实现。

### 6.2 先增加失败测试

覆盖：

1. Main Runtime 只通过 Factory 创建 Model；
2. 缺少可用 Factory 时不能借助 Adapter 执行模型请求；
3. Workflow Child 使用正式 Factory；
4. Script Workflow Child 使用正式 Factory；
5. Subagent Child 使用继承或 override 后的 Factory；
6. 当前 Loop 中所有 Step 继续使用同一个 Active Model；
7. Registry 更新不改变已经创建的 Model；
8. Request Auth、Usage、Status 和 Trace 继续作用于实际 Model；
9. Streaming 与非 Streaming 均通过 Model 接口；
10. state-only workspace 读取不会发起模型请求。

### 6.3 旧测试迁移规则

- 测 Core 请求内容：Fake Model 收集 `ModelRequest`；
- 测 Core 流事件：Fake Model 实现 `streamText()`；
- 测 Provider 编码、Retry 或 SDK 行为：留在 Adapter tests；
- 不执行模型的 Runtime 测试：使用 unavailable Factory；
- 禁止继续断言 Core 产生旧 `ModelTextRequest`、Provider Options 或 Connection 请求。

## 7. 实施顺序

### Step A：稳定基线与测试装配

- 等待并行 M4 Review 释放重叠测试文件；
- 重跑静态引用审计并记录准确调用面；
- 添加测试 Factory helper；
- 先提交失败测试或在同一开发序列中确认测试先失败。

### Step B：生产 Factory 装配

- 将 Workflow / Script Workflow Factory 改为必需；
- 验证 Main、Workflow、Script Workflow、Subagent 和 workspace generateText 的 Factory 来源；
- 删除 Child Runtime 的 Adapter 传递。

### Step C：Core 删除

- 删除 Core `modelAdapter` 字段和依赖；
- 删除 Compatibility Model 和全部专属 helper；
- 删除 Adapter 存在性门禁；
- 让所有模型形成过程只调用标准 Factory。

### Step D：测试迁移

- 把旧 Adapter-shaped Core mocks 改成 Fake Model / Factory；
- 把属于 Provider 编码的断言迁回 Adapter tests；
- 执行 Core、Bootstrap 和 Adapter 定向测试。

### Step E：公共接口收缩

- 删除 `ModelPort` / `ModelPortOptions`；
- 使用 `dep:refs` 确认 Adapter 旧直接入口没有跨包调用；
- 删除 `AiSdkModelAdapter.generateText/streamText` 旧公共入口；
- 清理相关 imports、barrel exports、注释和兼容测试。

## 8. 风险与验证重点

主模型请求已经使用 Factory，主要风险来自以前被 Adapter 存在性门禁控制的支线：

- Session Title / Goal Summary Title；
- Automatic / Reactive / Micro Compact；
- Project Memory Recall / Extraction / Dream；
- Target Completion Verification；
- Workspace generateText；
- Workflow / Script Workflow Child；
- Foreground / Background Subagent；
- Streaming 与非 Streaming；
- Request Auth；
- Usage、Status、Trace 和 Model I/O。

正常生产 App 当前同时拥有 Adapter 和 Factory，因此删除 Core Adapter 门禁原则上不改变生产功能。测试中
只注入 Adapter 的旧装配是最大迁移面。

## 9. 完成条件

机械归零：

```text
Core modelAdapter                                       = 0
Core createCompatibilityModel                           = 0
Core COMPATIBILITY_CONTEXT_WINDOW/MAX_OUTPUT_TOKENS      = 0
Core 直接调用 adapter.generateText/streamText            = 0
ModelPort / ModelPortOptions                            = 0
生产 AgentRuntime 构造缺少 modelFactory                  = 0
Workflow/Script Workflow/Subagent 传递 modelAdapter      = 0
Adapter 旧 generateText/streamText 的非 Adapter 测试调用 = 0
```

行为验收：

- 所有 Core 模型请求都能追溯到一个 `Model`；
- 所有生产根 `Model` 都能追溯到标准 `ModelFactory`；绑定 Model 只能追溯到已有 Model 的 `bind()`；
- Core 不再制造 Model Properties、Options 或 Provider Connection；
- 当前 Loop 继续固定同一个 Active Model；
- Registry 更新只影响之后创建的 Model；
- 普通请求和所有 Sidecar、Child Runtime 均保留现有 Request Auth、Usage、Status 和 Trace 行为；
- 测试遵守同一抽象，不保留测试专用旧执行旁路。

## 10. 验证命令

实施完成后至少执行：

```bash
pnpm test:unit:affected
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm knip
```

此外使用 `pnpm dep:refs` 逐项确认 `ModelPort` 和 Adapter 旧直接执行方法没有遗漏跨包调用。若全量 `knip`
继续包含仓库既有噪音，应记录本任务相关符号的独立复核结果，不能用既有噪音跳过清理。

## 11. 完成记录

Todo 01 的主实现由 `a3f1082734` 完成。提交后清理审查又发现并修复了三类遗漏：

- workspace/readState 的 state-only Adapter 改在唯一 `createModel()` 边界明确拒绝，不再伪装已删除的
  `generateText/streamText`；
- 缺少 ModelFactory 的 state-only Runtime 不再注册 Subagent 工具；
- Bootstrap 集成测试删除旧 `AiSdkModelTextRequest` Adapter mock 兼容桥，统一使用标准 Model Request
  Executor；同时清理机械迁移留下的重复 `modelFactory` 字段。

根执行 Model 统一来自 ModelFactory；`Model.bind()` 和透明调用上下文包装继续作为已有 Model 的合法派生
路径，未受早期“ModelFactory 是所有 Model 唯一生产入口”的错误表述影响。
