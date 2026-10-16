# Todo 58：Model Option Default 退役与 Enum 编辑器收口

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：实现完成；图形 E2E 待可用显示环境复跑
>
> 日期：2026-09-01
>
> 前置：Todo 42 / Bugfix 08 已固定 Reasoning 档位从低到高及辅助调用使用 `values[0]`；Todo 54 已把每个 Option 到原始 Request Body 的映射收口到 Option Spec 自身。本 Todo 不改变 Option Map、Provider Template、Access、Account、模型成员或请求鉴权设计。
>
> 后续裁决：Reasoning Spec 的可选性与 Mapping 隐藏结论已由 Todo 60 覆盖；当前设计要求每个 Effective Model 都具有完整 Reasoning Spec，并在设置页开放 Reasoning Mapping。

## 1. 目标

删除 Model Option Spec 中的所有 `default`，让 Option Spec 只描述合法值域、顺序、上限和请求映射；具体执行值必须由模型选择或执行调用方明确提供。

```text
Model Option Spec
├─ enum  -> 合法值 + 顺序 + map
└─ limit -> 硬上限 + map

Model Selection / Model Request
└─ 本次实际使用的 Option 值
```

Reasoning Enum 的顺序是唯一缺省策略来源：

```text
values[0]                         values.at(-1)
   |                                   |
   v                                   v
最低公开档位                          最高公开档位
明确的低成本辅助调用                  普通选择确实缺省时
```

不新增 `reasoningLevelPolicy`、`defaultPolicy`、`preferredValue`、`initialValue` 或另一套 Option DTO。

## 2. 问题与根因

当前结构把“模型支持什么”和“调用方没有决定时替它选什么”混在一起：

```ts
interface EnumOptionSpec {
  type: "enum";
  values: readonly string[];
  default: string;
  map: string;
}

interface LimitOptionSpec {
  type: "limit";
  max: number;
  default: number;
  map: string;
}
```

`default` 当前被多层重复物化：

```text
Config / Built-in Rule
        |
        v
Model constructor 补一次
        |
        v
Adapter bindModel 再补一次
        |
        +--> Runner / Bootstrap 继续 fallback
        |
        `--> UI / Bot 对缺失 reasoning 再 fallback
```

这些消费者证明当前实现允许不完整 Option 流动，并不证明 `default` 是模型静态事实。

- `maxOutputTokens.default` 不是模型硬能力。Agent 真正需要的是 `max`，本次输出预算属于执行选择。
- `reasoningLevel.default` 在已有 Session、最近选择和显式模型切换中都不应参与；这些状态应保存具体档位。
- 普通入口确实缺少 reasoning 时，统一取有序 Enum 的最后一项；辅助低成本调用继续显式取第一项。
- 当前 Provider 模型设置页用 JSON 编辑 Reasoning Enum，同时把“最大输出 Token”实际绑定到 `default`，没有准确表达配置语义。

### 2.1 Air 正式包确认的 Max Output 误报

2026-09-01 在 MacBook Air 的正式包 `3.10.1` 中确认了下面的稳定复现：

1. 在 Personal Provider 中新增模型；
2. 输入一个没有命中具体数值上限规则的模型 ID，例如 `claude`；
3. 上下文窗口填写 `10000`；
4. “最大输出 Token”填写合法正整数 `1000`；
5. 保存仍提示“最大输出 Token 必须是正整数”。

这不是输入格式、Air 本地配置或模型 API 报错。当前实现的真实链路是：

```text
UI “最大输出 Token” = 1000
              |
              v
maxOutputTokensValue 被解释为 Personal default
              |
              v
提交逻辑要求 inherited maxOutputTokens.max 已存在
              |
              +-- 存在 --> 用 inherited max 构造 Limit Spec
              |
              `-- 不存在 --> resolvedMaxOutputSpec = null
                                   |
                                   v
                         错误归类为 maxOutputTokens
                                   |
                                   v
                         “必须是正整数”误导文案
```

通用 API Rule 可以只提供 `map`；没有命中具体模型 Rule 时，Inherited Option Spec 因此可能没有 `max`。`1000` 已经通过正整数解析，真正失败的是旧实现无法在没有 Inherited `max` 时构造自身的 Limit Spec。

根因包含两层：

- 数据语义错误：名为“最大输出”的输入框实际保存 `default`，并把 `max` 当作必须继承的外部前提。
- 错误分类错误：结构缺失和输入格式非法被折叠成同一个 `maxOutputTokens` 字段错误。

本 Todo 不给旧 `default` 模型增加兼容分支。删除 `default` 后，输入框直接编辑 `max`，合法正整数能够独立形成 Personal `max` Overlay；只有空值且所有继承层都没有 `max` 时，Effective Model Config 才是不完整的。

## 3. 已确认契约

### 3.1 Option Spec

最终结构：

```ts
interface EnumOptionSpecConfigInput {
  type?: "enum" | null;
  values?: readonly string[] | null;
  map?: string | null;
}

interface EnumOptionSpec {
  type: "enum";
  /** 按语义强度从低到高。 */
  values: readonly string[];
  map: string;
}

interface LimitOptionSpecConfigInput {
  type?: "limit" | null;
  max?: number | null;
  map?: string | null;
}

interface LimitOptionSpec {
  type: "limit";
  max: number;
  map: string;
}
```

约束：

- Enum `values` 非空、去重，顺序从低到高；客户端不根据具体字符串猜测强度。
- Limit `max` 是合法正整数，是模型允许的硬上限。
- `map` 继续读取本次 Effective Option value，生成原始 Request Body JSON Merge Patch。
- Personal Rule 继续对 `type / values / max / map` 做叶子 Overlay；`values` 作为一个完整数组叶子替换，不逐项合并。
- Effective Model Config 不再要求或暴露任何 Option `default`。

### 3.2 Reasoning 选择

统一规则：

```text
调用方提供合法 reasoningLevel
└─ 原样使用

调用方没有提供，模型有 Reasoning Spec
└─ 普通选择补为 values.at(-1)

明确的低成本辅助调用
└─ 显式使用 values[0]

调用方提供不合法 reasoningLevel
└─ 报错，不静默替换

模型不提供推理能力
└─ 使用 values=["disabled"]、map="{}" 的完整 Spec
```

普通缺省补全只在标准 Model Selection 解析边界完成一次。补全后的 `preferredSelection`、最近选择、Session Selection 和 Active Model 都携带具体 reasoning，不允许 UI、Service、Model 或 Adapter 再各自 fallback。

`resolveInitialModelSelection` 的行为收口为：

- 配置的首选选择完整且合法：原样使用。
- 配置的首选选择缺少 reasoning，而目标模型支持 reasoning：补 `values.at(-1)`。
- Registry fallback 选择第一个可见模型时：若模型支持 reasoning，同时补 `values.at(-1)`。
- 显式携带但不受支持的 reasoning：配置选择无效，不能用最高档掩盖错误。
- 不支持 reasoning 的模型使用唯一 `disabled` 档位和空 Patch；不存在缺少 Reasoning Spec 的 Effective Model。

最近选择和 UI 模型切换必须落成完整选择：

- 旧的稀疏最近选择进入当前 View 时，按相同规则补全后再使用和重新持久化。
- 用户选择模型时，Reasoning 选择器必须同步得到一个具体合法值；没有历史值时显示最高档。
- 已有 Session 继续继承并冻结自身的具体 reasoning，不随 Registry 或 Built-in 更新漂移。

### 3.3 Max Output

```text
Model Option Spec.max
└─ 模型硬上限

Selection 绑定值或本次 Model Request.maxOutputTokens
└─ 本次执行预算
```

- 删除 `maxOutputTokens.default` 以及所有从它物化请求值的代码。
- 最终进入 Model Executor 前必须得到合法 `maxOutputTokens`，并满足 `0 < value <= max`。
- 值可以由已经绑定的 Selection Options 提供，也可以由本次请求明确提供；两者都没有时在网络 I/O 前报错。
- Request 显式值继续覆盖已经绑定的 Selection 值。
- Adapter 只消费已经完整、校验通过的 Effective Options，不决定预算、不 clamp、不回退到 `max`。
- 本 Todo 不把 `max` 当作隐式请求值；`maxOutputTokens = max` 只有调用方明确选择时才成立。

### 3.4 Active Model 与执行边界

```text
完整 Model Selection
        |
        v
ModelFactory
        |
        v
Active Model
├─ optionSpecs：值域 / max / map
└─ bound options：Selection 已明确的值
        |
        v
Model Request 明确其余执行值
        |
        v
prepareRequest 完整性与范围校验
        |
        v
Adapter / Option Map / Request Signing
```

- Active Model 继续冻结 Provider、Model Config、Option Specs 和已经绑定的 Selection Options。
- Registry 更新不修改已经创建的 Model。
- `Model.prepareRequest()` 是进入 Executor 前的最终完整性咽喉；不能把缺失 Option 推到 SDK、网络层或 Provider 服务端。
- `ModelExecutor` 只接收完整 Effective Options。
- Option Map 顺序、原始 Request Body 观察点和签名前应用顺序保持 Todo 54 的现状。

## 4. Enum Option Spec GUI

### 4.1 目标形态

用紧凑的可排序标签编辑器替换 Reasoning Option Spec JSON：

```text
推理档位（从低到高）

[ low ] [ medium ] [ high ] [ max ] [＋]
```

不显示“最低”“最高”“缺省”等重复说明；“从低到高”已经完整表达顺序契约。

### 4.2 交互

- 每个标签展示一个 Enum 原始字符串值。
- 整个标签可拖动排序，排序结果就是保存后的 `values`。
- 单击或键盘激活标签进入普通文本输入编辑。
- 每个可编辑标签提供删除操作；`＋` 在末尾增加新值并聚焦。
- 禁止空白值和重复值；错误就地显示，不能保存无效数组。
- 至少保留一个值；最后一个值不能直接删除到空数组。
- 拖动时禁止文本选择，drop 后直接保持乐观顺序，不出现先回原位再跳到新位置的闪动。
- 支持键盘完成聚焦、编辑、提交、取消和顺序调整；不能只依赖鼠标拖动。
- 桌面端保持单行紧凑；空间不足时自然换行，不制造横向页面滚动条。
- Web、手机布局复用同一行为；触控目标满足现有 Design 尺寸约束。
- 深浅主题、中文和英文文案均使用现有 Token 和国际化机制。

### 4.3 Overlay 与草稿

- GUI 展示 Effective `values`，本地草稿只记录用户明确修改后的 Personal `values` Overlay。
- 未修改时不把继承数组复制进 Personal Rule。
- 修改后沿用现有 Personal Override 饱和边框样式，不新增“默认/已修改”文字。
- “全部恢复默认”清除 Personal `values` Overlay，重新展示继承值。
- 隐藏的 `map` 必须原样保留；编辑 `values` 不得覆盖或清空 `map`。
- 取消弹窗不提交草稿；保存仍走现有 revision 校验和原子 Personal Model Rule 保存链路。

### 4.4 Max Output GUI

- 当前“最大输出 Token”输入框改为编辑 `optionSpecs.maxOutputTokens.max`。
- 输入框值/placeholder 使用继承与 Personal `max`，不再读取或保存 `default`。
- 用户填写的合法正整数可以直接建立 Personal `max`，不能要求 Inherited Config 预先存在 `max`。
- 清空输入时删除 Personal `max` Overlay 并恢复继承值；如果最终仍没有 `max`，按 Effective Model Config 不完整处理，不能伪装成数字格式错误。
- 非数字、非整数或小于等于零才显示“最大输出 Token 必须是正整数”。
- 不在 Model Config 页面新增“本次输出 Token”或执行预算设置。

### 4.5 弹窗反馈横幅

当前弹窗存在两套不一致的反馈：

```text
默认配置匹配成功
└─ 内容区下方完整绿色横幅

草稿校验失败
└─ 滚动内容末尾一行红字
```

收口为一个弹窗内反馈组件和固定反馈槽位：

```text
可滚动配置内容
        |
        v
Dialog Feedback Slot
├─ success：绿色语义色 + 对勾 + 成功消息
└─ error：红色语义色 + 错误图标 + 失败消息
        |
        v
恢复默认 / 取消 / 保存
```

要求：

- 成功和失败复用相同的容器结构、圆角、边框、间距、字号和图标尺寸，只切换语义色、图标与文案。
- 使用 Design Token，不在组件内硬编码颜色；深浅主题保持一致。
- 反馈槽位位于滚动区之外、Footer 之上，不能因为表单很长而被推到滚动区底部或不可见位置。
- 同一时刻只显示一条反馈；校验失败立即覆盖“已加载模型默认配置”。
- “已加载模型默认配置”只在新解析结果实际改变当前未触碰字段时显示；相同结果重复解析不重复提示。
- 成功提示保持当前短时展示；错误持续到用户修改对应字段、恢复默认、重新提交成功或关闭弹窗。
- 错误文案必须对应真实失败原因。格式错误、JSON Schema 错误和 Effective Config 不完整不能共用误导文案。
- 反馈横幅提供 `role="status"` 或 `role="alert"` 的准确可访问性语义；不能仅依赖颜色表达结果。
- 不新增全局 Toast，也不把弹窗草稿校验混入 Provider 页面底部的保存/连接测试反馈队列。

## 5. UI Surface Matrix

| 场景                                          | 当前值/草稿 owner                     | 新的缺省或继承                                             | 提交/执行落点                 | 本 Todo 行为                        |
| --------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- | ----------------------------- | ----------------------------------- |
| Provider 模型配置弹窗                         | Renderer 本地 Model Rule 草稿         | Built-in/Template/Provider/Personal Effective Model Config | Personal Model Config Rule    | Enum 标签编辑器；Max 编辑 `max`     |
| 新对话草稿                                    | Renderer draft + Model Selection View | 最近完整选择，否则 `preferredSelection`                    | Session Model Selection       | 缺失 reasoning 补最高档并落成具体值 |
| 已有 Session                                  | Agent Session Selection               | Session 自身冻结值                                         | Active Model / 后续请求       | 不读取 Spec default                 |
| 模型切换                                      | Composer 本地选择                     | 当前合法值，否则目标模型最高档                             | `session/setModel`            | 提交完整 reasoning 选择             |
| Automation                                    | Automation 编辑草稿                   | Target Host `preferredSelection` 的具体值                  | Automation record             | 创建时保存具体 reasoning            |
| Repo Wiki                                     | Workspace generation draft            | 其独立选择/Target Host View                                | 单次 Wiki execution           | 不与 Session 草稿互相覆盖           |
| Subagent                                      | 表单或 Markdown 配置                  | 父模型继承或显式目标选择                                   | Subagent config / child Model | 继承具体值；显式选择补完整          |
| Bot                                           | Bot draft / active task               | 具体 Selection                                             | Bot task execution            | 删除 `spec.default` fallback        |
| Title / Goal / Commit / Memory / Connectivity | 各辅助调用                            | `values[0]`                                                | 单次绑定或 Request            | 保持最低档位，不改 Session          |
| Model 执行                                    | Active Model + Model Request          | 不提供隐式 default                                         | Model Executor                | 缺值在网络前失败                    |

共享候选源不等于共享状态。Automation、Repo Wiki、Subagent、Bot 与普通 Session 保持各自草稿、持久化和提交边界。

## 6. 实施阶段

### 阶段 A：Spec、失败测试与配置契约

1. 先更新 Model Contract、Configuration、Model Creation、Runtime、Settings、Option Map 和 Built-in 作者规范。
2. 更新 Feature Graph：
   - Reasoning `values` 继续从低到高；
   - 普通缺省取最后一项；
   - 低成本辅助取第一项；
   - Option Spec 不再拥有 `default`。
3. 写失败测试固定新 Schema、Overlay、完整性和顺序语义。
4. 删除 Built-in 与测试 Fixture 中所有 Option Spec `default`。
5. 严格 Schema 不再接受 `default`；本功能尚未正式发布，不保留双读、兼容字段或 Runtime fallback。

### 阶段 B：Model Selection 完整化

1. 让 Registry 校验在模型支持 reasoning 时要求 Selection 具有合法 reasoning。
2. 在现有 Initial Selection Resolver 中完成普通缺省最高档补全，不新增 Policy 对象或第二套 Resolver。
3. 收口 configured default、Registry fallback、最近选择和模型切换的具体值构造。
4. 删除 UI、Bot、Automation、Repo Wiki、Subagent 中的 `?? spec.default`。
5. 显式非法值继续失败，不允许用最高档静默修复。

### 阶段 C：Model 与 Adapter 完整执行值

1. 删除 Model constructor、Adapter `bindModel`、Runner、Bootstrap 中所有 Option default 物化。
2. Active Model 只绑定 Selection 明确提供的 Option。
3. 调整 Model Request/Execution Contract，使 Executor 前的 Effective Options 完整。
4. 为每个实际执行入口补齐明确的 `maxOutputTokens` 来源；不得新增统一数字 fallback。
5. 保持 Request 值覆盖绑定值、上限校验、Option Map 和 Request Signing 顺序。
6. 用依赖引用审计确认旧 default helper、类型、测试 Fixture 和出口彻底归零。

### 阶段 D：Provider 设置 GUI

1. 先写组件和交互失败测试，再实现紧凑 Enum 标签编辑器。
2. 替换 Reasoning Option Spec JSON 草稿、解析器和 textarea。
3. Max Output 输入改为 `max`，删除依赖 Inherited `max` 才能保存合法 Personal 数值的旧分支。
4. 抽取弹窗反馈横幅，统一默认配置加载成功与草稿校验失败的结构、位置和生命周期。
5. 拆分字段格式错误与 Effective Config 不完整错误，确保 Air 复现场景能够保存 `max: 1000`。
6. 验证 Overlay、全部恢复默认、取消、保存、revision 冲突和隐藏 `map` 保留。
7. 增加桌面与手机 E2E，覆盖拖动、键盘、反馈横幅、主题、国际化和窄宽度布局。

### 阶段 E：文档与机械清理

1. 更新 Bugfix 08：普通请求不再使用 `default`，只保留辅助 `values[0]` 裁决。
2. 更新 Todo 54 和 Feature Graph 的旧 invariant，删除“default remains ordinary request default”。
3. 全仓搜索 Option Spec default 读取、Fixture、Schema、文档和 JSON，确保没有第二套默认值。
4. 不机械删除其他领域名为 `default` 的合法概念。

## 7. 测试计划

### Config / Schema

- Enum/Limit Spec 不接受 `default`，支持严格 JSON round-trip。
- Enum `values` 非空、去重；Limit `max` 为正整数。
- Personal `values`、`max` 和 `map` 叶子 Overlay、`null` 清除及后置覆盖正确。
- Built-in 每个 Effective Model Config 都得到完整的 `values/max/map`，正式 JSON 不再出现 Option Spec `default`。

### Model Selection

- 支持 reasoning 的模型：显式合法值通过，显式非法值失败，缺值在普通初始化时补最后一项。
- 不支持 reasoning 的模型：不生成值，显式传入则失败。
- configured default、Registry fallback 和稀疏 recent selection 均补为最高档并持久化完整值。
- 模型切换同步提交具体 reasoning；已有 Session 继续继承自身值。
- Built-in Rule 更新只影响后来创建的选择/Model，不改变已有 Active Model。

### Runtime / Adapter

- Model/Adapter 不从 Spec 合成任何 Option。
- 缺少最终 `maxOutputTokens` 或所需 reasoning 时，在网络 I/O 前明确失败。
- 显式请求值覆盖绑定值，超出 `max` 失败且不 clamp。
- Generate 与 Stream 使用相同完整性、映射和错误语义。
- Option Map 仍观察最终 Effective value，生成正确原始 Request Body。
- Title、Goal、Git Commit、Memory Recall、Provider Connectivity 继续使用 `values[0]`。
- 普通 Session、Compact、Subagent、Repo Wiki、Automation、Bot 使用各自明确选择，不回读 Spec default。

### UI

- Enum 标签正确展示继承值，新增、编辑、删除、拖动和键盘排序保存正确。
- 空值、重复值和空数组不能保存。
- 拖动 drop 后无回跳闪烁、无文本选择。
- Personal 修改样式、全部恢复默认、取消不提交和隐藏 `map` 保留正确。
- Max Output 编辑 `max`，不再产生 `default` Overlay。
- 没有 Inherited `max` 时输入合法正整数可以保存为 Personal `max`；重新打开后显示相同值。
- 非数字、非整数和非正数显示格式错误；继承链最终缺少 `max` 显示准确的配置不完整错误。
- 默认配置加载成功与草稿失败使用同一个反馈横幅组件；成功/失败语义色、图标、互斥与生命周期正确。
- 反馈横幅固定在滚动区外；长表单和窄窗口下无需滚到末尾即可看到。
- 相同默认配置重复解析不重复提示；实际没有改变草稿时不显示“已加载模型默认配置”。
- Desktop/Web/手机、深浅主题、中英文和窄宽度无横向页面滚动。

### E2E / 回归

- Provider 设置中编辑 Reasoning 顺序，保存、重开后顺序一致；Runtime 映射使用新顺序下的显式值。
- 在 Personal Provider 中新增未命中具体 Max Rule 的 `claude`，填写 Context `10000` 和 Max Output `1000` 后可保存；Personal Rule 只写 `max: 1000`，不写 `default`。
- 新增模型命中默认配置时显示成功横幅；随后制造校验错误时由同位置错误横幅立即替换，修正字段后错误消失。
- 新会话无 recent selection 时使用目标模型最高档；已有 Session 不漂移。
- 切换到另一套 Reasoning 值域的模型时提交合法具体值。
- Automation、Repo Wiki 与 Subagent 的选择不污染普通 Session。
- Desktop continuous 与 Mobile replayable 的 Session Selection/恢复语义保持不变；不引入新的 snapshot 或恢复字段。

## 8. 不变量与非目标

- `values` 始终按推理强度从低到高。
- 普通缺省只取 `values.at(-1)`；辅助低成本只取 `values[0]`。
- 不根据 `off / none / nothink / low / max` 等字符串猜测语义。
- 不新增 Option Policy、Capability DTO、执行 Registry 或按具体模型 ID 的 Runtime hardcode。
- 不改变 Provider/Model Identity、Provider Template、Account Overlay、Access、Endpoint、API Schema、鉴权或 Request Auth。
- 不改变模型成员、模型 enabled、Provider 排序、队列、Compact、恢复和远程 Workspace 生命周期。
- 不开放 Option Map GUI，也不建立通用任意 JSON Request 编辑器。
- 不把 Model Config 页变成本次请求预算设置页。

## 9. 完成标准

- Config、Effective Model Config、Registry DTO、Active Model 和 Runtime Option Spec 都不存在 `default`。
- Built-in Config 与 Personal Rule Schema 不读写 Option Spec `default`。
- 所有支持 Reasoning 的普通 Model Selection 在提交/使用前都具有具体合法档位。
- 普通缺省最高档与辅助最低档只有基于有序 `values` 的直接实现，没有 Policy 抽象和字符串特判。
- 每次 Model 执行在进入 Executor 前拥有完整合法 Options；缺失不会到达网络层。
- Reasoning JSON 编辑器已被紧凑有序标签编辑器完全替代，Max Output 页面只编辑 `max`。
- Air 正式包复现的合法 Max Output 误报已经由单测和桌面交互测试永久覆盖。
- 弹窗成功与失败反馈不存在两套独立视觉实现，长内容下反馈始终可见且错误原因准确。
- 定向单测、受影响 E2E、`pnpm typecheck`、`pnpm lint`、`pnpm test:unit`、Desktop E2E typecheck 和相关容器验证通过。
- `git diff --check` 和本轮修改文件格式检查通过。
- 完成实现 review，确认没有遗留 default fallback、第二套选择事实或按模型硬编码。
- 最后提交 Conventional Commit；本 Todo 建议实现提交主题：`refactor(provider): require explicit model option values`。

## 10. 与当前工作区工作的关系

- 当前工作区正在实施 Todo 55 Provider Template 改造。本 Todo 文件独立落盘，不修改或整理 Todo 55 的现有工作区改动。
- Todo 58 应在 Todo 55 的 Config/Resolver Schema 稳定后实施，避免同时修改 Built-in Release、Model Rule Schema 与 Settings baseline 造成冲突。
- 实施时以届时最新工作区为准重新执行影响扫描；Todo 55 若改变 Model Rule 的物理分组，只调整配置落点，不改变本文 Option 语义。

## 11. 2026-09-01 实施记录

本轮已经完成：

- Config、Schema、Built-in Release、Registry DTO、Active Model 与 Runtime 中的 Option Spec `default` 全部退役；严格 Schema 会拒绝旧字段；
- 普通 Selection 缺少 reasoning 时在统一解析边界补为 `values.at(-1)`，辅助低成本调用继续显式使用 `values[0]`；
- Active Model 不再从 Spec 物化执行值；最终请求在网络 I/O 前校验完整的 reasoning 与 max output；
- Provider 模型设置页用紧凑、可排序的标签编辑 Reasoning Enum，最大输出输入直接编辑 `max`；
- Built-in 与测试 Fixture 中不再保留旧 Option Spec `default`。全仓精确扫描只剩严格 Schema 拒绝旧字段的负向测试。

验证证据：

- `pnpm test:unit`：1501 个 Test Files 通过、1 个既有 skipped；12803 条 Tests 通过、25 条既有 skipped；
- `pnpm typecheck` 通过；
- `pnpm lint` 通过，仅保留仓库既有 warning；
- `pnpm --filter @zcode/desktop typecheck:e2e` 通过；
- 修改文件格式检查与 `git diff --check` 通过；
- 全仓 `pnpm fmt:check` 仍被既有 `apps/zcode-cli/tests/gb2312.js` 读取问题和 Electron 文档示例 HTML 阻断；
- `MP-UI-06` 已完成用例和类型校验；当前 Linux 环境缺少 `xvfb-run`，Chrome 在进入测试体前退出，因此实际 WDIO 记为 `blocked-environment`，不写成通过。

## 12. 后续裁决补充（2026-09-05）

- 所有真正进入 ModelFactory/Runtime 的 ModelSelection 都必须携带合法 reasoning；缺失不是执行层的默认值。
- 持久化选择或最近选择如果只剩 Provider/Model、缺少 reasoning，或 reasoning 已不属于当前 Spec，Composer 保留模型身份并清空档位，要求用户重新选择；不静默补最高档，也不弹泛化的“选择失效”通知。
- 新建草稿在没有可靠历史值时仍可按普通入口规则取 `values.at(-1)`；这与修复已有失效持久化选择是两种场景。
- Title、Goal、Memory、Connectivity 等明确的低成本辅助调用仍显式使用 `values[0]`；该策略不属于普通 ModelSelection 默认值，连接测试也遵循这一低成本策略。
