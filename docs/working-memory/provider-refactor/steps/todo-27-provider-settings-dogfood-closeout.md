# Todo 27：Provider Settings 体验与真实执行缺口收口

> 状态：已完成（自动化收口；macOS 实机复验待启动最新开发链）
>
> 日期：2026-08-27
>
> 前置关系：Todo 26 完成智谱 `access.type + access.mode` 契约切换后，再处理本文中的 Runtime Headers
> Schema 收口。其余 UI 与 Team Plan 状态切片可以独立实施。

## 1. 目标与边界

本文收口 Provider Refactor 首轮 macOS 实机体验后仍未完成、且已经裁决的问题：

1. 用统一视觉表达 Model Config 布尔叶子的 Effective 值与 Personal Overlay 来源；
2. 删除所有单字段恢复入口，只保留始终可见的模型级“全部恢复默认”；
3. 将保存成功和模型连接成功统一投影到窗口底部通知区；
4. 修复 Team Plan 的状态误判与请求期 Account Access 协议不一致；
5. 为以上行为补齐自动化证明和实机回归。

本文不处理跨进程 Personal Config / Provider Registry 更新机制。该问题涉及 Host、Agent、文件 watcher、revision
确认和执行前一致性，应在独立研究与 Todo 中完成，不得借连接测试增加临时轮询或 UI 兜底。

以下体验问题已经完成，不再重复实施：

- 历史重名不再阻断无关 Provider 保存；
- 不完整 Provider 可以保存但不可执行；
- Provider / Model 整行拖拽、拖拽回弹和 Dialog 穿透拖拽已经修复；
- Provider 启停已经合并为一个状态按钮；
- Context、Max Output 和 JSON 继承值使用 placeholder；
- JSON 使用固定高度文本框，内容在文本框内滚动；
- Model Dialog 和 Provider 双栏容器具有稳定高度与独立滚动；
- 国内 Provider 在 Built-in Config 和新增菜单中优先展示。

## 2. 布尔字段统一表达

### 2.1 两个正交事实

每个可编辑布尔叶子同时表达两个互不替代的事实：

```text
checked / unchecked
└─ 当前 Effective Model Config 的布尔值

普通边框 / 高饱和边框
└─ 当前值是继承结果 / 存在显式 Personal Overlay 叶子
```

不得使用“默认”“已修改”等附加文字。Personal Overlay 只通过样式表达：存在显式 Personal 叶子时，外层选项框和
内部 Checkbox 边框都使用更高饱和度；继承值使用普通边框。

“已修改”由稀疏 Personal Model Config Rule 中是否存在该叶子决定，不通过 `personalValue !== inheritedValue`
推断。用户显式写入一个与 Built-in 当前值相同的值，仍然是 Personal Overlay。

### 2.2 组件范围

输入类型、输出类型与模型能力统一使用同一种布尔选项组件、尺寸、Checkbox 和状态样式：

```text
properties.input_format.support_*
properties.output_format.support_text
properties.supportsToolCall
properties.supportsJsonSchemaOutput
properties.supportsNativeWebSearch
properties.supportsMidConversationSystem
requiresMfjsToolSchema
```

锁定的 Text 只表达不可编辑：保留锁图标和普通继承样式，不用高饱和边框伪装成 Personal Overlay。
PDF、Audio 继续隐藏且在编辑其他字段时无损保留。

## 3. 模型级“全部恢复默认”

删除 Context、Max Output、输入格式、模型能力和其他单字段旁的小型恢复按钮。Model Dialog Footer 只保留一个
“全部恢复默认”入口，并对 Built-in 成员和 Personal Provider 的模型始终展示：

```text
ZCode Built-in Model Config Rules
                  |
                  v
       Personal Model Config Rule（稀疏 Overlay）
                  |
                  v
        Effective Model Config
```

Personal Provider 的模型同样先由 Built-in 通用 Model Config Rules 解析，再叠加 Personal Rule，因此同样有可恢复的
继承基线。

按钮语义固定为：清空当前 `providerId + modelId` 的完整 Personal Model Config Overlay，重新展示 Built-in Rules
解析出的 Effective 值；它不删除 Provider、模型成员、Model ID、模型顺序或 Provider 顺序。没有任何 Personal
Overlay 时按钮保持显示但禁用；存在任一显式 Personal 叶子时启用。清空只修改弹窗草稿，仍由“保存”执行原子提交；
取消不得提交。

## 4. 窗口级成功反馈

Provider/Model 保存和模型连接反馈统一进入应用窗口底部的通知层，而不是进入 Provider 内容区、模型列表或页面顶部：

```text
Application viewport
┌─────────────────────────────────────────────┐
│                                             │
│         Provider Settings scroll area       │
│                                             │
│                         ┌─────────────────┐ │
│                         │ 较早的成功消息  │ │
│                         ├─────────────────┤ │
│                         │ 最新成功消息    │ │
│                         └─────────────────┘ │
└─────────────────────────────────────────────┘
```

- 最新消息固定在最下方，多条不同消息向上堆叠；
- 不显示 `dirty` 文案；同一保存目标的 saving、success、failure 使用同一稳定 key 原位替换；
- saving 不自动消失，success 短暂停留，failure 延长停留并提供重试/关闭；
- Provider 保存成功需要能识别对应 Provider；模型保存和模型连接消息必须显示 Model ID，同名模型必要时同时显示 Provider 名称或 Provider ID；
- Provider 或模型数量变化、左右面板滚动均不得推动通知位置；
- Toast 容器必须完全位于 viewport 内；顶部标题栏避让不得机械应用到底部容器。

通知组件必须复用现有窗口级反馈基础设施；若当前基础设施不支持堆叠与替换，应扩展同一个 store，不建立
Provider Settings 私有的第二套 Toast 状态。

## 5. Team Plan 状态必须区分未知与不可用

当前 Team Plan 页面把以下两个事实合并成 `teamPlanUnavailable`：

```text
项目 API Key 被服务端明确判定 unavailable
                         +
Team quota 没有快照 / 正在请求 / 请求失败
                         |
                         v
               “团队套餐未分配”
```

这会把“尚未得到事实”误报成“服务端已经确认不可用”。更严重的是，状态卡又用该结果阻止后续 Usage entitlement
刷新，形成自锁：初次没有 quota -> 显示未分配 -> 不再刷新 -> 永远未分配。

状态必须拆分：

```text
checking / unknown / request-failed
└─ 不得显示“团队套餐未分配”，不得阻止重试或刷新

explicit unavailable
└─ 只有项目 API Key 或 quota 权威响应明确表示不可用时才显示“团队套餐未分配”

available
└─ 展示已连接/已购状态，并允许 Account Overlay 正常发布
```

UI 不得因为 Team quota 成功而直接强制 Provider `enabled=true`，也不得自己拼 Account Overlay。Account Resolver 仍是
Provider 可执行状态的唯一投影者；本切片只修复展示状态机和刷新门禁。

## 6. Runtime Headers 使用 Registry Access 的正式 Schema

实机 Team Plan 请求失败的直接原因不是套餐不存在，而是 Agent 发出的 Runtime Headers 请求携带 Registry 中完整的
`providerConfig.access`，App Protocol 却使用另一份手写的严格子集 Schema。两份 Schema 漂移后，Protocol 在模型请求发出前
拒绝参数，最终只显示 `Model request failed`。

Todo 26 完成后，Runtime Headers 请求中的 `accountAccess` 必须直接复用正式 Provider Registry Access Schema 对应的
`zhipu-account` 分支，不再维护 `{ type, family, planKind }` 或其他手写投影：

```text
Effective Provider Config.access
          |
          | 同一正式 Schema / 同一序列化形状
          v
Runtime Headers request.accountAccess
          |
          v
Host 按 family + mode 取得请求期材料
```

本切片不得：

- 通过 `.passthrough()` 放宽 Protocol 来吞掉未知字段；
- 在 Adapter、Protocol 和 UI 各维护一份 Access DTO；
- 把安全校验材料、Ticket、JWT 或临时 Header 写回 Provider Config；
- 依据 Provider ID、Model ID、Endpoint 或 pathname 推断 Access Mode。

Runtime Headers 请求仍只携带定位和解释本次鉴权请求所需的静态 Access 事实；实际请求期 Secret 由 Host 响应返回并绑定
到该次 Model Request。

## 7. 实施顺序

```text
Todo 26：Access Type/Mode 契约切换
                 |
                 v
Runtime Headers Schema 复用正式 Access
                 |
                 v
Team Plan 真实请求回归

布尔 Overlay 样式统一
                 |
                 v
模型级恢复默认
                 |
                 v
窗口级成功反馈

Team 状态机拆分可独立并行实施
```

每个切片先写失败测试，再最小修改生产代码。测试发现需要改变本文之外的 Config、Overlay、Registry 或模型选择语义时，
暂停实施并请求裁决。

## 8. 测试计划

### 8.1 UI 与 Overlay

- 输入、输出和模型能力使用相同 Boolean option DOM 与视觉状态；
- checked 只由 Effective 值决定，Personal 样式只由稀疏叶子存在决定；
- 显式值等于继承值时仍显示 Personal 样式；
- Text 锁定字段保持普通样式；PDF / Audio 无损保留；
- 不存在任何单字段恢复按钮；
- “全部恢复默认”对 Built-in 与 Personal 模型始终存在，无 Overlay 时禁用；
- 全部恢复后清空完整 Personal Model Config Rule，取消不提交，保存后重新继承通用/具体 Built-in Rules。
- 两个复杂 JSON 编辑区只使用固定高度输入框自身的边框，不增加外层边框、背景或内边距；MFJS 前显示“其他设置”分组标题。

### 8.2 保存与成功反馈

- Provider/Model 保存和模型连接反馈显示在右侧 Provider 详情栏底部，不跟随内容滚动；
- 不渲染 dirty；saving、success、failure 使用同一 key 替换，failure 停留更久并可重试/关闭；
- 模型保存和模型连接消息包含 Model ID，同名模型包含 Provider 身份；
- 多条不同消息向上堆叠，重复消息替换；
- Provider 左右面板滚动、长模型列表和移动端布局不改变通知锚点；
- 中英文、明暗主题和键盘关闭行为一致。
- Provider 名称、Base URL 和 API Key 连续输入时共享闲时保存定时器，失焦立即 flush，不双重提交；
- Model Metadata Dialog 仍由显式保存/取消控制，不被闲时保存破坏事务边界。

### 8.3 Team Plan

- quota 缺失、loading、请求失败均不显示“团队套餐未分配”，且允许刷新；
- 权威 unavailable 才显示未分配；available 恢复正常状态；
- 状态切换不会由 UI 直接修改 Provider enabled；
- `zhipu-account/team-coding-plan` 的完整 Registry Access 能通过 Protocol 严格校验；
- Start、Individual、Team、Off-Peak 的 Runtime Headers 参数均与 Todo 26 的 Mode 契约一致；
- Team Plan 请求在模型网络调用前成功取得请求期材料；缺失材料时返回准确鉴权错误，而不是 Schema 错误。

### 8.4 回归边界

- 普通 `api-key` Provider 不进入 Runtime Headers 请求链；
- Account Overlay、Start 账号模型约束和 Provider Registry 成员不被 UI 状态机修改；
- Desktop local 与 Web Remote 继续由目标 Environment Host 提供请求期材料；
- 已创建 Active Model 的冻结语义不变；
- Provider / Model 拖拽、独立滚动、Dialog 遮罩和固定高度 JSON 编辑器不回退。

## 9. 完成标准

- Settings 中所有模型布尔配置具有统一外观并准确表达 Personal Overlay 来源；
- 只存在一个始终可见的模型级恢复默认入口；
- 保存和连接成功反馈稳定锚定右侧 Provider 详情栏底部，模型成功消息带身份；
- Provider 文本输入同时支持闲时保存和失焦立即保存，不制造重复写入；
- Team Plan 不再把未知或请求失败误报为未分配，也不会自我阻断刷新；
- Team Plan 的 Runtime Headers 请求严格复用正式 Registry Access Schema，并能完成真实模型请求；
- 定向单测、`pnpm typecheck`、`pnpm lint`、受影响 UI E2E 和 macOS 实机回归通过；
- 不增加第二套 Model Config、Account Access、Registry、Toast 或连接状态事实。

## 10. 实施结果

- 输入/输出格式、能力字段和 MFJS 统一使用同一个 Boolean Model Option；Effective 值决定 checked，稀疏
  Personal 叶子只通过高饱和外框与 Checkbox 边框表达，锁定 Text 不伪装成 Personal；
- 删除所有单字段恢复入口；模型级“全部恢复默认”始终显示，无 Overlay 时禁用，提交时原子清空该模型完整
  Personal Model Config，而不删除成员或身份；
- Provider/Model 保存与模型连接收口到右侧 Provider 详情栏的底部横幅；同一对象的 saving、success、
  failure 按 key 原位替换，不同对象向上堆叠，模型消息包含 Provider/Model 身份；不再显示 dirty，失败延长到八秒
  并提供重试或关闭；
- Provider 名称、Base URL 和 API Key 的文本草稿在停止输入 800ms 后自动保存，失焦/Enter/切换时立即
  flush；同一 Provider 只有一个定时器且同草稿不重复提交，中文 IME 组词期间不触发闲时保存；
- 两个复杂 JSON 编辑区去掉重复的外层边框、背景和内边距，只保留固定高度输入框；MFJS 开关归入“其他设置”分区；
- Team Plan 状态机区分 loading、request error 与服务端明确 unavailable；详情页不再以“未分配”状态阻止
  entitlement refresh，消除首次缺 quota 后永久自锁；
- Runtime Headers 请求直接使用 `zcodeProviderAccountAccessSchema`。API Key、Start、Individual、Team、
  Off-Peak 五种 Registry mode 均通过严格 Protocol 测试，旧 `planKind` 形状被拒绝；
- 设置页、Usage 和登录恢复不再用动态 `zcodeAccountAccessSchema` 解析 Registry Access。UI 只传递
  `{ type, family, mode }` 静态事实，Host 的 Account Request Auth Service 再根据当前连接解析动态
  `planKind` 与 Team scope；Team usage source 由静态 `team-coding-plan` mode 与已订阅项目事实组合，
  不把项目身份写回 Provider Config；
- 模型选择分组与 Official MCP 凭证解析也已切到正式静态 Registry Access Schema。Official MCP 在
  Host 调用边界解析当前动态连接，并把前后两次 Account Access 一并纳入一致性检查；同一 Family 同时
  启用普通套餐和 Off-Peak 时，设置与 Usage 均按精确 Provider ID 解析，不再要求“Family 下唯一 Provider”；
- Bugfix 03 的最大输出 Token 重复 JSON 入口同步删除，唯一数字入口按 inherited limit 确定性产生完整
  `LimitOptionSpec`；
- 新增 Personal Model 的 Config Rule 预览只作为 `inheritedConfig` 和输入 placeholder，不再回填为用户输入；
  提交时 Built-in 通用规则提供的 context、输入输出格式与能力不会被误写成 Personal Overlay；
- UI、Team Plan、Shared Protocol、Model Selection 和 Official MCP 定向测试通过；根 `pnpm typecheck`
  与 `pnpm lint` 通过（lint 仅保留 34 条仓库既有 warning），本轮修改文件格式检查通过；
- 全量 Unit 共 `12,463 passed / 25 skipped`；仅两个与本轮无关的 Server CLI ZIP 用例因当前宿主未安装
  `zip` 可执行文件而在启动外部命令时 `ENOENT`，Provider/Model/Account/Settings 回归没有失败；
- Linux Desktop E2E 已完成构建，但宿主缺少 `xvfb-run`，Electron 在进入用例断言前退出。该环境阻塞和
  macOS 最新开发链实机复验不伪装为自动化通过，继续作为发布前真实验证项保留。
