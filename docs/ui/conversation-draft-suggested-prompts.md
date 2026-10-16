# New Task 草稿页推荐提示词

## 背景

新版 New task 首页在 Chat composer 正下方增加「推荐提示词」入口。原有横向按钮组由
`clientScenesService` 的 `draft-suggestion` scene 下发；主动任务推荐列表使用本地按功能维护的推荐池。

## 主动任务推荐

- 本期主动任务推荐仅在办公模式显示。办公模式在 onboarding 第三步提供默认勾选的选项；编程模式不显示该选项，也不显示主动推荐列表，保留原有 Client Scenes 小型场景入口。设置页保留「主动任务推荐」开关，说明「仅在办公模式下支持」，编程模式下不可操作。即使旧设置里主动推荐为开启，编程模式也不能显示主动列表。
- 办公模式草稿输入框上方保留插件入口：缩略展示当前列表前三个插件图标，展开后仍列出这三个和其他插件；点击条目导航到现有插件市场，不在推荐功能中注入插件市场假数据。
- 展示文案简短，不含 `[占位符]`；点击后填入的正文完整、可执行，可以用 `[目标对象]` 等占位符补充非必需信息。推荐任务不得以“如果当前仓库是某类项目”作为开始条件。
- 每个可见面板展示三条。抽取时优先避免同屏重复图标与插件，并尽量避开其他分屏已显示的图标；候选不足时仍显示三条。“换一批”只重新分配当前面板，其他面板已展示的批次和插件确认锚点保持不变。轮换应让池内每条推荐在有限轮次内可达。关闭推荐复用既有设置和 onboarding record 回写。
- 推荐图标使用 24px 无边框底板和内边距；GitHub 白底素材额外缩至 18px，避免白色方块贴近底板边缘。
- 填入正文中的 `[@插件](plugin://stable-id)` 在 Composer 内按原位置形成结构化提及；多个插件可同时出现。点击仅替换草稿，不自动发送。

## 产品语义

- 点击不引用 Plugin 的推荐项时，立即把固定 prompt **预填**到 Composer，不自动发送。
- 点击引用 Plugin 的推荐项时，等待目标 Host 的首次可信解析。首次本地检查仍可直接引用时不显示额外反馈，`ready` 时一次性写入结构化 Plugin 提及与 prompt；正文已有该插件引用时保留原位置，不重复前置，正文含多个插件时逐个解析为提及节点。首次检查发现不能直接引用时，当前推荐项的唯一 Plugin action Popover 立即进入 loading。其他结果或解析失败时
  一次性写入纯 prompt，避免先出现正文、稍后再跳入 chip 的两阶段更新。
- 预填会**替换**现有草稿，不做追加或合并；用户仍可继续编辑后手动发送。
- prompt item 的 `on_finish` 按英文逗号拆分、trim 并去重，再由显式 `switch` 白名单映射行为。
  当前支持以下导航行为，命中后均终止本次 Composer 预填：
  - `NAVIGATE:AUTOMATIONS`：复用 workspace 主导航打开 Automations。
  - `NAVIGATE:AUTOMATIONS:OFFPEAK`：打开 Automations；待定时任务/闲时任务数据就绪后，仅当
    `Idle-time` tab 实际存在时自动选中该 tab，否则保持 Automations 的默认 tab。若同一 item 同时声明
    两种 Automations action，以更具体的 `NAVIGATE:AUTOMATIONS:OFFPEAK` 为准且只导航一次。
    未知或空 action 不改变普通 prompt 的预填语义。
- 手机 `/remote` 不承载 Automations；当页面没有 Automations 导航能力时，必须过滤声明了
  任一 Automations 导航 action 的推荐项，不得展示一个无效入口或绕过既有端侧边界。
- 推荐项可以声明一个固定 Plugin stable ID。只有 Plugin 已启用且不存在同名冲突时，首次写入才在 prompt 前加入 canonical
  `[@Plugin](plugin://stable-id)` 引用并创建结构化 Plugin chip。
- Plugin 首次可信解析期间记录点击时的 renderer-local Composer revision；若用户输入、外部插入或草稿恢复使 revision 变化，
  该 operation 静默放弃延迟写入和后续 Popover，禁止用迟到的推荐结果覆盖当前草稿。
- `missing` 必须先只刷新 `zcode-plugins-official`，刷新成功后重新解析；刷新失败、候选消失、来源不可信或冲突均为
  `unavailable`/`conflict`，禁止使用旧快照一键安装，保留纯 prompt。
- `zcode-plugins-official` 刷新最多等待 10000 ms；达到超时后主动中止刷新并按 `marketplace_refresh_failed` fail closed，禁止继续读取旧快照候选，只保留纯 prompt。
- 一键安装只允许 `zcode-plugins-official`，固定使用 `scope: "user"`，安装到当前权威 Agent Host 的当前用户；远程 workspace 写入远程 Host。
- 首次本地检查发现目标 Plugin 不存在、即将刷新官方 Marketplace 时，Agent 必须先按 `operationId` 发出 `refreshing` 进度；UI 收到后立即让
  当前推荐项的 Plugin action Popover 进入 loading。首次可信解析直接返回 `disabled` 时，UI 在写入纯 prompt 前让同一个 Popover 进入 loading。
  `ready`、`conflict`、`unavailable` 和解析失败不得仅因首次检查而新建第二个 Popover。
- 每个推荐操作在任意时刻最多存在一个 Plugin action Popover。loading、安装/开启确认、安装/开启进度以及成功/失败都只更新同一个
  `PopoverContent` 的 phase/message/action；切换推荐项时先清理旧 operation 的同一实例，再由新 operation 复用这个唯一挂载点，禁止并行挂载、嵌套或叠加第二个 Popover。
- `missing` / `disabled` 可信结果继续把纯 prompt 交给 Composer；只有 Composer 已消费对应插入请求、输入区与推荐项完成本轮布局后，
  同一个 loading Popover 才原地切换为确认态。Popover 以当前推荐项按钮为锚点，在按钮正下方 `9px` 打开，不抢 Composer 焦点、不阻断页面其它交互，桌面与手机 Web 都必须限制在当前 viewport 内。确认态宽度为 `240px`，高度由本地化内容自然撑开；不设置自动关闭时限。用户以主指针点击 Popover 外部区域时，关闭 Popover、取消该 operation 并只保留纯 prompt；焦点移出、Popover 内部点击、前置 loading、安装/开启进度和结果态不得触发这条确认态关闭行为。
- 首次可信解析已经返回 `ready` 时一次性替换为 chip + prompt；当前没有 workspace 级 Plugin，不得再调用 `plugins/referenceCatalog`，也不得失效草稿 Runtime 或再次调用可信解析。只有安装或启用成功后，才失效延迟草稿 Runtime，并由目标 Host 再次可信解析状态。
- 可信解析结果可以携带官方 Marketplace listing 的 display-only `icon`；该字段不参与身份、安装判断或权限，只随同一次解析返回。UI 将它写入 Plugin mention；缺失或无效时使用既有默认 Plugin 图标，不得只为图标恢复 catalog RPC。
- 用户确认安装或启用后，同一个 PopoverContent 从确认态收敛为常驻进度；只有目标 Host 再次可信解析为 `ready`、Composer 已消费并清理对应前置 chip requestId 后才显示成功态。进度内容切换到成功内容时复用模型切换标签的纵向滚动结构：`AnimatePresence initial={false} mode="popLayout"` 保持挂载点，旧进度内容从 `y: 0` 向 `-0.75em` 淡出，16px Check 与成功文案从 `y: 0.75em + opacity: 0` 进入到 `y: 0 + opacity: 1`，时长 `200ms`、easing 为 `[0.4, 0, 0.2, 1]`；reduced-motion 下直接静态替换。确认、失败和重试阶段不触发该滚动。安装/启用失败按 Popover 失败语义收敛，并继续保留纯 prompt。
- 一键安装的远端操作最多等待 10000 ms；超时即判定安装失败，取消旧 operation、阻断迟到结果，只保留纯 prompt，并让同一个 Popover 恢复安装确认态以便重试，同时按 UI logger `warn` 与 warning toast 记录失败。该超时只作用于安装阶段，不限制后续 Composer 收尾。
- 每次可信解析请求必须携带唯一 `operationId`，并同时携带目标 attachment 的 `clientMode` 与 `deliveryKind`：桌面为
  `desktop-continuous`，手机远控为 `web-remote-replayable`；两者只声明既有链路边界，不创建新的 stream 或恢复状态。
- 安装或启用进行中点击另一推荐项时，中断旧 operation；旧 operation 的迟到结果不得写入草稿、Popover 或 chip，取消尚未完成时暂时禁用其他推荐项。
- Plugin 不存在或未启用时，使用当前 locale 的 Plugin label 展示可恢复状态并保留纯 prompt；冲突、workspace RPC 未就绪或解析失败时
  降级为纯 prompt，不展示虚假的 Plugin chip。初次点击不自动安装或启用，只有用户明确点击 flow 中的安装/启用动作时才执行。
- Plugin 引用只是 capability hint，不自动发送，也不改变工具权限和审批；本次不处理 API Key、OAuth 或用户插件配置。
- 草稿继续由 renderer-local Composer draft 持有；发送仍走既有 desktop `desktop-continuous` 或手机
  `web-remote-replayable` 链路，不新增 relay/main/Host 业务状态。

```text
点击推荐项
  -> clientScenesService.list()
  -> 找到 scene == "draft-suggestion" 的 options.prompts.items
  -> 将 item.labels / item.contents 按当前 locale 解析为 label / prompt
  -> item.on_finish 按 "," 拆分、trim、去重
     -> 命中 NAVIGATE:AUTOMATIONS
        -> 使更早的异步 Plugin 查询失效
        -> 复用 onOpenAutomationsMain
        -> 写入 workspace 导航历史并打开 Automations
        -> 结束，不改写 Composer
     -> 命中 NAVIGATE:AUTOMATIONS:OFFPEAK
        -> 使更早的异步 Plugin 查询失效
        -> 将 automationTab=idle 写入 renderer-local workspace 导航历史
        -> 打开 Automations，等待 scheduled / idle tab 数据就绪
        -> visibleTabs 包含 idle ------> 切换到 Idle-time 并消费 intent
        -> visibleTabs 不包含 idle ---> 保持默认 tab 并消费 intent
        -> 结束，不改写 Composer
     -> 没有受支持 action
        -> 继续 prompt 预填链路
  -> 根据 item.defaults 的 option key + item id 反查 optional Plugin
  -> 读取 prompt / optional pluginStableId
  -> 无 Plugin -------------------------------> 立即一次性写入纯 prompt
  -> 有 Plugin -> 记录 Composer revision -> 订阅 operationId 进度 -> Agent 可信解析
                  -> 解析期间 revision 变化 ---> 静默放弃，不覆盖当前草稿
                  -> enabled 且无冲突 --------> 一次性写入 Plugin chip（含可选 display-only icon）
                                                 + canonical text + prompt
                                                 -> 不读取 workspace catalog
                                                 -> 不失效 Runtime、不二次解析
                  -> disabled ----------------> 唯一 Popover 进入 loading -> 一次性写入纯 prompt
                                                 + Composer 消费后同一 Popover 原地切换为「开启 {Plugin label} 插件」+「确认」
                  -> 本地不存在 -> 发出 refreshing(operationId) -> 唯一 Popover 进入 loading
                  -> missing -> 刷新 zcode-plugins-official（10000ms timeout）
                               -> 超时 --------> marketplace_refresh_failed；中止刷新并拒绝旧快照
                               -> 失败 --------> unavailable，禁止旧快照安装；一次性写入纯 prompt
                               -> 成功且候选可信 -> 一次性写入纯 prompt
                                                    + Composer 消费后同一 Popover 原地切换为「安装 {Plugin label} 插件」+「确认」
                                                    -> 点击 Popover 外部：静默取消，只保留纯 prompt
                                                    -> 点击：User-scope 安装
                                                       -> 达到 10000ms -> 取消并判定失败，只保留纯 prompt
                  -> conflict/unavailable ----> 一次性写入纯 prompt
  -> 安装/启用中 Popover 在原锚点常驻
  -> 安装/启用完成后失效延迟草稿 Runtime，并由目标 Host 重新可信解析
  -> 再把 Plugin chip 前置到当前最新草稿
  -> Composer 更新后，同一个 Popover 收敛为成功态
  -> 安装失败恢复确认态并允许重试；启用失败显示失败结果
  -> 替换 Composer + 持久化草稿 + 聚焦
  -> 用户手动发送
```

```text
operation A active
        |
点击推荐 B
        v
关闭 A 已存在的 Plugin action Popover（若有） -> abort A -> plugins/cancelOperation(A) -> 清理 A 结果
        -> B 立即成为 active；A 的迟到结果全部丢弃
        -> 不显示取消或中断反馈
```

## 组件

`packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx`

```tsx
<ConversationDraftSuggestedPrompts className="mt-6" onSelect={(item) => …} />
```

| Prop                  | 说明                                                    |
| --------------------- | ------------------------------------------------------- |
| `className`           | 外层容器附加类名                                        |
| `items`               | 从 `clientScenesService` 映射后的推荐项列表；默认空数组 |
| `onSelect`            | 点击回调，参数为完整推荐项配置                          |
| `disabled`            | 旧 operation 取消收敛期间禁用推荐项                     |
| `pluginActionPopover` | 当前安装/开启 Popover 的锚点、阶段、文案与确认动作      |

- 挂载点：`packages/ui/src/v4/SessionPane.tsx` 的 `conversationBottomDock` 中、`{composerNode}` 之后，
  仅草稿态（`isDraft`）渲染。草稿页按 `welcome -> composer -> suggested slot` 的顺序组织；Container
  使用正常文档流中的固定 `h-8` 槽位，不使用 absolute 定位。列表异步加载期间槽位保持为空，数据返回后按钮填入同一槽位，避免加载前后高度变化。
- 布局：按钮组从 Composer 下沿保留 `24px` 间距，内部使用 hug-content 的单行横向排列，
  按钮间距为 `gap-4`。桌面在 Composer 下方居中；窄屏保持单行并允许横向滚动，不折叠成纵向列表，
  也不挤压 Composer。按钮组本身不增加额外卡片背景，Composer 与空槽位作为同一居中布局整体参与计算。
- 每一项复用共享 `Button` 的 `outline` 交互态，行高为 `h-8`，使用 8px 的 `rounded-lg`、`px-3`；左侧保留
  `size-4` 图标槽（内部 `size-4` lucide 图标），右侧优先显示 prompt item 当前 locale 的
  `label`（来自 Client Scenes `labels`）。点击后仍使用 `prompt`（来自 `contents`）预填 Composer。
- Client Scenes 列表首次渲染时使用 waterfall 进入效果：按钮按 DOM 顺序从左到右以
  `65ms` 间隔接续，每个按钮从顶部裁切展开，同时从上方 `12px` 下落归位。动画不改变
  按钮组布局高度。系统开启
  `prefers-reduced-motion: reduce` 时完全关闭该动画。
- 按钮可见文本和图标统一使用 `text-foreground`；默认内容透明度为 `opacity-70`，hover 时通过
  `transition-opacity` 过渡到 `opacity-100`。可见文本继续以 `text-ui-base` 呈现并始终保持单行省略。
  窄屏不换行，超出按钮组宽度时由组内横向滚动承接，不让页面本身横向溢出。
- `plugin` 配置只参与点击后的 capability 解析，Plugin label 和 canonical 引用都不在推荐列表中展示。
- 图标直接使用 prompt item 的 `img` 作为 Lucide canonical 名称（kebab-case，例如 `file-text`），
  按名称动态加载对应 SVG。图标不设置独立颜色，使用 `currentColor` 继承图标槽的 `text-foreground`；
  `img` 为空、名称不属于当前 Lucide 版本或模块加载失败时回退中性的 `SquareCode`。不要读取 locale
  相关的 `imgs.cn` / `imgs.en`。
- 服务端 i18n 字段使用 `cn` / `en`；`zh-CN` 读取 `cn`，`en-US` 读取 `en`，字段为空时回退另一语言。

## Client Scenes 映射

只消费 `ClientSceneConfig.scene === "draft-suggestion"` 的 `options.prompts.items`；旧的
`ai-writing` 不再作为 fallback，其他 scene 和 option 均不参与推荐列表：

| `DraftSuggestedPromptItem` | 来源                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | prompt item 的 `id`                                                                                                             |
| `label`                    | prompt item 的 `labels`（`cn` / `en`）                                                                                          |
| `prompt`                   | prompt item 的 `contents`（`cn` / `en`）                                                                                        |
| `iconName`                 | prompt item 的 `img` Lucide canonical 名称；明确不读取 `imgs`                                                                   |
| `actions`                  | prompt item 的 `on_finish`；按英文逗号拆分后只保留 UI 明确支持的 action                                                         |
| `plugin.stableId`          | 遍历 prompt item 的 `defaults`；key 定位 `scene.options[key]`，value 中的 id 定位该 option 的 item，读取匹配 item 的 `contents` |
| `plugin.label`             | 同一个匹配 item 的 `labels`（`cn` / `en`）                                                                                      |

`defaults` 缺失、option key 不存在、item id 不存在或 Plugin stable ID 为空时，该推荐项按无 Plugin 处理。
当前 `DraftSuggestedPromptItem` 只支持一个 Plugin，因此存在多个有效 defaults 引用时按服务端声明顺序取第一个。

Client Scenes 通过共享 `useClientScenesResource()` 获取：与同一 Service authority 下的 scheduled / off-peak
模板并发挂载时只发出一次请求。冷缓存加载期间展示空列表；已有缓存时立即映射并展示旧目录，后台重验
不得清空列表。接口首次失败、响应 `code !== 0`、缺少 `draft-suggestion` scene 或缺少
`options.prompts` 时展示空列表，不回退到本地静态推荐；已有缓存的重验失败保留 last-known-good 推荐项。
接口失败使用 UI logger `warn`，不影响 Composer。locale 切换只重新映射缓存中的 i18n 字段，不触发请求。
缓存去重窗口为 10 分钟；页面实际经历 hidden 后重新 visible 时必须绕过去重窗口强制重验一次，同一
Service/cache authority 的多个推荐项或模板消费方不得重复请求。

## 状态剪枝与覆盖

| Case  | 状态                                            | 期望                                                                                                                                                                                                                     | 覆盖         |
| ----- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| DSP01 | `draft-suggestion` prompt item、无 defaults     | 映射服务端 i18n，替换为纯 prompt，不自动发送                                                                                                                                                                             | focused unit |
| DSP02 | defaults 反查到 Plugin，首次解析即 ready        | 解析前不写入；结果返回后一次性替换为 chip + prompt，不失效 Runtime、不二次解析、不读取 workspace catalog；可选 icon 随结构化 chip 写入                                                                                   | focused unit |
| DSP03 | Plugin missing                                  | 首次本地检查缺失后先发 `refreshing`，唯一 Popover 进入 loading；只刷新官方市场，10000ms 超时中止并 fail closed；完成后一次性写入纯 prompt；Composer 消费后同一 Popover 原地切换为无时限确认态，点击 Popover 外部静默取消 | focused unit |
| DSP04 | Plugin disabled / conflicted / catalog 请求失败 | disabled 先让唯一 Popover 进入 loading，再一次性写入纯 prompt，Composer 消费后原地切换为确认；conflict/失败不增加第二个 Popover；请求携带 clientMode/deliveryKind                                                        | unit         |
| DSP05 | 安装或启用期间点击另一个推荐项                  | 静默关闭旧 Plugin action Popover 并取消旧 operation；取消收敛前禁用其他推荐项；迟到结果不覆盖新选择                                                                                                                      | focused unit |
| DSP06 | 安装完成且用户已编辑草稿                        | Popover 进度常驻；保留正文，将唯一 Plugin chip 前置；Composer 更新后在同一 Popover 以模型标签同款纵向滚动显示成功，不自动发送                                                                                            | focused unit |
| DSP07 | 安装或启用失败或安装达到 10000ms                | 安装失败恢复确认 Popover 并允许重试；启用失败显示失败结果；安装超时取消 operation，纯 prompt 保留                                                                                                                        | focused unit |
| DSP08 | scenes 加载失败/非成功 code/目标配置缺失        | 空列表，Composer 保持可用                                                                                                                                                                                                | unit         |
| DSP09 | locale 为 `zh-CN` / `en-US`                     | 分别使用 `cn` / `en`，缺失时跨语言回退                                                                                                                                                                                   | unit         |
| DSP10 | `img` 有效 / 缺失 / 加载失败，且 `imgs` 任意    | 有效图标；其余回退占位且忽略 `imgs`                                                                                                                                                                                      | focused unit |
| DSP11 | Plugin 首次可信解析期间用户修改 Composer        | revision 变化后静默放弃延迟写入和 Popover，当前草稿不被覆盖                                                                                                                                                              | focused unit |
| DSP12 | `on_finish` 含逗号、空白、重复或未知 action     | 只保留去重后的受支持 action                                                                                                                                                                                              | focused unit |
| DSP13 | 点击 `NAVIGATE:AUTOMATIONS` 推荐项              | 打开 Automations，不预填、不自动发送                                                                                                                                                                                     | focused unit |
| DSP14 | 点击 `NAVIGATE:AUTOMATIONS:OFFPEAK` 推荐项      | 打开 Automations；Idle tab 存在时自动选中                                                                                                                                                                                | focused unit |
| DSP15 | OFFPEAK intent 数据就绪后无 Idle tab            | 保持默认 tab，并消费一次性 intent                                                                                                                                                                                        | focused unit |
| DSP16 | 手机 `/remote` 无 Automations 导航能力          | 过滤两种导航型推荐项，普通 prompt 保持可用                                                                                                                                                                               | focused unit |

- 可信解析 loading、remote waiting、RPC error 都归入“当前不可验证”，用 DSP04 代表，不展开错误类型笛卡尔积。
- “未安装”必须经过可信解析和官方市场刷新；不能把 catalog 缺失直接当作可安装，也不能使用刷新失败时的旧快照。
- Popover 与草稿写入共用 latest-wins 边界，迟到的旧 catalog 响应不得覆盖草稿或显示过期提示；手动切换推荐项导致的中断始终静默。
- loading 与 confirmation 均不启动自动关闭计时；只有 confirmation 响应主指针的 Popover 外部点击并取消当前 operation。任意时刻全局最多挂载一个 Plugin action Popover。
- desktop、mobile Web、local、remote 共用相同 workspace-scoped prefill 与 canonical text，不重复为每个 Plugin
  状态叉乘；人工 UI 验收同时检查桌面和手机 Web。
- conversation E2E 采用代表链路：桌面本地安装、桌面远程 User-scope Host 隔离、手机远控刷新失败恢复，另加安装中切换推荐项。
  主题、语言、Popover action/常驻/外部点击、键盘焦点、移动布局和 reduced-motion 由人工验收，不宣称自动化覆盖 UI。

## Impact Brief

| 字段           | 结论                                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change layers  | `option-source`、`presentation`、`draft-default`、`validation`、`commit-effect`                                                                                                                                         |
| UI surface     | New Task 草稿页 `ConversationDraftSuggestedPrompts`                                                                                                                                                                     |
| Draft owner    | renderer-local Composer draft / workspace-scoped insert request                                                                                                                                                         |
| Option source  | `clientScenesService.list()` → `draft-suggestion.options.prompts.items`                                                                                                                                                 |
| Validation     | Client Scenes 映射边界 + 目标 Host `plugins/resolveSuggestedReference` 可信解析                                                                                                                                         |
| Commit sink    | `requestComposerTextInsert`；不调用 `onSendText`                                                                                                                                                                        |
| Persistence    | 既有 V4 Composer draft persistence                                                                                                                                                                                      |
| Invariants     | 普通 prompt 替换且不自动发送；导航 action 不预填；OFFPEAK 只在现有 Idle tab 间切换；Plugin 不可用时纯 prompt；workspaceIdentity 隔离；手机 `/remote` 不新增 Automations 入口；操作携带 clientMode/deliveryKind 且可取消 |
| Graph evidence | `capability.plugin-reference` + 新增 suggested-prompts surface；当前环境无 codegraph，使用 feature graph seeds 与 depth-2 精确调用点核对                                                                                |

组件继续作为纯展示和点击入口；服务端配置只提供候选与 capability hint，UI 只消费目标 Host 的可信解析结果，
不再读取 workspace catalog，并保持单行标题、隐藏 Plugin 引用、替换草稿且不自动发送的既有契约。

## Prompt 模板点击埋点

Desktop 中每次点击推荐 Prompt 模板（包括普通 Prompt 预填、Automations 导航和 Off-Peak 导航）均通过现有
`reportAppTelemetryEvent()` 上报一次产品埋点。Web 和手机远控本轮只保留既有 UI 行为，不调用该埋点；
两端真实上报链路后续单独补齐。事件固定为：

| 字段 | 值 / 口径 |
| --- | --- |
| `elementName` | `prompt_template_ck` |
| `eventRegion` | `app.session` |
| `eventType` | `ck` |
| `eventText` | 当前界面语言下用户实际看到的模板名称 |
| `eventExtraDetail.template_id` | Client Scenes prompt item 的 `item.id`，作为跨语言和改名稳定的统计维度 |
| `eventExtraDetail.template_prompt` | 当前界面语言解析后的完整 Prompt；不包含用户后续编辑内容 |

`eventExtraDetail` 严格只包含 `template_id` 和 `template_prompt`，不上传 `template_name`、
`template_action`、`talkId` 或 `messageId`。点击埋点在点击处理开始时触发，并与异步 Plugin 操作、导航
或草稿预填解耦；埋点失败不得阻塞原有交互。Desktop 的 `userId`、客户端上下文和设备字段继续由既有
`/event/report` 宿主链路补充。Web / 手机远控不在本轮 `/event/report` 统计范围内。
