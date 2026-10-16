# AskUserQuestion Tool

TUI 落地规划见 [AskUserQuestion TUI 规划](../tui-ask-user-question.md)。

## 定位

`AskUserQuestion` 在执行过程中向用户提出选择题，用于澄清需求、收集偏好或让用户做实现决策。

## 输入契约

`AskUserQuestion` 输入是严格对象：

| 字段          | 类型                        | 必填 | 说明                   |
| ------------- | --------------------------- | ---- | ---------------------- |
| `questions`   | `Question[]`                | 是   | 1 到 4 个问题          |
| `answers`     | `Record<string,string>`     | 否   | 权限组件回填的用户答案 |
| `annotations` | `Record<string,Annotation>` | 否   | 用户对选择的附加说明   |
| `metadata`    | object                      | 否   | 追踪来源，不展示给用户 |

`Question`：

| 字段          | 类型               | 必填 | 说明                               |
| ------------- | ------------------ | ---- | ---------------------------------- |
| `question`    | `string`           | 是   | 完整问题，应该清晰具体，以问号结尾 |
| `header`      | `string`           | 是   | 很短的 chip/tag，最大 12 字符      |
| `options`     | `QuestionOption[]` | 是   | 2 到 4 个选项                      |
| `multiSelect` | `boolean`          | 否   | 是否允许多选，默认 `false`         |

`QuestionOption`：

| 字段          | 类型     | 必填 | 说明                   |
| ------------- | -------- | ---- | ---------------------- |
| `label`       | `string` | 是   | 1 到 5 个词的显示文本  |
| `description` | `string` | 是   | 选项含义或取舍说明     |
| `preview`     | `string` | 否   | 聚焦该选项时展示的预览 |

输入还有唯一性约束：

- `question` 文本必须唯一。
- 同一个问题内 option label 必须唯一。
- 不应提供 `Other` 选项，UI 会自动提供。

## 输出契约

输出：

| 字段          | 类型                    | 说明                                         |
| ------------- | ----------------------- | -------------------------------------------- |
| `questions`   | `Question[]`            | 实际询问的问题                               |
| `answers`     | `Record<string,string>` | 用户答案，key 是问题文本，多选答案用逗号分隔 |
| `annotations` | optional record         | 选项 preview 和用户 notes                    |

模型可见结果会转成一句说明：用户已经回答这些问题，后续可基于答案继续执行。每个答案按 `"question"="answer"` 序列化，并可附带 preview 和 notes。

`answers` 表达用户实际提供的答案，不表达表单必填约束：

- 全部回答时包含所有问题的 key。
- 部分回答时只包含已回答问题，未回答问题不写入空字符串。
- 用户主动提交但没有回答任何问题时使用空对象 `{}`，让模型根据现有信息继续。
- `answers` 字段完全缺失表示权限组件尚未完成交互，tool handler 不能提前执行。

## 行为语义

核心流程：

1. 模型提交 1 到 4 个问题和 2 到 4 个选项。
2. tool 自身 `checkPermissions` 永远返回 ask，用权限 UI 承担交互。
3. 用户在 UI 中选择任意数量的答案，可跳过部分或全部问题，也可输入 Other 或 notes。
4. 权限组件把 `answers` 和 `annotations` 回填到 updated input。
5. tool `call` 只回传问题和答案，不做外部 I/O。
6. tool result 进入模型上下文，agent 继续执行。

工具声明为：

- `shouldDefer: true`
- `isReadOnly: true`
- `isConcurrencySafe: true`
- `requiresUserInteraction: true`

ZCode 应把 `requiresUserInteraction` 作为调度层一等能力：非交互 session、远程 channel 或后台 agent 不能直接卡住等待 TUI。

## Prompt 约束

ZCode 为 `AskUserQuestion` 提供完整的 tool prompt 语义，而不是只给模型一行
短描述。provider-visible tool description 应由短 `description` 加 `modelInstructions`
组成，投影后至少表达：

- 这是执行过程中向用户提问的工具。
- 它可用于收集用户偏好或需求、澄清歧义、获取实现决策，以及提供后续方向选择。
- 用户总能选 Other 输入自定义文本。
- 多选问题使用 `multiSelect: true`。
- 推荐选项放第一个，并在 label 后加 `(Recommended)`。
- plan mode 中只能用于计划定稿前澄清需求或选择方案；计划审批应走专用 plan
  approval flow/tool，不能用 `AskUserQuestion` 问“计划是否可以执行”。

模型使用规则：

- 用于收集偏好、澄清歧义、获取实现决策或给用户选择方向。
- 用户总能选 Other 输入自定义文本。
- 推荐选项放第一个，并在 label 后加 `(Recommended)`。
- 多选问题设置 `multiSelect: true`。
- plan mode 中只能用于计划定稿前澄清需求或选择方案。
- 不应用它问计划是否可以执行，计划审批应该走专用 plan approval 工具。
- 不要在用户还看不到计划时引用「这个计划」。

ZCode 应把 plan approval 和 clarification 分开，避免 AskUserQuestion 被滥用成通用确认按钮。

## Preview 约束

preview 支持 markdown 或 HTML，取决于运行环境配置。

Markdown preview 可用于：

- UI mockup ASCII 草图。
- 代码片段。
- 图表变化。
- 配置例子。

HTML preview 可用于：

- HTML mockup。
- 格式化代码片段。
- 视觉对比或图表。

HTML preview 校验：

- 必须是 fragment，不能有 `<html>`、`<body>` 或 `<!DOCTYPE>`。
- 不能包含 `<script>` 或 `<style>`。
- 必须包含 HTML tag。

preview 只适合单选问题，不适合简单偏好问题或 multiSelect 问题。

实现核对（2026-05-08）：`packages/contracts/src/tools/ask-user-question.ts` 已在
`AskUserQuestionOptionSchema` 内执行 preview 校验。普通 markdown preview 原样通过；检测到
HTML / doctype / comment 形态时，runtime schema 要求它必须是 HTML fragment，拒绝
`<!DOCTYPE>`、`<html>`、`<body>`、`<script>`、`<style>`，并拒绝只有 HTML comment 而没有
可渲染 tag 的 preview。覆盖测试见 `packages/contracts/tests/ask-user-question.test.ts`。

## 权限和会话模型

`AskUserQuestion` 本质上是用户交互 tool，不是传统权限申请：

- 每一道题都允许不回答。桌面端的选项焦点只用于键盘导航，只有明确点击、空格或 Enter 选中才写入答案；直接点击“继续”或“提交”表示跳过当前题。
- Bot 单选菜单必须提供独立“跳过”操作；跳过中间题后继续下一题，跳过最后一题则提交当前部分答案，全部跳过时提交 `{ answers: {} }`。

- `checkPermissions` 返回 `ask` 是为了复用 permission request UI。
- 用户拒绝时需要产生明确的 rejected projection。
- 当远程 channel 模式启用且用户不在 TUI 时禁用该 tool，防止无人响应导致会话挂起。

ZCode 应将它实现为 `UserInteractionPort`：

- 支持 TUI、SDK、远程 channel 三种交互承载。
- pending prompt 必须是 session 状态，可恢复、可取消、可审计。
- 每个问题、选项、答案都必须归属当前 `traceId` 和 `turnId`。
- 非交互环境应直接禁用或返回结构化错误，不能无限等待。

## 校验与错误

关键失败路径：

- questions 数量不是 1 到 4。
- options 数量不是 2 到 4。
- question 重复。
- option label 重复。
- HTML preview 包含完整 document、script、style 或没有 HTML tag。
- 非交互环境无法显示问题。
- 用户拒绝回答。
- prompt 被取消或 session 恢复时找不到 pending prompt。

这些应区分为 schema error、preview validation error、interaction unavailable、user rejected、prompt cancelled。

## ZCode 设计结论

`AskUserQuestion` 是 NL-to-code 过程里的「需求澄清」接口。它不应该只是一个权限弹窗：

- contract 层定义 `QuestionSet`、`QuestionOption`、`UserAnswer`、`QuestionAnnotation` schema。
- core 层创建 pending interaction event。
- UI/SDK/channel 通过 interaction adapter 回填答案。
- tool result serialization 只把答案摘要交给模型。
- 计划审批、危险操作确认、普通偏好选择需要不同 capability，不能全部塞进一个 ask tool。

## 当前实现核对（2026-05-08）

已落地的 MVP 主线：

- contract 层已暴露 `AskUserQuestion` 的 runtime schema、JSON Schema、TypeScript
  类型、答案校验和 preview annotation schema。
- core 层已注册 `AskUserQuestion` 内置 tool，并把 `requiresUserInteraction`、只读、
  低风险、`userInteraction` side effect scope、timeout、cancellation、result budget
  和 runtime output schema 投影到 tool contract。
- permission/runtime 层已识别 `requiresUserInteraction`，不会把它当成普通自动 allow
  工具执行；当前仍通过 permission broker 的 `modify` result 回填答案。
- TUI 层已支持单选、多选、自动 Other 自定义文本、拒绝、取消、纯文本 preview、
  preview annotation 回填、多问题 review tab 和 composer draft 保留。
- ZCode app-server 层已通过 `zcode.dev/elicitation/create` 扩展承载 `AskUserQuestion`，并把
  elicitation response 转成 `modifiedInput.answers` / `annotations`。
- tool handler 只接受权限组件已经回填 `answers` 字段的输入；字段缺失时返回结构化可恢复
  tool execution failure。`answers` 可以是完整、部分或空对象，未回答问题不伪造偏好。

仍未完成的架构收口：

- 独立 `UserInteractionPort`、`pendingUserInteractions` session projection 和
  requested/answered/rejected/cancelled 事件尚未落地。
- session resume 后继续回答 pending question、SDK/HTTP/plugin list/reply/reject
  仍按后续阶段推进。
- TUI 对 markdown/html preview 只做纯文本展示；完整 HTML sandbox、富渲染、图片粘贴、
  plan interview 特殊按钮和 analytics 事件不在当前 MVP 内。

## MVP 开发范围

第一版先落地可恢复、可审计、不会被自动权限模式绕过的核心交互闭环：

- contract 层暴露 `AskUserQuestion` 的 runtime schema、JSON Schema 和 TypeScript 类型。
- core 层注册 `AskUserQuestion` 内置 tool，并把它投影给模型。
- permission/runtime 层识别 `requiresUserInteraction`，即使在 `yolo` 模式也必须进入交互 broker，不能自动 allow。
- TUI 层支持单选、多选、自动 Other 自定义文本、拒绝、取消、文本 preview、preview
  annotation 和多问题 review。
- tool handler 只接受权限组件已经回填 `answers` 字段的输入；字段缺失时返回结构化失败。
  用户可提交完整、部分或空答案，未回答问题由模型使用最佳判断处理。
- markdown/html preview 字段作为契约字段透传；第一版 TUI 显示文本 preview，不做富渲染。

第一版暂不实现图片粘贴、plan interview 特殊按钮、完整 HTML preview sandbox 和 analytics 事件；这些能力必须沿用同一 `Question` / `Annotation` 契约逐步扩展。

最低测试集：

- 单选、多选、Other。
- 1 到 4 个问题边界。
- 选项数量边界。
- 重复问题和重复 label。
- markdown preview 和 HTML preview 校验。
- 用户拒绝。
- 部分回答和零回答。
- 非交互 session。
- session 恢复后继续回答 pending question。
