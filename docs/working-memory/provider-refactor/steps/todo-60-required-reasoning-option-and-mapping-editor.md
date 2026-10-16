# Todo 60：Reasoning Option 全量化与 Mapping 编辑器收口

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：已完成（Desktop E2E 实跑受图形环境阻塞）
>
> 日期：2026-09-02
>
> 前置：Todo 54 已把公共 Option 映射收口到 Option Spec 自身；Todo 58 已删除 Option `default` 并固定 Reasoning `values` 从低到高。本 Todo 覆盖 Todo 58 中“Reasoning Spec 可选、Mapping 不开放编辑”的旧结论。

## 1. 目标

每个完整 Effective Model Config 都必须声明 `reasoningLevel` 和 `maxOutputTokens`。Reasoning 不再作为可选能力；不支持推理的模型统一用唯一的 `disabled` 档位和空 Request Body Patch 表达。

```text
Effective Model Config
├─ reasoningLevel
│  ├─ type = enum
│  ├─ values = 非空、从低到高
│  └─ map = 可编译的 Request Body Patch 表达式
└─ maxOutputTokens
   ├─ type = limit
   ├─ max = 正整数
   └─ map = 可编译的 Request Body Patch 表达式
```

无推理模型的规范表示：

```json
{
  "reasoningLevel": {
    "type": "enum",
    "values": ["disabled"],
    "map": "{}"
  }
}
```

`"{}"` 表示产生空 JSON Merge Patch。空字符串不是合法 Mapping，不为它增加特殊解析分支。

## 2. 执行值契约

完整 Model Selection / Active Model 必须携带具体 `reasoningLevel`。Model Request 中的 Option 仍可作为单次覆盖而缺省，但进入 Executor 前合并结果必须完整。

```text
普通选择确实缺省
└─ reasoningLevel = values.at(-1)

Title / Goal / Git Commit / Memory / Connectivity / WebSearch / WebFetch /
Read Session Context 等辅助调用
├─ reasoningLevel = values[0]
└─ maxOutputTokens = min(5000, optionSpecs.maxOutputTokens.max)
```

辅助调用不得按 `off`、`disabled`、`nothink` 等名字猜测能力，也不得保留 `reasoningLevel === undefined` 的正常分支。缺少 Reasoning Spec 表示 Effective Model Config 不完整，模型不得进入 Registry。

Compact 与 Repo Wiki 不属于这里的低成本辅助调用：Compact 延续本轮冻结的 Active Model；Repo Wiki
使用用户为该生成任务显式选择的 Model Selection。二者都不能被辅助调用规则静默改写。

## 3. 固定 Thinking Budget 退役

Built-in Model Config Rules 中所有固定 `thinking.budget_tokens` / `budgetTokens` 映射退出。固定 Token Budget 是旧协议用法，不再作为 Reasoning 档位实现手段。

- 保留协议真正支持的 `thinking.type`、`reasoning_effort`、`output_config.effort` 等字段；
- 不支持或不需要请求参数的档位使用 `map: "{}"`；
- 删除固定预算数值 Fixture、请求快照和仍将档位解释为固定预算的现行设计文字；Telemetry 可以继续记录
  服务端响应实际返回的 thinking budget，但不能把它当作本地配置或预期请求值；
- 删除只为协调 thinking budget 与 max output 而存在的组合换算或校验；
- 不恢复按模型 ID 硬编码预算或推理强度。

历史研究材料可以保留其当时事实，但当前 Design、Built-in、测试和生产实现必须使用新契约。

## 4. Config 与 Registry

- Rule Input / Personal Model Config 继续是稀疏叶子 Overlay，允许只覆盖 `type/values/map/max` 中明确提供的字段；
- Effective Model Config 的 `optionSpecs.reasoningLevel` 与 `optionSpecs.maxOutputTokens` 都必填且完整；
- Resolver、Settings View、Registry DTO、跨进程协议与 Active Model 不再把 Reasoning Spec 声明为可选；
- Registry 完整性测试覆盖 Reasoning 缺失、空 values、缺 map、非法 map；
- Built-in 通用规则提供完整无推理基线，具体模型/API Rule 只覆盖其真实差异；
- Personal Overlay 的 `null`、JSON round-trip 和叶子覆盖语义保持现状。

## 5. 设置页

Reasoning 编辑区始终展示，不因当前 Effective Spec 缺失或只有一个档位而隐藏：

```text
推理档位（从低到高）

[ disabled ] [ low ] [ high ] [＋]

推理参数 Mapping
┌──────────────────────────────────────────┐
│ Personal map 是 value                    │
│ Inherited map 是 placeholder             │
└──────────────────────────────────────────┘
```

### 5.1 档位编辑

- `＋` 始终显示；
- Chip 支持新增、重命名、删除、拖动排序和键盘操作；
- 至少保留一个非空、无重复值，最后一个值不能删除为空；
- 排序结果就是从低到高的 `values`；
- UI 不根据字符串推断最低、最高或关闭语义；
- 未修改时不把 Effective values 复制进 Personal Rule；修改后只写 Personal `values` 叶子；
- “全部恢复默认”清除 Personal `values` 与 `map` Overlay。

### 5.2 Mapping 文本框

- 使用普通技术文本框的背景、边框、圆角与焦点样式，不增加外层 Card；
- 固定高度、等宽字体、内部滚动；
- `value = personal reasoning map ?? ""`；
- `placeholder = inherited reasoning map ?? effective baseline map`；
- 清空已输入内容表示删除 Personal `map` Overlay并恢复继承；
- 关闭 spellcheck、autocorrect、autocapitalize 和 autocomplete；
- 保存时校验 Effective map 非空且可编译；错误进入弹窗现有统一反馈横幅；
- 桌面、Web 和手机端共用行为，窄屏自然换行，不制造页面横向滚动。

## 6. 测试计划

先写失败测试，再实现：

1. Config / Schema：Reasoning Spec 在 Effective Config 中必填；无推理基线 `disabled + {}` 合法；Overlay、`null`、round-trip 不回归。
2. Resolver / Registry：缺 Reasoning、空 values、缺 map 或非法 map 不进入 Registry；完整 Spec 原样进入 Active Model。
3. Selection / Runtime：普通缺省取最后一项；辅助调用统一取第一项并使用 `min(5000,max)`；不存在 Reasoning undefined 正常分支。
4. Built-in：每个模型都解析出完整 Reasoning/Max Output Spec；正式 JSON 不包含 `budget_tokens`；Option Map 试跑所有档位。
5. UI unit：无论当前档位数量如何都显示 `＋`；Mapping 的 Personal value / Inherited placeholder 正确；清空恢复继承；保存形成稀疏 Overlay；无效 Mapping 显示统一错误横幅。
6. UI E2E：新增 Personal 模型、编辑/排序档位、覆盖 Mapping、恢复默认、取消不提交；覆盖桌面与窄屏布局。
7. 回归：Title、Goal、Git Commit、Memory、Connectivity、普通 Session、Automation、Repo Wiki 和 Subagent 的 Option 选择一致。

最终运行受影响包单测/typecheck、根 `pnpm typecheck`、`pnpm lint`、`pnpm test:unit`、格式检查和相关 Desktop E2E。图形环境不可用时必须明确记录未跑项，不能伪装通过。

## 7. 完成标准

- 生产领域中不存在可选 Reasoning Spec；
- Built-in 与正式请求 Mapping 中不存在固定 thinking budget；
- 所有辅助调用使用同一条 `values[0] + min(5000,max)` 规则，不复制不同 fallback；
- 设置页能够从既有基线编辑档位与 Mapping，`＋` 始终可见；
- Personal Mapping 使用 value / inherited placeholder 的既有 Overlay 交互；
- 没有新增 Reasoning Policy、Budget Resolver、Capability DTO 或具体模型运行时 hardcode；
- 定向与全量验证通过并完成 Conventional Commit。

## 8. 实施结果

- Effective Model Config、Registry、Active Model 创建和 Adapter 执行边界已经统一要求完整
  `reasoningLevel` 与 `maxOutputTokens`；旧 Selection 仅在 Host 初始选择边界补齐最高档。
- Built-in 通用规则提供 `disabled + {}` 基线；所有现行 Built-in Reasoning Mapping 已删除固定
  `thinking.budget_tokens`。
- 新增唯一的辅助 Model Options helper，Title、Goal、Git Commit、Memory、Connectivity、WebSearch、
  WebFetch 与 Read Session Context 统一使用 `values[0] + min(5000,max)`。
- 设置页始终展示 Reasoning 档位编辑器和新增按钮，并增加固定高度 Mapping 文本框；Personal Mapping
  使用 value，继承值使用 placeholder，清空即删除 Personal `map` 叶子。
- 修复 Subagent 历史选择中无效 reasoning 档位直接覆盖当前 Model Spec 的问题；现在统一按当前
  Model Spec 校验并回落到最高档。

### 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过，34 条仓库既有 warning、0 error。
- `pnpm test:unit`：12,809 通过、25 skipped；唯一失败的
  `componentCache` 符号链接归档用例单独复跑 6/6 通过，确认是并行环境波动。
- `pnpm --filter @zcode/desktop typecheck:e2e`：通过。
- `settings-ui-polish.test.ts`：生产构建成功，但当前 Linux 无 `DISPLAY` 且没有 `xvfb-run`，
  Chrome session 创建前退出；未把该环境失败记作功能通过。
