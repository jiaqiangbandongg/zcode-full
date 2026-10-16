# Todo 34：模型选择异步状态与 Repo Wiki Draft 收口

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 后续 Desktop 图形 E2E 欠测统一由 Todo 78 收口，本 Todo 不再单独排期。

> 状态：已实现；核心自动化已复验，Repo Wiki Desktop WDIO 仍待具备当前提交的 macOS 环境实跑
>
> 日期：2026-08-28
>
> 来源：正式包 Repo Wiki 实机故障与 Model Selection Renderer 边界复核
>
> 关联任务：[`Todo 13`](./todo-13-target-host-model-selection-authority.md)、
> [`Todo 23`](./todo-23-provider-refactor-decision-gap-closure.md)、
> [`Todo 32`](./todo-32-team-plan-settings-effective-provider-boundary.md)

## 1. 运行时证据与直接故障

MacBook Pro 正式包打开 Repo Wiki 后，Section Error Boundary 显示：

```text
模型选择缺少 Provider:
```

同一时段的正式包日志证明目标 Host 并不缺少模型：

- `model-selection.getView` 正常完成；
- Registry 已发布 `account:bigmodel-team-coding-plan / GLM-5.3-Flash`；
- Provider Runtime 已报告对应模型就绪。

真实时序为：

```text
Repo Wiki 首次渲染
        |
        v
useModelSelectionView 初始返回 null
        |
        v
null 被投影成空 groups，默认模型再变成 ""
        |
        v
resolveRepoWikiThoughtLevelOption 解析 ""
        |
        v
parseModelPickerValue 抛错
        |
        v
Error Boundary 卸载 Repo Wiki
        |
        `-- getView 随后成功，也无法更新已经卸载的页面
```

反复点击 Section Retry 仍可能重复同一首次渲染时序。因此这不是 Registry、Account Team Plan 或正式配置缺少模型，
而是 Renderer 把正常异步前置状态送入了只接受完整 Selection 的严格解析边界。

## 2. 更大范围的设计问题

### 2.1 `null` 擦除了异步生命周期

当前 `useModelSelectionServiceView()` / `useModelSelectionView()` 返回
`ModelSelectionView | null`，其中 `null` 同时表达：

- 首次读取中；
- 目标 Remote Workspace 尚未连接；
- Service 缺失或读取被禁用；
- `getView()` 已失败但只写了日志。

这些状态具有不同的 UI、重试和提交语义，不能继续共用一个空值。目标 Host 切换时，返回状态还必须绑定当前 Service/
workspace target，避免旧 Host View 在 Effect 清理前被新目标短暂消费；现有 generation guard 只防止迟到 Promise 覆盖，
没有让返回类型证明当前 View 的 owner。

此外，当前 `useModelSelectionView(null)` 并不表达“缺少目标”，而会按本地目标解析并回落 Base/Current Host。因此
Workspace 入口不能继续用一组 nullable 标量隐含“目标存在与否”；调用方必须先形成明确 Workspace Target，没有目标时直接
进入 unavailable，不能调用 Workspace Service Resolution。

### 2.2 `null -> [] -> ""` 连续制造伪业务事实

`buildRegistryModelSelectGroups()` 当前接受 nullable View，并把未加载投影成空数组。Repo Wiki 再把空候选投影成空
`modelValue`。于是以下两种事实无法区分：

```text
ModelSelectionView 尚未取得
!=
ModelSelectionView 已取得且 providers 确实为空
```

加载状态也因此逃过 TypeScript 检查，最终在渲染期进入严格 parser。

### 2.3 Repo Wiki Store 保存了控件编码，而非领域 Selection

Repo Wiki 生成草稿当前保存：

```ts
modelValue: string;
modelTouched: boolean;
thoughtLevel?: string;
thoughtLevelTouched: boolean;
```

`provider/model` 字符串只是 `ModelConfigSelect` 的控件编码，不应成为 Repo Wiki Draft 的模型事实。代码因此在展示、
reasoning 投影和 Submission 处反复 parse，并允许 `""` 进入产品状态。既有 Provider Refactor 已明确各独立模型任务统一
引用 `ModelSelection`；Repo Wiki 应直接保存稀疏的显式 Selection，并仅在 Select 控件边界格式化字符串。

### 2.4 Renderer 重复实现 Host Fallback

目标 Host 的同一份 `ModelSelectionView` 已原子包含候选和 `preferredSelection`：

```text
Configured Default 仍可选择
        |
        +-- 是 --> preferredSelection = Configured Default
        `-- 否 --> 第一个可见且拥有模型的 Registry 候选
```

Configured Default 必须属于当前 View、Provider 不能 hidden、Model 必须存在且显式 options 必须合法。Fallback 只作为
本次入口初始化结果，不回写持久 Configured Default。

Repo Wiki 当前仍在无匹配值时自行选择 `modelGroups[0].items[0]`，形成第二套 Fallback Policy。Renderer 不应重复
Host 算法；尤其是用户显式选择已经失效时，不能静默切换到另一个 Provider/Model。

### 2.5 Generate 准入没有依赖模型状态

当前 `generateDisabled` 只考虑项目、共享设置和任务运行状态，没有覆盖 Model Selection loading、remote waiting、
读取失败、ready-empty 或显式选择失效。点击后才在事件处理器内静默退出，不是完整的交互准入。

### 2.6 相邻调用方存在同类风险

| 调用方              | 当前表现或风险                                                  |
| ------------------- | --------------------------------------------------------------- |
| Repo Wiki           | 初始空值进入严格 parser，页面直接崩溃                           |
| Subagent Settings   | 读取失败与 unavailable 可能永久伪装成 loading                   |
| Automation Settings | 加载期退化为空菜单；无明确 target 时会回落 Base/Current Host    |
| Composer            | 加载期候选为空，虽未崩溃但无法表达真实原因                      |
| Root 登录入口       | 额外用 `view !== null` 等待水合，读取失败时无法完成启动判断     |
| Provider Settings   | 两套 Snapshot/Service Hook 都会把首次读取失败永久保留为 loading |

相邻代码中还存在把持久模型字符串重新送入严格 parser 的旧边界。它们需要在迁移调用方时逐项确认，但不因本次故障泛化成
“所有 nullable 数据都必须改成状态机”：只读展示允许缺少附加模型元数据，真正需要明确 lifecycle state 的是候选读取 Owner、
交互准入和 Submission 边界。

## 3. 已裁决原则

1. Registry、`IModelSelectionService` 和严格 `parseModelPickerValue()` 不是本故障根因；不得放宽 parser 接受空字符串，
   也不得为加载态构造 Placeholder Provider/Model。
2. RPC `getView()` 可以继续异步返回完整 View；加载、不可用、错误和重试属于 Renderer Service Adapter 的职责。
3. `ModelSelectionView.providers` 为空只表达“已读取且没有候选”，不再兼任 loading。
4. Model Selection 候选、`preferredSelection` 和 revision 必须来自目标 Host 的同一份 View；Remote 未连接不得回退
   Local/Base Host。
5. `preferredSelection` 只参与没有显式意图的新产品 Draft 的 Effective Selection 解析；它不写入 Draft 的显式
   `modelSelection`，也不是当前 Session Selection、Active Model、最近使用模型或强制推荐模型。
6. Renderer 不重复 Configured Default、Registry 排序或 Fallback Policy。
7. 产品 Draft 保存 `ModelSelection`，Select 的编码字符串只存在于控件边界；Submission 直接固定完整
   `ModelSelection`。
8. 用户显式 Selection 失效时保留原意、展示不可用并禁止提交；不得静默换到菜单第一项。没有显式意图时才继承
   `preferredSelection`。
9. Error Boundary 只承接非预期渲染错误；loading、unavailable、ready-empty 和读取失败必须成为普通页面状态。
10. 已创建的 Session/Active Model 继续冻结；本 Todo 只改变候选读取、Draft 初始化和提交前准入，不改变运行中模型。
11. 首次读取失败进入 error；已经取得 Ready View 后的后台刷新失败保留上一份成功 View 并记录 warning。当前 Service 事件
    只发布成功 View，本轮不为展示后台刷新错误扩张 RPC/Event 协议。

## 4. 目标状态链路

### 4.1 Renderer Service State

模型选择生命周期 Hook 返回判别联合，而不是 nullable View。具体命名可在实现时统一，但语义固定为：

```ts
type ModelSelectionState =
  | { status: "loading" }
  | { status: "ready"; view: ModelSelectionView }
  | {
      status: "unavailable";
      reason: "remote-waiting" | "missing-target";
    }
  | { status: "error"; error: Error };

interface ModelSelectionRead {
  state: ModelSelectionState;
  reload(): void;
}
```

```text
明确 Host Service ----------------> Service State Hook

明确 Workspace Target
        |
        +-- 不存在 ----------------> unavailable/missing-target
        |
        `-- 存在
              |
              v
     Workspace Service Resolution
              |
              +-- remote-waiting --> unavailable/remote-waiting
              `-- Host Service ----> Service State Hook
                                           |
                                           v
                                  loading/error/ready(view)
```

实现保留两个明确入口：已经处于目标 `ServiceProvider` 的组件直接读取 Host Service；需要跨 Workspace 读取的产品先传入明确
Workspace Target，再做 Workspace Service Resolution。Hook 内部处理订阅先行、初次读取、target key、revision 单调、迟到
结果丢弃、首次错误和 reload；这个 Renderer 生命周期类型不进入 Provider Config、Registry 或 Protocol DTO。

Service/Target 改变后，Hook 在同一次 render 中如果发现内部状态的 owner key 不匹配，必须立即投影 loading，而不是等
`useEffect` 再清空旧 View。后台刷新失败继续保留 Last Known Good Ready View。

### 4.2 Ready-only 投影

`buildRegistryModelSelectGroups()` 改为只接受 `ModelSelectionView`。候选菜单、准入和 Submission 调用方必须先对
`ModelSelectionState.status` 分支；不允许候选 projection helper 自行把非 ready 状态折叠成 `[]`。只读叶子组件如果只是
缺少可选的 Label/Metadata，可以接收上层已经提取出的可选 Ready View，不需要传播完整状态机。

### 4.3 Repo Wiki Draft

Repo Wiki 生成设置中的模型部分改为领域对象：

```ts
modelSelection?: ModelSelection;
```

- `undefined`：没有 Repo Wiki 显式模型覆盖；
- 有值：用户为本次 Wiki 明确选择的 Provider、Model 和 options；
- 首次展示 `preferredSelection` 或已有 Wiki Selection 时只形成解析结果，不回写 `modelSelection`；只有用户实际修改
  模型或 reasoning 后才写入显式 Selection；
- 模型变化时清除旧模型不兼容的 reasoning option；
- reasoning 变化直接更新 Selection 的 `options.reasoningLevel`；
- `ModelConfigSelect` 渲染时格式化为字符串，选择事件在边界解析一次后写回 Selection；
- 删除以空字符串和 `modelTouched`/`thoughtLevelTouched` 组合模拟继承、显式覆盖与完整 Selection 的并行状态。

### 4.4 Repo Wiki 最终模型解析

建立一个纯解析入口，输入目标 Host Ready View、Repo Wiki Draft 和已有 Wiki 记录，输出判别结果：

```text
Repo Wiki 显式 Selection
        |
        +-- 当前 View 中有效 --> ready(explicit)
        `-- 已失效 -----------> unavailable，不静默回退

没有显式 Selection
        |
        v
已有 Wiki Selection 当前仍有效
        |
        +-- 是 --> ready(existing)
        `-- 否 --> Host preferredSelection
                         |
                         +-- 存在 --> ready(preferred)
                         `-- 不存在 -> ready-empty / no-model
```

这里的“当前 View 中有效”必须复用现有 `isSelectionInView()` 的完整语义，统一校验 Provider/Model 成员、reasoning level 和
max output tokens；不得在 Repo Wiki 内另写只判断 Provider/Model 是否存在的弱校验。

Ready 结果应同时携带最终 `ModelSelection`、控件 groups 和对应 reasoning option。展示与 Generate 使用同一个结果，
不再各自 parse 或重新 fallback。

### 4.5 页面行为

| Model Selection 状态   | Repo Wiki 行为                                 |
| ---------------------- | ---------------------------------------------- |
| loading                | 显示模型加载状态，模型控件和 Generate 禁用     |
| remote-waiting         | 显示等待目标 Workspace 连接，不访问 Local Host |
| error                  | 显示读取失败与 reload，不伪装成无模型          |
| ready + providers 为空 | 显示当前没有可用模型，Generate 禁用            |
| ready + 显式选择失效   | 展示失效选择和修复入口，Generate 禁用          |
| ready + 有效 Selection | 正常展示 reasoning 并允许 Generate             |

`generateDisabled` 必须包含最终 Repo Wiki Model State；事件处理器仍保留不变量断言，但不以静默 return 代替 UI 准入。

### 4.6 相邻入口行为

判别联合迁移到其它调用方时，只收口各入口真实使用的模型候选生命周期，不改变它们各自的 Draft 和提交语义：

| 入口              | loading / unavailable                                                | error                                                          | ready                                                       |
| ----------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Root 启动门禁     | 继续等待首次 Model Selection View                                    | 结束静默等待，显示读取失败和 reload；不得解释成“没有 Provider” | 按现有 Provider 可用性规则完成启动检查                      |
| Composer          | 保留当前 Draft/Session Selection，模型控件显示加载态且不可提交新选择 | 保留当前 Selection，模型控件显示读取失败和 reload              | 使用目标 Host View 展示候选，不改 Session/Active Model 归属 |
| Automation        | missing-target/remote-waiting 显示在模型控件，不回退 Base Host       | 保留表单 Draft，模型控件显示读取失败和 reload                  | 只从所选 Workspace Host 读取候选                            |
| Subagent Settings | 保留表单 Draft，模型相关控件显示加载态                               | 保留表单 Draft，模型相关区域显示读取失败和 reload              | 继续使用 Local Environment View                             |
| Provider Settings | 面板显示加载态，不把 `null` 当作空 Provider 列表                     | 面板显示读取失败和 reload                                      | 展示该 Environment 的 Provider Settings View                |

Root 的 error 必须结束当前仅由 `hydrated` 布尔值控制的无限等待，但不能伪造空 `ModelSelectionView` 触发现有“无可用 Provider”
分支。Provider Settings 继续使用自己的领域状态，不复用 `ModelSelectionState` 类型。

## 5. 实施范围

1. 将 Model Selection 读取拆成明确 Host Service 与明确 Workspace Target 两个入口，并增加 lifecycle state、owner key、
   首次错误和 reload；
2. 迁移 Root、Composer、Repo Wiki、Automation 与 Subagent 全部调用方，不保留 nullable 兼容 Hook；
3. 收紧 Registry Model Groups projection 的 Ready-only 输入；
4. 将 Repo Wiki Generation Draft 的模型字段切换为 `ModelSelection`；
5. 用单一 Repo Wiki 模型解析结果驱动模型标签、reasoning、禁用状态与 Submission；
6. 删除 Repo Wiki Renderer 的菜单第一项 fallback、空字符串模型事实和重复 parse；
7. 将 `useProviderSettingsServiceView()` 和根级 Provider Settings Snapshot 的首次 loading/error/reload 状态收口；两者可
   复用内部订阅机制，但继续暴露各自领域状态，不改变 Provider Settings/Account Overlay 语义；
8. 迁移调用方时审计 Subagent、Composer 与 Session Catalog 中剩余的模型字符串 parser：控件边界可保留字符串，产品
   Draft/Record 不新增字符串事实；与本次 lifecycle 无关的历史兼容不扩大改造；
9. 重写 `docs/repo-wiki.md` 的模型选择与能力来源章节，删除 deferred session/prewarm 和 Service 二次选择等过时链路，
   统一为 Generate Submission 显式固定 `ModelSelection`；
10. 在模型选择 Design 与 Feature Graph 中补充 Renderer 异步读取状态，删除 Repo Wiki 直接读取旧 Model Provider Service
    的漂移描述，保持 `preferredSelection`、Configured Default、App Recent、Session Selection 与 Active Model 的既有
    优先级和 Owner 不变。

本 Todo 不修改：

- Provider Config Overlay 顺序；
- Account Provider 模型成员或 Access；
- Registry 完整性/执行准入；
- Configured Default 的物理存储与 Fallback 算法；
- Repo Wiki 模型请求、Prompt、重试、超时或生成内容；
- 普通会话 Selection、队列、恢复与 Active Model 生命周期。

## 6. 测试计划

先写失败测试，再改生产实现。

### 6.1 Hook 与异步状态

1. 首次订阅为 loading，`getView()` 完成后进入 ready；
2. `getView()` 失败进入 error，reload 成功后进入 ready；
3. remote-waiting 和 missing-target 明确为 unavailable，且不调用 Local Host；
4. 切换 Host 的同一次 render 不暴露旧 Host View；
5. 旧 Host 迟到 Promise/事件不能覆盖新 Host；
6. 同一 Host 的 revision 只能单调前进，事件先于首次读取完成时保留较新 View；
7. ready 后后台刷新失败保留 Last Known Good View，后续成功事件仍可继续更新；
8. ready-empty 与 loading/error/unavailable 保持可区分。

### 6.2 Repo Wiki 纯状态与组件

1. Model View 延迟返回时首次渲染不抛错，返回后显示 `preferredSelection`；
2. 显式 Repo Wiki Selection 有效时优先于已有 Wiki 和 Host preferred；
3. 显式 Selection 失效时保留原意并禁用 Generate，不回落第一项；
4. 没有显式 Selection 时，有效已有 Wiki Selection 优先；失效时回落 Host preferred；
5. Host 无 preferred 且无候选时显示 no-model；
6. reasoning option 只从最终 Selection 对应的 Ready View 解析；切模型会清除不兼容 option；
7. Repo Wiki Store 不再保存空模型字符串，Submission 直接携带完整 `ModelSelection`；
8. loading、unavailable、error、ready-empty 和 ready 分别显示正确状态与按钮准入；
9. 普通 error 状态的重试按钮调用真实 reload；Section Error Boundary 不再承接该类预期状态。
10. 首次展示 preferred/existing Selection 不写入 Draft；用户未修改时，新的 Host View 可以更新 Effective Selection；
11. 显式/已有 Selection 的 reasoning level 或 max output tokens 不被当前 View 接受时判定为失效，不进入 Submission。

### 6.3 受影响入口回归

1. Composer 首次加载和 Host 切换不清空或串用已存在 Draft/Session Selection；
2. Automation 未选择有效 target 时不读取 Base Host，目标就绪后显示对应候选；
3. Subagent 区分 loading、unavailable 与 error，不永久转圈；
4. Root 登录入口只在 Ready View 上判断 Provider 可用性；首次读取失败结束启动等待、展示 reload，且不进入“无 Provider”
   分支；
5. Remote Workspace 断连/重连不泄漏 Local Provider；
6. Provider Settings 的目标 Service Hook 与根级 Snapshot 都区分首次 loading/error/ready，失败后可 reload；
7. Desktop continuous 与 Web Remote replayable 的任务/stream 行为不变。

涉及 UI 交互，必须增加或更新 Desktop E2E：至少覆盖延迟 ModelSelection View 后打开 Repo Wiki、Remote waiting 和
ready-empty，不得只用 helper 单测证明。最后执行定向单测、相关 E2E、`pnpm typecheck`、`pnpm lint`、修改文件格式检查
和 `git diff --check`。

## 7. 完成标准

- 模型候选读取 Owner、交互准入和 Submission 边界不再把 loading/error/unavailable 表达为 nullable View、空候选或空
  字符串；
- `buildRegistryModelSelectGroups` 等正式 projection helper 不接受 nullable View；
- Repo Wiki Domain Store 不保存模型选择控件字符串或空字符串哨兵；
- Host preferred/existing Selection 只参与 Effective Selection 解析，用户未修改时不落入显式 Draft；
- Repo Wiki 渲染期不会在非 Ready 状态调用严格 Selection parser；
- Renderer 不再实现第二套 Registry 第一项 fallback；
- 显式失效模型或选项不会被静默替换，Generate 只接受经现有完整 Selection 校验的 Ready `ModelSelection`；
- Model Selection 的目标 Host、revision 和错误状态有自动化证明；
- Provider Settings 首次读取失败不再永久伪装成 loading；
- Repo Wiki 文档、模型选择 Design 与 Feature Graph 和当前必传 `ModelSelection` 协议一致；
- 所有定向测试、交互 E2E、根 typecheck 与 lint 通过；
- 完成后提交 Conventional Commit。

## 8. 实施结果与阶段复审

### 8.1 Renderer 生命周期

- `useModelSelectionServiceView()` 与 Workspace 入口改为 `loading / unavailable / error / ready` 判别联合，并提供显式 `reload()`；切换 Service 的同次 render 不暴露旧 View。
- 订阅先于首次读取，revision 单调；旧 Host 迟到结果被 generation 丢弃，Ready 后读取失败保留 Last Known Good，后续事件仍可恢复更新。
- Workspace 缺少 target 或处于 remote-waiting 时不读取 Model Selection Service，不回退 Base/Local Host。
- `buildRegistryModelSelectGroups()` 只接受完整 `ModelSelectionView`，非 Ready 分支必须由调用方先处理。

阶段复审：Hook、owner、revision、reload、Last Known Good、missing-target 与 remote-waiting 均有直接单测；未增加 Protocol DTO、Registry 副本或第二套模型事实。

### 8.2 Repo Wiki 与相邻入口

- Repo Wiki Store 只保存稀疏显式 `modelSelection?: ModelSelection`；控件字符串只在 Select 边界编码/解析。
- `resolveRepoWikiModelState()` 统一执行 explicit > existing > Host preferred；显式 Selection 或 options 失效时保留原意并阻止 Generate，不回退菜单第一项。
- loading、remote waiting、target missing、error、ready-empty 和 invalid-explicit 均成为普通页面状态；读取失败提供 reload，Generate 只接受 Ready Selection。
- Root、Composer、Automation、Subagent 全部迁移到显式生命周期；已有 Draft/Session Selection 不因非 Ready 状态被清空。
- Provider Settings 的根快照与目标 Service Hook 同样区分 loading/error/ready，并支持首次失败重试与 Ready 快照保留。

阶段复审：删除了 Repo Wiki 的空字符串模型事实、touched 并行状态、菜单第一项 fallback、重复 Submission parser 和已无生产调用的 reasoning 恢复 helper。Desktop continuous、Web Remote replayable、Session Selection 和 Active Model 生命周期没有修改。

### 8.3 文档、Feature Graph 与验证

- `docs/repo-wiki.md` 与模型选择 Design 已改为目标 Host Ready View、结构化 Draft Selection 和提交期精确固定。
- Feature Graph 新增 Renderer Model Selection Read 与 Provider Settings Service 节点，并删除 Repo Wiki/Composer/Automation/Subagent 直连旧 Model Provider Service 的漂移边。
- Repo Wiki E2E 增加异步 Ready/Error Boundary 防回归与 ready-empty 准入断言；Remote waiting 的无 Local fallback 使用无外部 SSH 依赖的 Hook 自动化固定。

已通过：

- Provider/Model Selection、Repo Wiki、Root、Composer、Automation、Subagent 定向单测；
- 根 `pnpm typecheck`；
- `pnpm --filter @zcode/desktop typecheck:e2e`；
- 根 `pnpm lint`（0 error；仓库既存 warning 不在本 Todo 范围）；
- Feature Graph YAML 解析、增量节点/seed 存在性和 `git diff --check`。

全量 `pnpm test:unit` 完成 12,683 项通过、25 项跳过；一条既存 CUA socket 关闭竞态在全量并发下偶发失败，隔离复跑 22/22 通过。全量并发还命中一次 Vitest worker heap 上限；本 Todo 的全部受影响测试已拆分复跑通过。

Desktop E2E 已实际启动并完成 production build，但当前 Linux 执行机缺少 `xvfb-run`，Chrome 在创建 session 前退出；这是显示环境阻塞，不是用例断言失败。详细失败报告位于本次运行生成的 `.e2e-artifacts`，用例保持可在具备显示环境的 CI/macOS 上执行。

### 8.4 2026-09-01 状态复验

- `useModelSelectionView`、Workspace target、Repo Wiki Model State 与事实来源 4 个定向测试文件实跑通过，共 15 条；
- `pnpm --filter @zcode/desktop typecheck:e2e` 通过；
- 当前 Linux 执行机仍未安装 `xvfb-run`，没有把无法创建浏览器 Session 记成 E2E 通过；
- MacBook Air 当前工作副本位于另一个提交，未用旧构建替当前 HEAD 伪造验证结果。后续需同步当前提交后实跑
  `repo-wiki-generation-settings.test.ts` 与 `repo-wiki-generation-produces-wiki.test.ts`。
