# M2 新增代码评审

> 状态：上线前评审快照
>
> 日期：2026-08-20
>
> 初次评审基线：`origin/staging` `7c49a63ee381`，M2 分支 `8fd68b123417`
>
> 当前状态：初次评审识别的设置表单 DTO 与公共 Adapter Factory 双轨已经删除；当前事实以
> M2 Cleanup 和后续 Implementation Log 为准
>
> 阶段目标：[`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)
>
> 退役结果：[`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md)

## 结论

M2 已经基本完成 Provider 事实来源切换。Official、Personal 与 Account Config 形成唯一 Registry 输入；旧 Provider Store、Catalog/Preset 分支和 Workspace Provider Snapshot 没有继续参与普通长期 Provider 的稳态解析。

初次评审时，新增生产代码中约 `1.4k–1.9k` 行属于运行期过渡边界，另有约 `0.7k–0.9k` 行负责一次性旧配置和凭据迁移。该数字用于解释初次评审发现的问题，不再代表当前分支规模；设置表单 DTO、普通执行的 Runtime Config 装配和若干旧 Services 存储已经在后续收尾中删除。

这里需要区分两类性质：

```text
一次性迁移
└─ 读取旧事实，写入新格式，随后退出运行链路

运行期过渡边界
└─ 新旧类型或执行机制仍在同一次运行中衔接
```

前者影响代码体积和维护成本，但不构成稳态双事实源。后者反映设置 UI、临时模型和 Adapter 边界仍有后续收口工作。

## 改动规模

以下数字来自 `git diff origin/staging...HEAD`。统计排除了 `pnpm-lock.yaml`；文件分类按生产源码、测试和 Markdown 文档计算，因重命名检测和少量非 Markdown 配置文件，分类总数与 Git 总数可能相差数行。

| 内容 | 新增 | 删除 |
| --- | ---: | ---: |
| 全部分支差异 | 42,805 | 54,206 |
| 排除 lockfile | 42,754 | 54,205 |
| 生产源码与运行配置 | 17,275 | 24,915 |
| 测试 | 15,441 | 28,237 |
| Markdown 文档 | 10,036 | 1,053 |

新增生产内容中，`@zcode/provider`、`@zcode/provider-node` 与 Official Config 共 `6,436` 行，其中纯领域与 Node Source/Repository 实现为 `4,120` 行，Official Config 为 `2,316` 行。这部分构成 M2 最集中的新设计骨架。

## 已经切干净的事实链路

普通长期 Provider 当前遵循同一条链路：

```text
Official Config
      +
Personal Config
      +
Account Config
      |
      v
Process Provider Registry
      |
      +-- Settings / Selection View
      +-- Selection 校验
      +-- Model 创建
      └-- 请求执行
```

生产协议 Entry、Prompt CLI 和 TUI 都会启动进程级 Registry 并传入 `createZCodeApp()`。启用 Registry 时，旧模型列表明确不参与模型候选，旧 `modelCatalog` 也只作为首次迁移输入。旧 `ModelProviderService`、OAuth Preset Repo、Catalog Sources 和 Workspace Provider Catalog 的稳态职责已经删除。

因此，当前主要问题不是旧 Provider Store 仍在后台决定执行，而是新事实需要经过若干旧接口形状才能到达尚未迁移的消费者。

## 运行期过渡边界

### 设置页旧表单 DTO 已退出

初次评审发现设置页仍通过旧表单 DTO 双向转换：

```text
ProviderSettingsView
        |
        v
旧 ModelProviderConfig 表单 DTO
        |
        v
用户编辑
        |
        v
ProviderConfigObject / ModelConfigObject
```

后续收尾已经删除 `providerSettingsLegacyProjection` 和对应反向转换。Renderer 表单现在直接承载
`ProviderConfigObject` 与 `ModelConfigObject`，保存后由 Provider Settings Facade 写 Personal Config 并等待
Registry 刷新。编辑草稿仍属于 Renderer 私有状态，但不再使用旧 endpoint、kind、modalities 或 reasoning
patch DTO。

### Core 无 Registry 装配分支已经退出

最终收尾把 `providerRegistry` 改成 `createZCodeApp` 的必填依赖，并迁移了 Bootstrap 测试、Compact /
Memory E2E 和 Prompt Trajectory。旧 `RuntimeModelConfig / ModelCatalog` 不再承担裸 App Factory 的
Provider 事实；测试需要自定义模型时显式创建测试 Registry，协议 Entry 继续使用进程 Registry。

这项收口删除了本节最初评审出的代码级双轨。`RuntimeModelConfig` 仍用于当前 Turn 的临时 Provider
输入和 Core 过渡字段，不再是普通长期 Provider 的 App 启动来源。

### Turn 临时模型继续借用 Runtime Overlay

这部分约 `200–300` 行，主要位于：

- `apps/zcode-cli/packages/bootstrap/src/app/turn-execution-model-source.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/turn-model-overlay.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/runtime-model-factory.ts`

普通 Provider 已经由新 Registry 提供。闲时任务等临时输入仍通过旧 Turn Overlay 转成 `ExecutionScopedModelSource`：

```text
普通长期 Provider -> Process Registry

Turn 临时 Provider -> Runtime Overlay -> ExecutionScopedModelSource
```

这条边界已经限制为 Turn scope，不会写入 Registry 或 Workspace Preferences。Workspace/Session 级 Provider Overlay 已经删除。后续 execution-scoped Provider 设计完成后，可以删除旧 Runtime Model Config 与 Catalog 的转换。

### 新 Registry 编译为现有 AI SDK 执行 Registry

`provider-registry-model-runtime.ts` 新增约 `448` 行，将 Provider Registry 编译成现有 `AiSdkModelRegistryConfig`，并通过现有 `AiSdkModelAdapter` 创建 M1 `Model`。

```text
Provider Registry
        |
        v
AI SDK Runtime Registry
        |
        v
AiSdkModelAdapter
```

这是一层运行实现投影，不是第二事实源：模型是否存在、Properties、Option Specs 和 Selection 都由新 Registry 决定。它仍然暴露出 Adapter 内部保留了另一套 Provider 表示，reasoning 参数也需要在这里转换为旧 `providerOptions` 形状。

这层可以跟随 Adapter/Reasoning 专题继续演进，不阻塞 M2 的 Config 与 Registry 上线。若把“过渡代码”定义为所有未来需要替换的实现，它应计入；若只审计双事实源，它不构成失败项。

### Account 身份的窄兼容

旧无账号作用域 `accessId` 和旧 Coding Plan Key 保留了少量解析与首次导入逻辑，约 `50–100` 行。新 Account Source 只产生带账号身份的 scoped accessId；请求期兼容只用于识别迁移期间已存在的旧 Model/Session。

退出条件是旧 Session 与旧 Credential Store 的兼容窗口结束。新代码不得再产生无账号作用域的 Account Access ID。

## 一次性迁移代码

一次性迁移约 `0.7k–0.9k` 行，主要集中在：

- `legacy-cli-personal-provider-config-importer.ts`；
- `legacyPersonalProviderConfigImporter.ts`；
- `legacyAccountProviderApiKeyLoader.ts`；
- Personal Config 与 Model Selection Repository 的 `importLegacy` 边界。

它们遵循相同生命周期：

```text
新配置不存在或版本过旧
        |
        v
读取旧物理格式
        |
        v
生成并校验版本化新 Config
        |
        v
备份、原子写入
        |
        v
以后只读取新 Config
```

这组代码包含旧 Catalog、旧 Provider Model、旧 reasoning patch 和兼容缺省值，复杂度较高，但没有被 Registry 稳态路径反向调用。迁移窗口结束后应按模块整体删除，避免演变成长期格式兼容层。

## 复杂但属于目标设计的代码

Account Provider 的连接解析、Personal/Team Key、请求期鉴权与 Account Source 代码同样复杂，但复杂性来自账号、权益和动态凭据本身。它们已经收敛为：

```text
账号与权益事实 -> Account Config
请求凭据       -> Request Auth Service
静态 Provider  -> Registry
```

只要这些模块不重新生成 Provider 静态事实，也不从旧 Provider Store 回填 Registry，就不应仅因代码复杂而归为兼容债务。

## 后续收口顺序

上线前需要保持的核心门禁是：普通生产入口必须装配新 Registry，旧 Store 只可用于一次性迁移，Turn Overlay 不得扩展到稳态 Provider。

上线后的推荐收口顺序为：

1. 在 execution-scoped Provider 阶段替换 `turnRuntimeModel` 与旧 Overlay。
2. 在 Adapter/Reasoning 阶段继续收敛 AI SDK Runtime Registry 投影，避免业务层重新理解 `providerOptions`。
3. 兼容窗口结束后删除旧 Personal Config、Account Key 和无作用域 accessId 迁移代码。

生产 `createZCodeApp()` 的 Registry 依赖已经成为必填机械约束，测试 Harness 也必须显式装配 Registry；
它不再属于后续事项。M2 当前可以进入上线收尾，但不能把“事实源已经统一”误写成“所有旧类型与执行
机制已经删除”。前者已经成立；后者仍需要上述几个明确、可测量的退役步骤。
