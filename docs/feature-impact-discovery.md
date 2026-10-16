# 功能影响发现（Feature Impact Discovery）

## 状态

- 本文是 `feature-boundary-planner` 在实现前执行功能扫描与影响分析的事实规范。
- 本文描述分析方法和输出契约，不修改产品运行时行为。
- 功能语义图位于 `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`；代码事实以当前工作区和 codegraph 索引为准。

## 目标

当开发者准备修改一个功能时，在阅读大量实现或开始编码前回答以下问题：

1. 这个能力出现在哪些 UI 入口、后台流程和运行模式中？
2. 哪些入口共享组件、选项来源或服务，哪些只是名称或字段相似？
3. 每个入口的草稿状态、默认值、校验、提交动作和最终状态归属分别在哪里？
4. 修改后必须关注哪些相邻功能、协议边界、持久化路径、恢复链路和测试？
5. 哪些关系来自稳定的产品语义，哪些只是静态代码的可达性证据？

最终产物是可检索的 **Impact Brief**。只有在需要定义产品行为或规划测试时，才继续展开状态笛卡尔积和用例剪枝。

## 两层图模型

单独依赖静态调用图会把工具函数、通用组件和测试辅助代码全部扩散进结果；单独维护人工文档又容易随实现演进而过期。因此功能扫描使用两层证据：

```text
开发者的变更意图
        |
        v
功能语义图（能力、UI 入口、状态归属、提交副作用、不变量）
        |
        v
UI Surface Matrix（逐入口追踪行为）
        |
        v
codegraph（当前调用方、实现路径、测试与图谱漂移）
        |
        v
Impact Brief（分级影响、证据、待确认项）
        |
        +----> 可选：边界矩阵、用例剪枝、E2E 交接
```

### 功能语义图

功能语义图维护产品层面的关系，节点至少包含以下类型：

- `capability`：用户或开发者能描述的能力，例如模型选择、自动化任务、Subagent。
- `ui-surface`：能力实际出现的入口，例如对话工具栏、自动化编辑页。
- `shared-ui`：多个入口复用的组件、选项构建器或 hook。
- `state-owner`：草稿、运行态、默认值或权威投影的归属者。
- `service`：提交命令、校验或数据来源的服务边界。
- `persistence`：数据库、配置文件或 Markdown 等持久化落点。
- `delivery-boundary`：桌面 continuous、手机 replayable、远程 workspace 等交付边界。
- `evidence`：测试、spec 或其他可验证证据。

语义边使用有方向的动词表达，例如：

- `renders-in`、`shares-component`、`options-from`
- `owns-draft`、`inherits-from`、`validates-with`
- `commits-to`、`persists-to`、`projects-to`、`recovers-via`
- `covered-by`、`must-not-mutate`、`must-remain-isolated-from`

图谱只保存高价值语义和 codegraph 起点，不试图复制完整代码调用图。

### 扫描结果如何沉淀

每次扫描都要把“当前图谱”和“当前代码事实”的差异单独列出来：

- 只要求扫描、解释或诊断时，在 Impact Brief 中给出建议的 graph delta，不直接修改图谱。
- 进入功能规划或实现交接时，先确认产品语义，再把确认过的 capability、UI surface、owner、commit sink、不变量和 code seed 写回功能语义图。
- 一个 surface 代表一套独立的用户场景和状态/提交语义；同一界面内部的多个组件调用点可以作为同一个 surface 的多个 code seed。
- 保持 node ID 稳定。重命名产品文案时优先增加 alias，避免破坏历史检索。
- 只把经过确认的产品关系写入图谱；纯静态可达、测试依赖和未解释的新调用方仍保留为 drift/evidence。

这样后续开发者既能检索已确认的功能关系，也能通过 codegraph 发现图谱落后于实现的部分。

### codegraph 代码事实

codegraph 用于验证当前实现，而不是替代产品语义：

- 从语义图声明的 symbol/file seed 开始探索。
- 查找共享组件、构建器、hook、store 和服务方法的直接调用方。
- 沿每个 UI 入口追踪“本地状态 -> 默认/继承 -> 校验 -> 提交动作 -> 权威状态或持久化”。
- 默认只展开 2 层；只有关键归属仍不明确时扩展到 3 层。
- `affected tests` 只作为证据，不能直接证明产品功能依赖。
- 当前调用方与语义图不一致时记录为 `graph-drift-candidate`，由人确认后再更新图谱。

索引代码优先使用 codegraph；`rg` 用于查找 docs、配置、生成文件或尚未进入索引的内容。

## 先判断改动层级

同一个“功能改动”在不同层级会产生完全不同的影响面。扫描前必须先分类：

| 改动层级 | 典型问题 | 默认关注范围 |
| --- | --- | --- |
| `presentation` | 文案、布局、可见性、交互控件 | 所有复用该 UI 的入口、主题、响应式、国际化 |
| `option-source` | 候选项来源、分组、排序、过滤 | 共享构建器、provider registry、各入口的二次过滤 |
| `draft-default` | 初始值、继承、fallback | 每个入口的草稿 owner、workspace/session 默认值 |
| `validation` | 可用性、权限、阻塞条件 | 入口级 gating、提交前校验、错误呈现 |
| `commit-effect` | 点击后真正改变什么 | 命令/服务、运行态 owner、隔离不变量 |
| `persistence` | 保存位置、加载和迁移 | repo/config/Markdown、跨窗口或跨工作区隔离 |
| `recovery` | 重连、snapshot、队列、恢复 | desktop continuous 与 web remote replayable 边界 |

如果用户没有说明层级，先完成低成本扫描，再只询问会改变影响结论的歧义。

## UI Surface Matrix

凡是一个能力出现在多个界面，都必须逐入口记录以下字段：

| 字段 | 要回答的问题 |
| --- | --- |
| 用户场景 | 用户为什么在这里使用该能力？ |
| UI 入口 | 页面、面板、弹窗或工具栏在哪里？ |
| 共享实现 | 复用了哪个组件、选项构建器、hook 或服务？ |
| 展示/草稿状态 | 当前值由谁展示，本地编辑值由谁持有？ |
| 默认/继承 | 未显式配置时从哪里解析？ |
| 校验/gating | 哪些条件会隐藏、禁用、回退或报错？ |
| 提交动作 | 最终调用哪个 command/service？ |
| 权威 owner/落点 | 运行时状态或持久化最终写到哪里？ |
| 模式边界 | desktop/web/mobile、local/remote 是否不同？ |
| 隔离不变量 | 这个入口绝不能意外改变什么？ |

“共享组件”不等于“共享行为”。同名 `model` 字段也不等于相同状态：对话模型可能改变当前 session，自动化模型保存到 automation record，Subagent 模型保存到 agent Markdown。

## 影响分级

Impact Brief 中的关系按以下级别排序：

1. `must-inspect`：共享修改点或同一权威状态/提交路径，遗漏很可能直接产生回归。
2. `should-inspect`：共享候选源、校验、默认值或产品不变量，通常需要回归确认。
3. `conditional`：只在特定运行模式、workspace 类型或改动层级下相关。
4. `invariant-only`：无需改代码，但必须证明没有被意外改变。
5. `evidence-only`：测试或静态可达节点，仅用于验证，不宣称产品依赖。

每条结论都要附带关系类型、原因和至少一个 code/doc 证据。不得把 codegraph 的所有可达节点平铺成“受影响功能”。

## 模型选择示例

模型选择是典型的跨 UI 能力：

```text
                         +-> 对话工具栏 -> session/draft runtime
模型候选与选择控件 ------+-> 自动化编辑 -> automation record
                         +-> 用户 Subagent -> agent Markdown
                         +-> 内置 Subagent -> built-in override
```

扫描这个能力时至少要验证：

- `ModelConfigSelect` 和 `buildModelSelectGroups` 的当前调用方。
- 各入口是否使用同一个 provider registry，以及是否存在入口级过滤。
- 对话、自动化、Subagent 的草稿 owner 和 commit sink 是否仍然分离。
- 打开或取消自动化编辑不能改变 workspace/session 的模型。
- 修改共享候选生成逻辑时，各入口的默认/继承语义不能被错误统一。
- 新增调用方但语义图中没有对应 UI surface 时，要报告图谱漂移。

## 与边界规划的衔接

功能影响发现负责回答“还要看哪里”；边界规划负责回答“各状态组合应该是什么产品行为”。两者按以下顺序衔接：

1. 产出 Impact Brief 和 UI Surface Matrix。
2. 将未定义或冲突的关系转成边界问题，与用户确认。
3. 将确认后的 capability、surface、owner、commit sink 和不变量写回功能语义图。
4. 只对已确认范围枚举状态组合。
5. 将组合标记为 `accepted`、`undefined`、`pruned`、`ignored` 或 `bug-candidate`。
6. 先更新对应 spec、case catalog 和 coverage matrix，再进入实现或 E2E 编写。

如果用户只要求扫描、解释或诊断，到 Impact Brief 为止，不修改产品代码或现有 spec。

## 输出契约

每次功能扫描至少输出：

- 功能与改动层级摘要。
- UI Surface Matrix。
- 共享实现与差异化行为。
- 分级的上游/下游功能关系。
- 状态 owner、校验点、commit sink 和持久化落点。
- 必须保持的不变量。
- codegraph seeds、直接调用方、展开深度和相关测试证据。
- `graph-drift-candidate`。
- 会改变实现或测试范围的待确认问题。

需要继续做边界规划时，再追加状态维度、剪枝决定、formal-proof 用例和 E2E 交接材料。
