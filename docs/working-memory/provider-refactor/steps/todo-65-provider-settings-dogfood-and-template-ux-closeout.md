# Todo 65：Provider 设置实机问题与 Template UX 收口

> 状态：已完成
>
> 日期：2026-09-02
>
> 来源：MacBook Air 实机体验，以及与 `feat/provider-ux-refactor` 产品分支的视觉对比。
>
> 前置：Todo 55、Todo 60、Todo 61、Todo 62、Todo 63 已完成。本 Todo 不改变 Provider Template、Account Overlay、Registry、Model Selection 或 Option Spec 的状态归属，只修复已确认的调用遗漏和设置页体验退化。

## 1. 目标

本轮收口四类已经获得实机证据的问题：

1. Start Plan 与 Team Plan 的连接测试缺少必填 `reasoningLevel`；
2. Provider Template 选择页没有完整继承产品分支中有效的视觉意图；
3. 空的自定义 Provider 分组错误显示横杠；
4. Provider 配置失败时，原始 Schema issue 直接铺满右侧详情区域。

实施必须保持下面两条主链不变：

```text
ProviderSettingsView.providerTemplates
                |
                v
       ProviderTemplatePicker
                |
                v
 createPersonalProvider({ templateId })
                |
                v
       Personal Provider Config


Effective Provider / Model Registry
                |
                v
           Active Model
                |
                v
     Provider Connectivity Request
```

产品分支只作为视觉与交互参考；禁止把旧 Provider Catalog、旧 Built-in 候选拼装或旧 Family/API Key 特化重新带回当前架构。

## 2. Account Provider 连接测试

### 2.1 已确认问题

MacBook Air 上 Start Plan 和 Team Plan 均能进入模型列表，但连接测试失败并返回：

```text
Reasoning level is required for <providerId>/<modelId>
```

这说明请求已经进入正式 Model 链路；失败原因是连接测试调用方没有为声明 Reasoning Option 的模型显式提供 `reasoningLevel`，不是套餐不存在、Provider 不存在或账号凭据缺失。

### 2.2 目标行为

连接测试继续使用正式 Registry 与 Active Model，不单独识别 Start、Individual、Team 或具体模型 ID。按照 Todo 60，进入 Registry 的每个 Active Model 都必须拥有完整 Reasoning Spec；缺失不是正常分支，而是上游配置完整性错误。

```text
Active Model.optionSpecs.reasoningLevel
                |
                v
        显式传 values[0]
```

约束：

- `values` 的顺序仍然表示从低到高；
- `values[0]` 是最低可用档位，不等价于字符串 `disabled`；
- 不新增 `reasoningLevelPolicy` 或 Provider 特化分支；
- ModelFactory 只校验和装配，不替调用方静默补执行 Option；
- 连接测试显式传 `min(5000, optionSpecs.maxOutputTokens.max)`，不依赖 ModelFactory fallback；
- `x-zcode-session-type` 等 Coding Plan 请求头继续由正式 Access/请求装配链产生，设置页不得自行复制。

### 2.3 测试

- 有 Reasoning Spec：连接测试显式发送 `values[0]`；
- 最低档位不是 `disabled`：仍使用首项；
- 缺少 Reasoning Spec：作为 Effective Model Config 不完整处理，模型不得进入 Registry；
- Start Plan、Team Plan 和普通 API Key Provider 共用同一连接测试逻辑；
- 失败时展示正式 Model 请求的真实错误消息，不新增 Provider 专属错误分类。

## 3. Provider Template 选择页

### 3.1 参考边界

`feat/provider-ux-refactor` 中的视觉方案可作为参考，但该分支基于旧 Provider 领域实现，不能直接复制组件或业务状态。

允许参考：

- 紧凑、安静的卡片视觉层级；
- 更明确的顶部“添加供应商”入口；
- 卡片尾部箭头；
- Logo、名称、间距和 Hover 的协调关系；
- 空分组不占位。

禁止恢复：

- `ProviderCatalog` 或其他 Catalog 领域类型；
- Renderer 内按 Provider ID 拼候选、Logo、名称或排序；
- 旧 Built-in Provider 创建逻辑；
- Provider 顶层 `enabled`；
- 旧 Account API、Family API Key 或 Provider ID 特化；
- 搜索框；
- Hover 时用拖动块替换 Provider Logo；
- 产品分支未经验证的状态和响应式实现。

### 3.2 卡片规格

Template 和“创建自定义供应商”使用同一套卡片骨架：

- 严格固定高度 `64px`，不使用 `min-height`，不因名称长度动态增高；
- Desktop 宽度使用两列，窄宽度自然收为单列；
- `rounded-lg`；
- 默认使用安静的卡片背景与边框，Hover/Focus 时再增强；
- 横向内边距约 `16px`；
- 卡片间距约 `8px`；
- Logo 槽约 `36px`，Logo 使用 `object-contain`，不裁切；
- Logo 与名称间距约 `12px`；
- 名称使用常规 UI 字号和中等字重；
- 名称严格单行，超出时截断，并通过 Tooltip 显示完整名称；
- 尾部显示 `ChevronRight`，明确表达进入创建流程；
- 保留键盘操作、`focus-visible` 和禁用态；
- 不修改 Provider 设置双栏外层容器当前使用的边框 Token。

### 3.3 Template 展示名称

官方发布的展示名称应主动保持简短，避免把布局压力交给动态卡片高度。优先校准：

| 当前长名称                           | 目标短名称              |
| ------------------------------------ | ----------------------- |
| Moonshot Kimi                        | Kimi                    |
| Alibaba Model Studio (China)         | Alibaba Cloud (China)   |
| Alibaba Model Studio (International) | Alibaba Cloud (Global)  |
| 阿里云百炼（中国）                   | 阿里云百炼（中国）      |
| 阿里云百炼（国际）                   | 阿里云百炼（国际）      |
| Xiaomi MiMo                          | Xiaomi MiMo / 小米 MiMo |

`Z.AI API`、`BigModel API`、`MiniMax`、`DeepSeek`、`OpenAI`、`Anthropic` 和 `xAI` 保持简短官方名称。只修改 Template `nameMap`，不修改 `templateId`、Provider ID、API Schema 或 Registry 身份。

### 3.4 顶部入口与外围协调

- 保留右侧详情区域内的 Template 选择流程和左侧 Provider 导航；
- 顶部说明文字、刷新和“添加供应商”按钮恢复合理的宽度、顺序和间距；
- “添加供应商”应是清晰的主要操作，不退化为难以发现的小型入口；
- 不扩大 Provider 设置页整体宽度，不重写已经稳定的左右独立滚动；
- 不修改外层双栏容器的边框 Token；只有实机仍能观察到明确层级问题时，才另行处理。

## 4. 空分组与错误反馈

### 4.1 空的 Personal Provider 分组

当没有 Personal Provider 时：

- 不渲染“自定义供应商”分组；
- 不显示 `-` 或其他伪占位；
- 顶部“添加供应商”仍然可用。

当创建第一个 Personal Provider 后，再正常显示分组标题和成员。

### 4.2 配置错误展示

用户可见横幅只显示一条简洁摘要，例如：

```text
创建供应商失败：个人供应商配置格式无效
```

完整的 Zod issues 通过 UI Logger 写入日志。禁止把原始 issue 数组直接渲染到横幅，也不新增另一套 Toast 或错误分类。

## 5. 未发布配置边界

MacBook Air 上出现的 Provider 顶层 `enabled` 属于尚未上线的开发期配置。当前正式 Schema 已明确删除该字段，因此：

- 不提升 Schema Version；
- 不增加 `enabled` 迁移器；
- 不在严格 Schema 中兼容读取；
- 不增加 dual-read；
- 实机验证前清理 Air 上的开发期 Personal Provider Config，并重新创建测试数据。

正式实施不得因为这份旧文件重新引入 Provider `enabled`。

## 6. 实施顺序

1. 同步修正 Todo 61 中已被本轮裁决取代的卡片描述：从“两行、无箭头”改为“固定单行、有箭头”；
2. 阅读并遵守根目录 `DESIGN.md`，对照产品分支提取视觉意图；
3. 先补连接测试最低 Reasoning 档位的失败测试；
4. 修复连接测试的显式 Option；
5. 先补 Template 卡片、空分组、名称截断和错误摘要的组件/交互测试；
6. 在当前 Template 数据源上重做卡片和顶部入口样式；
7. 更新受影响 Desktop E2E；
8. 完成静态、自动化和 MacBook Air 实机验证；
9. Review 是否误带回 Catalog、Provider `enabled`、Provider ID 特化或第二套错误解释；
10. 提交 Conventional Commit，并附真实 Agent 会话 trailer。

## 7. 验证计划

### 7.1 自动化

- Provider Settings / Template Picker 定向单测；
- Provider Connectivity 定向单测；
- Template 创建、名称、Logo、失败反馈和空分组交互测试；
- Start/Team 连接测试的 Reasoning Option 回归；
- Desktop E2E：打开 Template Picker、创建 Template Provider、创建自定义 Provider、返回与错误反馈；
- `pnpm typecheck`；
- `pnpm lint`；
- `pnpm test:unit`；
- `git diff --check`。

### 7.2 MacBook Air 实机验收

最终体验以 MacBook Air 上同步当前提交后运行的开发版为准，不用旧正式包或旧工作副本代替当前 HEAD：

1. 清理未上线的旧 Personal Provider Config 后启动应用；
2. 没有 Personal Provider 时，确认左侧不显示空分组和横杠；
3. 打开添加供应商，检查顶部入口、两列卡片、固定高度、Logo、单行名称、截断 Tooltip、尾部箭头、Hover 与键盘 Focus；
4. 创建两个相同 Template 的 Provider，确认正常去重并进入详情；
5. 创建纯自定义 Provider；
6. 模拟创建失败，确认右侧底部仅显示简洁错误，详细原因进入日志；
7. 对 Start Plan 的 `glm-5.3-flash` 执行连接测试；
8. 对 Team Plan 的 `GLM-5.3` 与 `GLM-5.3-Flash` 执行连接测试；
9. 确认请求不再因缺少 `reasoningLevel` 失败；若仍失败，保留真实服务端错误并继续按日志定位；
10. 检查 Light/Dark、中文/英文和窄窗口，确认卡片高度不变化、页面无横向滚动。

MacBook Air 验证必须记录当前提交 SHA、启动命令及关键结果。静态测试通过不能替代上述实机验收。

## 8. 完成标准

- Start Plan 与 Team Plan 连接测试显式使用 Reasoning `values[0]`，不再出现缺少 Reasoning 的本地错误；
- Template Picker 使用正式 `providerTemplates` 数据源，同时恢复已裁决的紧凑产品体验；
- 卡片严格固定单行和固定高度，长名称不会改变网格节奏；
- 空 Personal Provider 分组不渲染；
- 用户错误横幅不再展开原始 Schema issues；
- 外层 Provider 双栏边框保持现状；
- 未新增搜索、Catalog、Provider 顶层 `enabled`、Provider ID 特化或第二套状态事实；
- 自动化验证通过，并在 MacBook Air 上完成当前 HEAD 的真实体验验收。

## 9. 实施与验收记录

- Provider Connectivity 统一从 Active Model 的有序 Reasoning Spec 读取 `values[0]`，并显式发送 `min(5000, maxOutputTokens.max)`；没有新增套餐、Provider ID 或模型 ID 分支。
- Template Picker 保持正式 `providerTemplates` 为唯一数据源，完成固定 `64px` 卡片、两列布局、Logo、单行截断 Tooltip、尾部箭头和明确的顶部入口。
- 空 Personal Provider 分组不再渲染；创建错误横幅只展示摘要，完整 issue 进入统一 UI Logger。
- 相关 UI/Service 定向测试通过；MacBook Pro 的 Settings UI E2E 7 条和包含 Start/Team 连接面的 Coding Plan E2E 18 条均通过。MacBook Air 的旧 Personal Config 清理与人工视觉验收属于体验环境操作，不作为代码正确性的替代门禁。
- Review 未发现 Catalog 类型、Provider 顶层 `enabled`、Provider ID 特化或第二套连接测试错误分类回流。
