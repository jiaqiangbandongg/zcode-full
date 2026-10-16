# Todo 66：Option Map 变量命名与展示排版收口

> 状态：已完成
>
> 2026-09-09 补充：后续 Todo95 引入部分单行排版回归，由 [Todo98](todo-98-builtin-option-map-formatting-regression.md) 修复；当前写作准则见 [Option Map 写作风格](../design/model/option-map-writing-style.md)，简单三目保持同行。下文示例为历史实施记录，不要求恢复已被简化的重复分支。
>
> 日期：2026-09-02
>
> 前置：Todo 54 已将请求 Option 映射收口到 Option Spec 的 `map`；Todo 60 已固定 Reasoning Option 的完整性和 GUI 编辑边界。本 Todo 只改善 Map 表达式的命名与可读性，不改变 Option、Model Config、Adapter 或请求参数的职责。

## 1. 目标

完成两项小范围收口：

1. Option Map 不再使用含义模糊的通用变量 `value`，改为使用所属 Option 的正式名称；
2. Built-in Option Map 的换行和缩进以设置页 GUI 中的阅读体验为准，不再为了让配置文件内容保持单行而牺牲可读性。

```text
optionSpecs.<optionName>.map
              |
              v
表达式变量名 = <optionName>
              |
              v
编译为本次请求的 JSON Merge Patch
```

## 2. 变量命名

当前写法：

```ts
value == "high"
  ? { "reasoning_effort": "high" }
  : { "reasoning_effort": "max" }
```

目标写法：

```ts
reasoningLevel == "high"
  ? { "reasoning_effort": "high" }
  : { "reasoning_effort": "max" }
```

具体对应关系：

```text
optionSpecs.reasoningLevel.map
└─ 变量：reasoningLevel

optionSpecs.maxOutputTokens.map
└─ 变量：maxOutputTokens
```

规则：

- 变量名直接取所属 Option 的正式字段名，大小写一致；
- 每个 Map 只消费自己的 Option 值，不顺便暴露其他 Option；
- 删除 `value` 变量，不保留别名、兼容读取或双语法；
- 未发布配置不增加迁移器；
- Map 的输出仍然是当前请求使用的 JSON Merge Patch，职责不变。

## 3. Built-in Map 排版

Built-in Map 的字符串内容应优先保证设置页文本框中的可读性。

复杂条件和嵌套对象使用换行与缩进，例如：

```ts
reasoningLevel == "low"
  ? {
      "thinking": {
        "type": "adaptive"
      },
      "output_config": {
        "effort": "low"
      }
    }
  : {
      "thinking": {
        "type": "adaptive"
      },
      "output_config": {
        "effort": "max"
      }
    }
```

简单表达式可以保持单行：

```ts
{ "max_tokens": maxOutputTokens }
```

排版原则：

- 使用统一的两空格缩进；
- 复杂条件分支分行；
- 多层对象展开，避免 GUI 中出现很长的一行；
- 简单 Map 不机械展开；
- 允许 `zcode-builtin.json` 中出现换行转义，物理文件的紧凑程度不是目标；
- GUI 继续原样展示字符串中的换行和缩进，不增加第二套格式化结果；
- Personal Map 不强制自动重排，避免在保存时意外改写用户输入。

## 4. 实施范围

1. 修改 Option Map 编译环境，使变量名来自所属 Option 名称；
2. 更新 Schema、类型和当前 Design 中仍把变量写成 `value` 的说明；
3. 将 Built-in Config 中所有 `value` 引用切换为对应的 Option 名称；
4. 整理 Built-in 中较长的 Reasoning Map 的换行和缩进；
5. 保持简单 Max Output Map 为紧凑单行；
6. 更新 GUI placeholder/value 相关测试，证明格式会在文本框中保留；
7. 删除只服务于旧 `value` 名称的常量、测试 Fixture 和错误文案。

## 5. 测试边界

本轮不做每条 Built-in Map 在迁移前后逐一执行、逐字段比较的全量等价性测试。变量替换和排版都是确定性修改，不建立一次性、维护成本较高的迁移证明框架。

只保留必要证据：

- 编译器接受所属 Option 名称；
- 编译器拒绝旧 `value`；
- `reasoningLevel` 和 `maxOutputTokens` 各有代表性 Map 编译与请求 Patch 测试；
- Built-in Config 能通过正式 Schema 和 Map 编译检查；
- 设置页能保留 Built-in Map 的换行和缩进；
- Personal Map 的原始排版不会在读取或保存时被自动改写；
- `pnpm typecheck`、`pnpm lint`、相关单测和 `git diff --check` 通过。

## 6. 非目标

- 不改变 Option Spec 的字段结构；
- 不改变 Reasoning 档位顺序；
- 不改变 `maxOutputTokens.max` 的能力上限语义；
- 不新增 Map DSL、Formatter Service 或版本化表达式协议；
- 不允许一个 Option Map读取其他 Option；
- 不重新设计 Model 设置弹窗；
- 不为未发布的 `value` 语法增加兼容层。

## 7. 完成标准

- 正式代码、Built-in Config、测试和当前 Design 中不再使用 Option Map 通用变量 `value`；
- `reasoningLevel` Map 使用 `reasoningLevel`，`maxOutputTokens` Map 使用 `maxOutputTokens`；
- Built-in 复杂 Map 在 GUI 中具有清晰换行和缩进；
- 简单 Map 保持简洁，Personal Map 不被自动重排；
- 没有新增兼容分支、第二份 Map 表达或过度的全量等价测试设施。

## 8. 实施与验收记录

- 编译器现在按所属 Option 注入唯一变量名，并将变量名纳入编译缓存键；同一表达式不能借缓存绕过另一 Option 的变量边界。
- Schema、完整性校验、Built-in Config、CLI/Service/UI 测试夹具和当前 Design 已统一到 `reasoningLevel` / `maxOutputTokens`；旧 `value` 只保留在拒绝测试和历史记录中。
- Built-in 的复杂 Reasoning Map 已改为两空格多行格式，简单 Max Output Map 保持单行；Personal Map 没有新增格式化步骤。
- Provider Node 中原先锁死单行空白的断言已改为验证变量和映射内容，避免把展示排版误当运行时契约。

验证结果：

- `@zcode/model-option-map`：26 tests passed；typecheck passed。
- `@zcode/provider`：167 tests passed；typecheck passed。
- `@zcode/provider-node`：47 tests passed；typecheck passed。
- CLI Adapter 定向：54 tests passed。
- CLI Bootstrap Registry/Model 定向：83 tests passed。
- UI、Services、Server 定向：144 tests passed；UI 默认配置展示补充用例 11 tests passed。
- `git diff --check` passed。
