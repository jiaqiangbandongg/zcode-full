# Model Provider Welcome 初始选中策略

## 背景

WelcomeScreen 同时承载账号 OAuth 登录和 API Key 配置入口。两类入口的用户意图不同：

- OAuth 登录表示用户希望使用账号套餐权益。
- API Key 入口表示用户希望配置同品牌的 API Key。

连接方式会写入 family mode / selected key，并影响输入框模型菜单展示同 family 下哪一组模型，因此初始化只能发生在明确入口意图下。

Model Provider 设置页的左侧导航只负责选择 provider family 或自定义 provider。Start Plan / Coding Plan / Team Plan / API Key 是同一个 family 内的连接方式，应通过右侧详情区的“连接方式”菜单切换。WelcomeScreen 入口需要同时决定左侧 family 和右侧连接方式；登录后 provider、个人套餐权益、体验套餐（Start Plan）fallback 权益和团队套餐结果又是异步刷新的，如果进入设置页首帧就选中，会误选 API Key 或个人套餐（Coding Plan）。

## 规则

WelcomeScreen 不等待套餐查询完成，仍保持现有进入应用节奏。它只写入一次性初始选中意图，由 Model Provider 设置页消费。

### 导航与连接方式分层

- 左侧 side 导航只显示 provider family / custom provider：
  - Z.ai
  - BigModel
  - 其他 Built-in provider
  - 自定义 provider
- 右侧“连接方式”菜单显示同 family 内可切换的连接方式：
  - Individual Plan / 个人套餐（个人）
  - Team Plan / 团队套餐（团队，按获取到的团队套餐逐项显示）
  - API Key
- Start Plan / 体验套餐不作为未登录连接方式展示；只有登录后确认存在体验套餐权益，且没有个人/团队套餐权益时，才进入连接方式菜单。
- 多个团队 Coding Plan 不生成多个 side 导航入口，只作为右侧连接方式菜单的多个选项。
- side 导航选中 family 后，右侧详情根据当前 family 的连接方式选中项渲染对应 Plan Card 或 API Key 表单。

### OAuth 登录入口

当用户通过 WelcomeScreen 选择 Z.ai 或 BigModel OAuth 登录后，Model Provider 设置页先选中对应 family 的 side 导航入口，再在同 family 内等待连接方式状态可判定，按以下优先级选中一次：

1. 个人套餐（Coding Plan，个人）：有个人 Coding Plan 权益。
2. 团队套餐（Coding Plan，团队）：按团队套餐获取结果中的第一个团队项。
3. 体验套餐（Start Plan）：有体验套餐权益。
4. 个人套餐（Coding Plan，个人）：无任何权益时仍落到个人 Coding 入口兜底。

完整状态矩阵：

| Start | 个人 Coding | 团队 Coding | 登录后 `modelProviderFamilySelectedKeys[family]` |
| ----- | ----------- | ----------- | ------------------------------------------------ |
| 有    | 有          | 有          | 个人 Coding                                      |
| 有    | 有          | 无          | 个人 Coding                                      |
| 有    | 无          | 有          | 团队 Coding                                      |
| 有    | 无          | 无          | Start                                            |
| 无    | 有          | 有          | 个人 Coding                                      |
| 无    | 有          | 无          | 个人 Coding                                      |
| 无    | 无          | 有          | 团队 Coding                                      |
| 无    | 无          | 无          | 个人 Coding 兜底                                 |

多个团队套餐同时可用时，使用后端返回顺序中的第一个 `subscribed === true` 团队；该团队下有多个项目时，使用 `teamProjects[0]`，没有项目 ID 时再依次回退到 product 级 `projectId` 和 `"0"`，保证 selected key 稳定。

体验套餐（Start Plan）查询依赖个人套餐（Coding Plan）的结果。只有确认个人套餐没有权益、团队套餐不可用或已判定，并且体验套餐 fallback 查询完成后，才认为体验套餐可判定。

设置页内不再拥有独立的连接方式初始化写回逻辑。设置页重开或 Team Plan 异步返回时，必须优先恢复历史 `modelProviderFamilySelectedKeys[family]`；只有用户在设置页手动切换连接方式时，设置页才写入新的 `modelProviderFamilyModes[family]` 与 `modelProviderFamilySelectedKeys[family]`。

重新连接后的自动连接方式更新由 Root OAuth 回调统一负责。OAuth 会跳到统一登录入口，设置页可能保持挂载、切到后台，或被卸载后重新挂载；因此登录成功后的后台 selected-key 刷新必须落到 shared settings，而不是依赖设置页是否挂载。

OAuth 回调成功后还必须在 Root 后台尽力刷新当前账号的连接方式设置。回调链路完成 provider key 刷新后，应读取最新 provider、个人 Coding/Start entitlement 和 BigModel Team pricing，并按同一优先级写入 `modelProviderFamilyModes[family]` 与 `modelProviderFamilySelectedKeys[family]`。该后台写入失败不能回滚登录态，但要记录日志；设置页只读取写入后的历史 selected key，不再消费 initial selection intent 做二次覆盖。

### API Key 入口

当用户通过 WelcomeScreen 的 API Key 入口选择 Z.ai 或 BigModel 后，Model Provider 设置页选中同 family 的 side 导航入口，并在右侧连接方式中直接选中 API Key，不受体验套餐、个人套餐或团队套餐权益影响。

API Key 登录只要求写入 `modelProviderFamilyModes[family] = "apiKey"`；输入框和设置页看到 API Key mode 后直接按同 family 的 API Key 入口展示，不需要依赖 OAuth selected key。

## 边界

- 初始选中意图只消费一次，消费后不再因后续 entitlement refresh 抢用户手动选择。
- 普通打开设置页不写入 WelcomeScreen 初始选中意图，继续沿用现有选中项、已保存 family mode 和 fallback 行为；不能按套餐权益优先级重新选择右侧连接方式。
- 入口意图只限定当前 family，不跨 Z.ai / BigModel 互相选择。
