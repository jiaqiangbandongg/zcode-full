# Todo 72：旧 Built-in Provider 配置与模型选择身份迁移

> 状态：已完成实现与阶段验收（2026-09-04）。
>
> 2026-09-08 后续裁决：本文按当前账号区分个人/Team 的 Selection 迁移已由 [Todo96](todo-96-selection-offline-migration-and-resolution-consolidation.md) 替代，旧 Coding Plan 离线固定落到同域 Individual，实际账号对应由有效选择解析负责。以下保留当时实施轨迹；真实连接设置迁移、OAuth/Team 组织补齐不受影响。
>
> 更新：2026-09-03。来源：同事旧版 `config.json` 迁移后，内置套餐错误出现在自定义供应商列表。
>
> 回滚边界以最新 Todo 69 为准：不持续双写旧字段。本文补齐升级迁移，不恢复已取消的双写方案。

## 1. 已确认的问题

旧配置中的 `builtin:*` 条目也可能保存为 `source: "custom"`。当前
`legacyPersonalProviderConfigImporter.ts` 主要按 `source` 筛选，于是把这些内置配置完整迁成
`standard-personal`，连旧套餐 Endpoint、账号凭据和模型成员也一并冻结下来。

现有测试只覆盖 `source: "builtin"`，没有覆盖这份实际旧数据的形状。

此外，部分旧 Model Selection 的转换只是搬运 Provider ID。旧版个人与 Team 共用 Coding Plan ID，
新版已经拆成两个 Provider；只复制字符串不能保证迁移后的选择仍指向正确身份。

## 2. Provider 配置迁移裁决

```text
旧 config.json
      |
      +-- builtin:bigmodel --> bigmodel-api：只迁 API Key
      +-- builtin:zai ------> zai-api：只迁 API Key
      +-- 其他 builtin:* ---> 不导入旧 Provider 配置
      +-- 其他已确认的账号/系统配置 --> 不导入旧 Provider 配置
      `-- 真正自定义 Provider --> 保留既定自定义迁移规则

当前 Built-in / Template + 当前 Account 数据
      `--> 提供内置名称、Logo、API 配置、模型与套餐事实
```

- 先识别旧系统保留的 Provider 身份，再处理 `source`；不能让 `source: "custom"` 覆盖内置身份。
- Built-in API 唯一保留的旧配置是非空 API Key。旧名称、URL、Schema、Headers、管理地址、启停状态、
  模型成员、排序、Context 和其他 Model Rules 全部不迁。
- API Key 落到当前 `bigmodel-api` / `zai-api` 对应的 Personal 配置。复用当前 Template 建立方式；
  必需的当前身份或 Template 关联不是旧字段复制，不得为此复制整份 Template 静态配置。
- 没有 API Key 时，不制造自定义副本，也不写空 Key 覆盖已有有效值。
- 套餐 Token、JWT、动态 Headers 和旧账号状态不迁入 Personal，由当前账号凭据链重新提供。
- 真正自定义 Provider 继续迁移调用配置、模型成员/顺序及合法 Context Window；其余模型能力按既定规则丢弃。
- 不凭显示名称或 URL 判定内置身份。UUID 自定义 Provider 即使叫“智谱”或“ZCode”，也不能被误删。
- 旧 `config.json` 保持原样，不生成备份，不恢复 `model-providers.json` 回退，不新增未发布中间版本兼容。

本次处理旧文件首次导入。已经生成的 `provider_config.json` 不得被重新导入覆盖，也不得按名称扫描删除
“疑似内置”的条目。**已经错误迁移的用户配置只做人工修复，不专门编写自动修复代码。**
本 Todo 不自动扫描、删除或重置已有新配置；不能宣称修正首次导入会自动修好这些用户的数据。

## 3. 已持久化模型选择怎么迁

### 3.1 可以直接对应的身份

- `builtin:bigmodel` → `bigmodel-api`。
- `builtin:zai` → `zai-api`。
- `builtin:bigmodel-start-plan` → `account:bigmodel-start-plan`。
- `builtin:zai-start-plan` → `account:zai-start-plan`。
- 真正自定义 Provider 保持原 ID，与 Provider 配置迁移结果一致。
- 已退役且没有当前对应身份的 `builtin:zapi` 保持未绑定，不创建自定义 Provider 来凑身份。

### 3.2 旧 Coding Plan 按迁移时的当前账号连接落到具体 Provider

旧 Coding Plan ID 表达的是同一 Family 当前使用的 Coding Plan，个人/Team 切换时旧选择仍可使用。
因此这里采用用户最新裁决，**允许使用迁移时当前账号连接**，不要求还原当年的个人/Team 身份。

```text
旧 builtin:<family>-coding-plan
                 +
同一环境、同一 Family 当前选中的账号连接
                 |
                 +-- 个人 --> account:<family>-individual-coding-plan
                 +-- Team --> account:<family>-team-coding-plan
                 `-- 无法确定 --> 留空/未绑定，主体数据仍可打开
```

- `<family>` 仅为 `bigmodel` 或 `zai`；不能跨 Family 选择账号。
- 使用现有账号连接的权威状态，不另写一套“有 Team 就选 Team”的优先级，也不从模型列表首项猜测。
- Team 的组织/套餐身份继续属于 Account 连接，不把账号凭据或 Team 字段塞进 ModelSelection。
- 这是一项旧动态身份的升级规则，不是当前运行时 Account-first 回退。迁移并保存为新身份后，正常恢复只认新字段，
  不在每次账号切换时重新解释旧字段。
- 账号未登录或连接尚不明确时不阻塞历史打开，不增加无限等待登录的屏障；选择控件留空、允许重新选择，不弹留空提示。
- 不从 Configured Default、其他 Family、同名模型或任意可执行 Provider 猜出旧身份。

动态身份成功转换后，在所属记录现有保存入口固定新 Selection。Session 在本次成功恢复期间保存当前选择，
不等待下次发送；文件导入在首次写出新文件时固定。Reasoning 留空不妨碍固定已确认的 Provider/Model。
不改写历史请求身份，不批量重写历史；写入须保护期间更新的用户选择。失败保留正常存储错误处理，
不声称迁移完成，不阻断历史打开，也不另建迁移调度器。

### 3.3 当前字段、模型与 Reasoning

- 已有当前 ModelSelection 时以当前字段为准，不因不完整而用旧字段覆盖。不能只按字段名判断新旧：
  旧版也可能已写 `modelSelection`，其中明确的旧内置保留 ID 仍需在升级边界转换。转换只使用该选择自身的
  身份及本节允许的账号上下文，不从旁边旧字段补值；普通未知 ID 或 Registry 查找失败不构成旧格式证据。
- 保留能确认的模型 ID；目标 Provider 不提供该模型时保持未绑定，不复制旧内置模型成员来强行满足选择。
- 旧字段能确定表达的 Reasoning 在单向 Decoder 中转换。新字段缺失或失效时按 Todo 70 留空，
  不偷偷选择 `values[0]`、`values.at(-1)` 或其他档位。
- 历史消息中记录的实际调用信息与下一次执行选择分开处理；不把“现在选中 Team”伪写成“历史请求实际使用了 Team”。
- 无法恢复的模型/Reasoning 留空，不自动替换，不弹 Toast、弹窗或额外失效横幅；不得因为绑定失败而拒绝
  打开整个 Session 或任务列表。真实执行失败仍保留正常错误反馈。

## 4. 实施范围与复用边界

先梳理各处实际旧格式，再复用小范围的身份转换函数；它只供迁移入口使用，不成为运行时别名表或第二套 Registry。
需要账号连接的入口显式接收已解析的迁移上下文，不让底层存储直接读取全局 UI 状态。

实施接口：共享迁移函数只转换旧 Provider ID，显式接收当前环境账号服务解析出的
`ZCodeAccountAccess`（可以为空）；不读取磁盘、不等待登录、不查询或扫描 Registry。
普通当前 ID 原样交给各领域验证，未知 `builtin:*` 返回未绑定。模型成员与 Reasoning 的有效性仍由
所属领域使用目标 Registry 判断。账号上下文沿用现有 `resolveCurrentAccountAccess` 的身份与连接规则，
不能把仅保存的 Family 偏好直接当作已登录账号事实。

逐项核对以下持久化入口，记录是否已有转换、缺口与对应测试，不能只修 Provider 配置导入：

- Provider Config：修正内置身份分类和 Built-in API Key 例外。
- Account Settings：核对旧连接选择的转换，确保 Coding Plan 迁移能够取得同一 Family 的正确当前连接。
- Session：由 Todo 70 负责唯一 Decoder、当前字段优先和未绑定恢复；本文提供身份转换规则，不再新增平行 Decoder。
- 自动化定义和 Run：核对旧模型选择格式；旧 `provider` 可能表示 Agent 后端，不得直接当成模型 Provider ID。
- 闲时任务：保留闲时专属 Provider/凭据语义，不把执行选择机械迁成普通 Coding Plan；无法确定时保留任务，
  选择留空，不弹留空提示；不得将不完整选择交给模型执行。
- 内置/自定义 Subagent：覆盖状态文件与 Markdown 中的显式旧选择，继承语义保持不变。
- Bot Config/State：接入 Todo 69 的一次性 v3 导入，不再直接覆盖旧文件。
- Wiki、Configured Default、Recent 及确有旧持久化格式的 Draft：核对实际 Reader，不能因共用类型就假定已自动迁移。
- 远端环境：使用该环境的配置和账号上下文；不得拿另一个环境的连接替历史选择绑定身份。

每个入口都要区分“旧结构迁移”和“当前字段损坏”。找不到可靠旧身份时留空，不增加模型名唯一匹配等旁路。
新建或调整的迁移注释使用中文，说明旧格式来源、一次性读取边界，以及旧数据保留用于回滚而非当前事实源。

### 与 Todo 69 / 70 / 71 的关系

- Todo 69：降级回滚边界，Bot 文件隔离；其他领域不持续双写。
- Todo 70：Session 升级 Decoder 与未绑定恢复，采用本文身份规则。
- Todo 71：当前 Composer Draft/Submission；不承担旧 Provider 身份推断。
- Todo 72：Provider 配置分类、旧身份转换及各持久化入口的接入检查。

实施时先确定共享转换输入和测试，再衔接各 Todo 的存储入口；相关任务若已实现则直接复用，不重复造迁移层。

联合执行顺序：

```text
68 收尾：执行模型一致
        |
72 基础：Provider 分类、API Key、旧身份转换及账号上下文
        |
69：Bot v3 首次导入直接接入正确转换
        |
70：Session 未绑定恢复、动态身份写回
        |
71：持久 Draft、Submission、统一留空且无提示
        |
72 后段：其他领域接入核对、联合升级/重启/回滚验证与实施报告
```

Bot/Session 的首次导入必须在最终身份转换接入后验收，不能先写新文件，再依赖已禁止的旧文件回读来修身份。

## 5. 测试与验收

先写测试，再改实现。以同事附件的结构制作脱敏 fixture，所有 Key 使用假值，不提交原始凭据和私人账号信息。

- 内置 ID 配合 `source: "custom"` 仍不产生自定义套餐；真正 UUID 自定义 Provider 不受影响。
- Built-in API 只留下 Key，当前 Template 正常提供其余配置；空 Key 不覆盖有效配置。
- 首次导入后不改写旧文件；再次加载不重复导入、不覆盖当前 Personal 编辑。
- BigModel/Z.ai 各覆盖个人、Team、无明确账号连接；验证模型身份及未绑定结果，不只看页面是否出现供应商。
- 新旧字段冲突时新字段优先；模型不存在、Reasoning 缺失/失效时 Session 历史与任务列表仍能打开。
- 旧版 `modelSelection` 中的明确旧内置身份也被转换；不能把“有这个字段”误判为迁移已完成。
- 选择留空不弹提示，不被 Composer 初始化或重启恢复补回默认值。
- 已有新 Provider 文件保持不变，不启动自动纠错迁移；已误迁用户走人工处理。
- 各持久化入口有定向测试，尤其自动化旧后端字段、闲时专属身份、Bot v3 和 Subagent 显式选择。
- 交互 E2E 覆盖旧配置升级后的供应商列表、API 使用及旧会话打开/重选后继续；同步更新与上述裁决冲突的旧断言。
- 回滚只验证 Todo 69 承诺的读取范围，不把“不持续双写”重新扩成精确恢复全部新选择。

执行后生成实施报告：列出各入口的处理结果、真实验证命令/结果、未验证项及需要裁决的问题。
确定的缺陷直接修复；无法自然确定的身份映射先讨论，不用兜底猜测凑通过。已有错误迁移只做人工修复，
不作为本 Todo 的自动修复待决项。

## 6. 执行清单

### 前段：先于 69 / 70 的迁移基础

- [x] 脱敏真实旧配置，补分类/API Key 测试。
- [x] 修复 Desktop 与 Standalone Provider 首次导入；CLI 允许旧配置中的空 Key。
- [x] 完成旧身份转换及个人/Team 迁移上下文测试；各领域保存接入按后段和 69/70 执行。

### 后段：69 / 70 / 71 后的各领域接入与联合验收

- [x] 逐项接入/核验上述持久化入口，与 Todo 69/70/71 去重。
- [x] 验证动态身份在现有写入边界固定；关闭再切账号连接不重新解释已迁选择。
- [x] 运行相关单测、交互 E2E、typecheck 和 lint。
- [x] Review 旧字段运行时旁路、静默替换、跨环境绑定及旧文件写入是否残留。
- [x] 生成实施报告，提交验证后的改动。
