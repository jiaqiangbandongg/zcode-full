# Provider Settings 体验问题记录（2026-08-27）

## 1. 用途

本文记录 Provider Refactor 首轮 macOS 实包体验中发现的问题。处理原则：

- 不改变既有 Provider / Model Config、Overlay、Registry 抽象的问题直接修复并由测试固定；
- 涉及 Account Overlay、套餐权益或模型可用性事实来源的问题只记录运行时证据和代码边界，等待裁决；
- 不用 UI 兜底、强制启用或绕过 Resolver 掩盖领域问题。

## 2. 已直接修复

| 问题 | 根因 | 修复后的契约 |
| --- | --- | --- |
| 历史 Provider 重名阻断无关保存 | 保存时对整个 Effective Provider 集合重新执行唯一性门禁，迁移遗留的既有重名会阻断任意 Provider | 只禁止本次名称变更新引入重名；既有历史重名不阻断其他保存 |
| 空 Base URL 无法保存草稿 Provider | Renderer 把空输入序列化为 `baseURL: ""`，在 Resolver 判断完整性之前就被 URL Schema 拒绝 | 空值不写 `baseURL`；Provider 可以保存但不可执行，非空非法 URL 仍拒绝 |
| Provider / Model 整行不能拖动 | Provider 依赖独立 grip；Model 的自定义 Pointer Sensor 又把 `useSortable` 自动添加的行级 `role=button` 误判为交互控件 | Provider、Model 的名称、图标及非交互空白都可启动整行拖动，真实控件除外，拖动时禁止选中文字 |
| 模型弹窗可穿透拖动背景模型 | Radix Dialog 通过 Portal 渲染，但 React 事件仍沿组件树冒泡到模型行的 DnD activator | Dialog content、overlay 和显式 `data-no-model-drag` 区域都不能启动背景排序 |
| 模型行信息与开关排列混乱 | 摘要和操作没有稳定布局边界 | Context 紧跟 Model ID；开关固定在模型行最右侧；模型行不提供单字段“恢复默认” |
| Provider 启停重复展示 | 状态标签和操作按钮分别占位 | 一个按钮同时表达当前状态并执行切换 |
| 模型编辑器把继承值伪装成 Personal 输入 | Draft 使用 Effective Config 初始化；JSON 又额外重复展示只读值 | Personal 输入为空时，继承值只作为 placeholder；删除重复只读 JSON 区 |
| 模型编辑器层级过深且接近全屏 | 常用字段混在“高级”折叠中，弹窗最大高度接近整个视口 | 去掉“高级”；桌面使用居中的中等最大高度并仅滚动内容区 |
| 模型编辑器字段顺序不符合使用频率 | Max Output、输入输出格式排在能力和复杂 JSON 后 | `Model ID/启用 -> Context -> Max Output -> 输入 -> 输出 -> 能力 -> 复杂配置` |
| 只能逐字段恢复继承值 | 缺少模型级清空 Personal Overlay 的入口 | Footer 提供“全部恢复默认”，清空该模型的 Personal Model Config Overlay 后再由用户保存 |
| 国内 Provider 在新增菜单靠后 | 菜单直接使用 Built-in 配置顺序，旧顺序把海外 Provider 放在前面 | Built-in 配置及新增菜单统一先列国内 Provider，再列海外 Provider |

## 3. Personal Config 来源与 Official 名称核对

Pro 机器保留的迁移前备份与清理前备份证明：

```text
旧 ~/.zcode/v2/config.json.provider
        |
        | Provider V1 importer
        v
新 config.json.providers + modelConfigRules
```

清理前的 Personal Config 不是新的 Official Config 内容本身，而是迁移器把旧配置投影进新 Personal Overlay 后留下的结果，
其中同时包含：

- 旧版本可编辑的 `builtin:*` Provider 配置；
- 用户创建的自定义 Provider；
- 用户对标准 Provider 顺序、模型成员和模型属性的 Personal 覆盖。

因此截图中的旧 Coding Plan 重名属于迁移遗留，不是当前 Official Config 又创建了一份同名 Provider。当前
`config/provider/zcode-builtin.json` 的 Provider label 已核对为唯一；Z.ai / BigModel 的 API、Individual、Team、Start、
Idle Plan 使用不同名称。为继续体验而执行的 Personal Config 清理保留了带时间戳备份，可恢复。

## 4. 待裁决：Team Plan 有效但 Account Provider / 权益展示不可用

### 4.1 运行时事实

Pro 的 `~/.zcode/v2/logs/2026-08-27.log` 在同一次 Team Plan 选择之后同时出现：

- Settings 已持久化 `bigmodel -> team-coding-plan`，并包含 product、organization、project；
- Team Plan 项目校验命中所选项目，机构列表非空；
- Team Plan quota 接口返回业务成功且有额度数据；
- 但 Usage entitlement 对 `account:bigmodel-team-coding-plan` 记录的 `organizationId/projectId` 都是 `null`，随后报告未找到可用授权；
- Registry 在此之前只发布了一个 Personal Provider，没有观察到 Team Account Provider 进入可执行集合。

这证明“账号确实有 Team Plan”与“页面显示获取失败”不是同一个上游请求的真假冲突，而是套餐选择事实进入不同消费者时发生了断裂。

### 4.2 当前链路

```text
setting.json
providerFamilyConnectionSelections.bigmodel
{ kind: team, organizationId, projectId, productId }
          |
          +-------------------------------+
          |                               |
          v                               v
Account Provider Resolver          Settings Usage entitlement
  -> Family availability             -> 从 ProviderSettingsView
  -> Team project/quota 成功             反查 Account Access
  -> 生成 Account Overlay             -> 实测得到 null org/project
          |                               |
          v                               v
Effective Provider / Registry       “暂时无法确认 Coding Plan 权益”
```

`createAccountProviderConnectionResolver()` 本身直接读取 Family selection，并在可用后才创建带 Team scope 的
`ZhipuAccountAccessConfig`。而 Renderer 的 `resolveAccountProviderAccess()` 只接受已经出现在
`ProviderSettingsView.effectiveConfig.access` 中、且能通过完整 Account Access Schema 的结果。也就是说，权益 UI
把 Account Overlay 的输出重新当作自己的访问输入；一旦 Overlay 没有成功发布完整 access，页面无法使用
`setting.json` 中已经存在的 Team selection 解释失败原因。

### 4.3 不能直接采用的修复

- 不能因为 Team quota 请求成功就在 Renderer 强制把 Provider 标为 enabled；这会绕过 Account Overlay。
- 不能让 Usage UI 自己拼一份新的 `accessId` 或 Account Config；这会产生第二套 Account Access 事实。
- 不能在 Registry 为空时回退到固定 Provider ID 或默认模型；这会破坏 Provider / Model 身份边界。

### 4.4 后续需要对齐的问题

1. Team selection 到 Account Overlay 发布之间究竟在哪一步丢失完整 access；需要给 Connection Result / Overlay 发布增加可观察证据并复现实测。
2. Usage entitlement 应继续消费 Effective Account Access，还是应消费账号连接域的选择事实；两者的职责需要统一，不能各自拼装。
3. Account Provider 已验证可用但未进入 Registry 时，Settings View 应如何同时呈现“套餐有效”和“Provider 不可执行”的诊断，而不是统一显示获取失败。

在这些问题裁决前，本轮不修改 Account Overlay、accessId、套餐模型成员约束或 Registry 完整性语义。
