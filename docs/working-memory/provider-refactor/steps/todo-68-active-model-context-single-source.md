# Todo 68：Active Model 与执行 Context 单一事实收口

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：已完成实现与验证（2026-09-03；提交随本轮收口）
>
> 来源：实机切换同名模型后，模型在下一轮才感知新 Provider 的回归

## 1. 问题与根因

当前正式请求已经使用本轮 `ModelSelection` 创建出的 Active Model，但 Context 前缀仍从
Session Selection 单独推导 `currentModel` 和模型相关工具提示。两条链路的应用时机不同：

```text
本轮 Submission Selection
          |
          +---------------------------> Active Model -> 正式请求
          |
          `-- 尚未写入 Session Selection

旧 Session Selection -> Context 前缀 -> 模型看到的“Current model”
```

Turn 在异步 Context 初始化和 SessionStart Hook 之后才应用 Submission Selection；此时
`activeTurn` 已建立，旧的刷新保护又禁止改写当前 Turn 的 Context。结果是 Adapter 请求使用新
Model，而请求内的环境说明仍写上一轮 Model，表现为切模总是滞后一拍。

同一分裂还影响：

- Guide 在同一 Turn 的合法 model-step 边界切换 Model；
- execution-scoped Off-Peak Model 不修改 Session Selection；
- Subagent 继承父 Active Model 时仍从父 Session Selection 拼 child Selection；
- Context 中按模型投影的工具提示没有使用正式请求持有的 Model。

## 2. 统一原则

`ModelSelection` 是“以后创建哪个 Model”的 Session/Submission 意图，可以持久化；它不是正在
执行的模型事实。

每个模型步骤只创建并持有一个不可变 Active Model。该步骤的 Context、工具投影、预算、Adapter
和实际请求全部直接读取同一个 Model：

```text
Session / Submission ModelSelection
                 |
                 v
             ModelFactory
                 |
                 v
        immutable Active Model
          |        |        |
          v        v        v
       Context    Tools    Request
```

- 不新增 Context Model Snapshot、Execution Model Binding、Provider Snapshot 或 capability DTO；
- 不把 Active Model 持久化；Registry 更新只影响以后创建的 Model；
- Session Selection 在活动 Turn 中变化，只影响下一次新建的 Model；
- `contextSourceSnapshot` 继续保存 cwd、平台、Shell、Git 和 Instructions 等合法 Context Source，
  但不再保存或推导执行模型；
- Session Selection 的防御性复制与本 Bug 无关；对外方法使用
  `getSessionModelSelection()` / `setSessionModelSelection()` 明确它是未来 Turn 的会话选择，避免被误读为
  当前 Active Model。

## 3. 实施设计

### 3.1 Turn admission

普通 Turn、Compact 和 execution-scoped Off-Peak 在第一次异步等待前冻结 Selection，并只创建一次
本轮 Active Model。随后：

1. Context 初始化/重建显式接收该 Model；
2. SessionStart Hook 读取该 Model 的 Provider/Model 身份；
3. Submission 的 Session Selection 写入与事件发布复用已经创建的 Model，不再次创建；
4. Regular Loop、Memory Recall、Compact、工具投影和请求继续使用同一个对象。

Rewind 等不发模型请求的命令不应为了重建历史而额外要求一个可执行 Model。

### 3.2 Context 前缀

删除 `refreshContextModelSnapshot` 这种把 Session Selection 同步到 Context 的语义。保留通用的
Context 前缀重建能力，用于语言、输出样式、Shell、Rewind 等真实 Context Source 变化；重建时如
果属于模型步骤，必须显式传入该步骤的 Active Model。

Context Builder 只能从显式 Model 生成：

- 最终 Prompt 中的 Provider/Model 说明（不经过环境字段）；
- `guidanceToolNames` 等模型相关投影。

它不得调用 `getSessionModelSelection()` 猜测正在执行的 Model。

### 3.3 Guide model step

Guide 切模会创建新的 Active Model。下一次请求前，用该 Model 重新投影 Context 前缀，并同时替换
当前 Turn 的 request-local 前缀；已提交的用户、助手、工具和提醒尾部保持不变。Session Selection
是否更新继续沿用 Guide 的现有语义。

### 3.4 Subagent

Subagent 继承父 Model 时，child Selection、child prompt 中的模型身份和 child ModelFactory 都从
实际传入的父 Active Model 派生，不再混用父 Session Selection。显式 profile/override 继续创建
自己的 Model。

## 4. 测试先行

先增加会在旧实现失败的回归测试：

1. 普通显式切模：请求使用新 Model，Context 也立即显示同一 Provider/Model；
2. execution-scoped Off-Peak：Context 和请求都使用临时 Model，Session Selection 保持不变；
3. Turn 已开始后外部修改 Session Selection：当前 Active Model 与 Context 不变；
4. Guide 切模：下一 model step 的 Context、工具和请求同时切到 Guide Model；
5. SessionStart Hook：首轮收到 admission 时已经选定的 Model；
6. Subagent 继承：即使父 Session Selection 与父 Active Model 不同，child 仍完整继承 Active Model；
7. Registry/Selection 后续变化只影响后来创建的 Model。

## 5. 完成标准

- 代码中不存在从 Session Selection 推导当前执行 Context Model 的路径；
- 一个 model step 的 Context、工具与 Adapter 请求使用同一 Active Model；
- 普通切模、Guide、Off-Peak 和 Subagent 不再出现模型身份错拍或混用；
- 不引入第二套模型事实、额外状态同步或超时兜底；
- 定向测试、Core 全量单测、根 `pnpm typecheck` 与 `pnpm lint` 通过；
- 更新 Registry Runtime Design 与 Feature Graph，并记录最终实施结果。

## 6. 已完成的主链实施

- Turn 在第一次异步等待前按 admission Selection 创建唯一 Active Model；Context 初始化、Context
  前缀重建、SessionStart Hook、Submission 状态应用和正式请求复用同一个对象。
- `setSessionModelSelection()` 只更新未来 Model 的选择意图，不再把 Session Selection 同步进 Context，旧
  `refreshContextModelSnapshot` 已删除。
- Context Source 不再保存执行模型；`currentModel` 和模型相关工具提示仅从当前 model step 显式传入的
  Active Model 生成。
- execution-scoped Off-Peak 使用自己的 Model 和 Context，但不改写 Session Selection；Guide 在下一个
  model step 同时更新 Model 与 request-local Context；Subagent 从实际继承的父 Active Model 派生 child
  Selection 并直接复用该 Model。
- 删除了切换 Session Selection 时冗余的 Built-in Tool 刷新；工具是否可见继续在请求时由
  `getTools(activeModel)` 判断。

验证结果：

- Core 全量单测：`2207 passed / 36 skipped / 2 todo`；
- `@zcode/core` typecheck：通过；
- 根 `pnpm typecheck`：通过；
- 根 `pnpm lint`：通过（仅有仓库既存 warning）；
- 本轮修改文件格式检查与 `git diff --check`：通过；
- 全仓 `pnpm fmt:check` 仍被仓库既有的 Electron fiddle 非法 HTML 和
  `apps/zcode-cli/tests/gb2312.js` 读取失败阻塞，本轮未修改这些基线文件。

## 7. Review 后的最终收口范围

这一轮继续写入 Todo 68，不新增重复 Todo。下面各项都来自同一个根因：Session 的未来选择意图、
Submission 的本次输入意图与 Active Model 的执行事实曾经混在一起。

### 7.1 三类事实的最终边界

```text
Session Model Selection
├─ 表示会话后续执行的持久选择意图
├─ 可以变化、持久化和恢复
├─ 不描述当前正在执行的模型
└─ App 仅在已有 Session 缺少 Composer Draft 时用于一次初始化

App Composer Draft（Todo 71）
             |
             | 用户提交时一次性冻结，不在 admission 回读 Session 补值
             v
Submission Model Selection
├─ 表示这一条已提交输入选中的 Provider / Model / Reasoning
├─ 排队期间保持冻结
└─ 在开始 model step 时交给 ModelFactory
             |
             v
immutable Active Model
├─ 当前 model step 唯一执行事实
├─ Context 模型说明与模型相关工具投影
├─ Adapter、模型属性和请求 Option
└─ 不持久化；Registry 更新不改变已经创建的对象
```

以上 Draft 路径仅描述 App。CLI、Bot、自动化、闲时等入口继续按自己的契约生成完整执行输入，不能强制
套用 App Draft，也不能覆盖已冻结的 Submission。Session 接纳后的状态更新不反向覆盖用户正在编辑的 Draft。

Runtime 原来的 `getModelSelection()` / `setModelSelection()` 只读写 Session 事实，名字确实会让调用方误以为
它代表当前执行模型。本轮统一改为 `getSessionModelSelection()` /
`setSessionModelSelection()`。方法内部的复制只用于防止调用方后来修改同一个 JavaScript 对象；它不创建
新的业务事实，也不参与 Active Model 或 Context 同步。

### 7.2 删除 `EnvInfo.currentModel` 的反向入口

当前 `ContextSourceSnapshot.envInfo` 仍沿用一个带可选 `currentModel` 的通用类型，因此 Builder 里存在下面
这段桥接语义：

```text
Context Source envInfo.currentModel
              |
              v
          先忽略/删除
              |
              v
再从 Active Model 生成 currentModel
```

这虽然能避免旧值真正进入请求，却保留了一个误导性的第二入口。最终应收口为：

```text
Context Source Snapshot
└─ cwd / platform / shell / OS / Git 等环境事实

Active Model
└─ Provider / Model 身份
          |
          v
Context 渲染阶段直接生成模型说明
```

- Context Source 请求、快照和持久化数据不再接收或保存 `currentModel`；
- 删除 Builder 中“先剥离 `_ignoredCurrentModel`”以及持久化前 `delete currentModel` 的桥接；
- Subagent 不再手工把 child Selection 写进 `envInfo`；
- 主 Agent 与 Subagent 的模型说明仍可出现在最终 Prompt 中，但其输入只能是该 model step 的 Active
  Model，不能是环境探测结果或 Session Selection；
- 不误删 Protocol 中仅用于旧 UI 展示或兼容序列化、且不属于 Context Source 的同名字段；这些字段需要按
  实际用途分别判断。

### 7.3 首轮 Context 只构造一次

旧路径在首个 Turn 中先初始化 Context Builder，紧接着又为同一个 Active Model 重建 Prefix：

```text
首次 Turn
  -> ensureContextInitialized(activeModel)
  -> 创建 Builder、加载 Source / Skills / Memory、初始化消息历史
  -> rebuildContextPrefix(activeModel)
  -> 立即再次创建 Builder 和 Prefix
```

这不是正确性所需的两阶段流程，只是合并后的重复调用。改为互斥分支：

```text
Context 尚未初始化
  -> ensureContextInitialized(activeModel)       # 一次完成

Context 已初始化
  -> rebuildContextPrefix(activeModel)           # 为新的 model step 重建
```

首个 Turn 因而只创建一次 Builder；后续普通 Turn、Guide 的新 model step 和其他确实需要更新 Prefix 的路径
继续重建。Rewind 等不创建模型请求的操作不额外构造 Active Model。

### 7.4 Queue 只收口已确定的不变量

普通排队消息仍然在消费时开启一个新 Turn。本轮只修正文档和回归测试中的模型事实：

```text
消息入队
└─ 保存完整 Submission Model Selection
        |
Session Selection 后续变化
        |
        v
队首消费并开启新 Turn
└─ 使用入队时冻结的 Provider / Model / Reasoning
   Provider Config 则在创建 Active Model 时读取当前最新配置
```

删除“排队消息消费时使用最新 Session Selection”的旧说法。`sendQueuedNow`、默认立即引导以及 Guide/Queue
之间的产品语义本轮明确暂停，不改协议和实现，也不借 Todo 68 作推断。

### 7.5 明确排除 `outputStyle`

`outputStyle` 在异步 Context 初始化期间仍可能出现同一轮不同位置读取到不同值的问题。这是既有的通用
Submission 参数一致性问题，不是 Provider/Active Model 重构的组成部分。本轮只记录边界，不修改它；若
后续决定收口，应建立独立 Todo，不扩大 Todo 68。

## 8. 影响面与不变量

### 8.1 必须直接验证的链路

- 普通 Turn 显式切换 Provider/Model；
- 同一 Turn 内 Guide 开启的新 model step；
- execution-scoped Off-Peak；
- Subagent 继承父 Active Model 与显式覆盖；
- 首轮 Context 初始化、后续 Prefix 重建与 SessionStart Hook；
- 模型相关工具投影与 Adapter 请求使用相同 Active Model。

### 8.2 只验证不变量、不扩张实现的相邻链路

- 普通 Queue 保存完整 Submission Selection，并在未来新 Turn 使用它；
- Registry/Personal Config 更新只影响以后创建的 Active Model；
- Desktop `continuous` 与 Mobile `replayable` 只负责传递同一条已经提交的 Submission，不新增各自的模型
  选择推导；
- Session 冷恢复仍恢复 Selection，而不是序列化 Active Model；
- Compact、Memory、标题生成等辅助步骤继续显式创建并使用自己的 Active Model，不回读 Context 模型字段。

### 8.3 本轮不做

- 不修改 `sendQueuedNow` 或默认立即引导语义；
- 不处理 `outputStyle` 的通用 admission 一致性；
- 不新增 Context/Provider/Execution Snapshot；
- 不改变模型选择 UI、Provider Registry 刷新或远程传输协议。

## 9. Review 收口测试与完成标准

最新 Review 进展：主执行链及 7.2 类型入口、Builder/持久化剥离桥接已经收口。Builder 直接接收 Active
Model；Core 全量 2213 条与最终 Bootstrap 定向 82 条通过。Pro 已取得下述实机证据，详见同目录
`68-72-implementation-report.md`：连续 A → B → C → A 的请求与 Context 一致，第二轮复跑同时加强标记目标断言。

当前工作区的 Core、Bootstrap 与根类型检查已经通过，根 Lint 仅有仓库既有 warning；这些自动化结果证明
主链没有明显回归，但不能替代下面的实机验证。按用户最新要求统一在 MacBook Pro 测试，Air 只作为
原始问题来源，不再要求在 Air 执行。

在已有七组 Core 回归测试基础上补齐并复核：

1. Context Source 输入即使来自旧 fixture，也不能成为当前模型事实；最终 Prompt 中的模型说明必须来自
   Active Model；
2. Subagent 环境信息不携带第二份模型身份，child Prompt 与请求仍使用同一个 child Active Model；
3. 首个 Turn 只初始化一次 Context Builder，后续 Turn 和 Guide 只在合法 model-step 边界重建一次；
4. 排队 Submission 在 Session Selection 改变后仍使用入队时的 Provider、Model 和 Reasoning；
5. 原始场景实机回归：在 MacBook Pro 的同一 Session 中连续切换三个同 modelId、不同 Provider 的模型，每次
   切换后的第一条请求都同时满足：
   - UI model-change marker 是目标 Provider；
   - Context 中的模型说明是目标 Provider/Model；
   - Adapter 实际请求使用同一个 Active Model；
   - 不再出现“上一拍 Provider”。

验证层级：

```text
Core 单测
  -> 冻结/初始化/Context/Queue 不变量

Bootstrap 集成测试
  -> Submission -> ModelFactory -> Context -> Adapter 纵向一致

Desktop E2E / MacBook Pro 实机
  -> 连续切模后的第一条消息无滞后
```

完成前必须再次通过 Core/Bootstrap 定向测试、相关包 typecheck、根 `pnpm typecheck`、根 `pnpm lint` 和
`git diff --check`。若 Desktop E2E 环境仍受阻，必须保留 MacBook Pro 的运行日志和请求轨迹作为实机证据，
不能只以单测代替原始回归。
