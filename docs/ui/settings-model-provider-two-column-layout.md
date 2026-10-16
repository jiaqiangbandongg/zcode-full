# 设置页模型供应商双栏布局

`ModelProviderSection` 使用左导航 + 右详情的双栏结构，统一由设置页右侧页面纵向滚动。

## 内容高度与滚动归属

- CR-01：长导航或长详情时，保存/连通性反馈必须保持在外层 main 可视区与详情列内，不能定位到自然内容底部后在屏外消失。反馈沿用现有状态与自动关闭时序，仅以 CSS sticky 不占布局空间的覆盖层定位；祖先用 overflow-clip 保留圆角裁切，不建立额外滚动容器。
- MP-UI-06 在真实保存反馈出现后，分别撑高左右列并滚动到顶部、中部、底部，验证 1280×600 与 600×500 下反馈完整可见且不改变内容高度。

CR-01 修复边界：基于 Reviewer 的 5cad9f6028 快照，仅调整 SectionLayout 裁切和 ProviderDetailFeedback 定位，以及对应 spec/单测/E2E。原快照包含额外 CLI/signing 节点，未作为本次布局改动范围。旧代码 MP-UI-06 实测 visible=false；修复后 MP-UI-01/06 2/2 通过（desktop-e2e-20260911-130920-521），布局单测 3/3、typecheck 与 lint 通过。

- 双列 CSS Grid 最小高度 36rem（默认 576px），按较高一列的内容自然撑高，另一列拉伸等高。
- 导航与详情取消独立滚动和边缘滚动阴影；标题、说明、操作按钮及整个模型设置容器一起随外层 main 滚动。左侧设置导航仍独立滚动。
- 保留 224px / md 以下 56px 导航断点、详情内边距与底部反馈留白；内部文本框和独立弹窗仍可滚动。
- 高度由 CSS 负责，不增加 JS 测量、状态或持久化；供应商选择、编辑、服务调用和桌面 continuous / 手机 replayable 边界不变。
- MP-UI-01 使用临时内容高度探针验证宽窄窗口、左右分别较高、等高与真实滚轮驱动外层页面；探针移除后继续原有供应商操作。

验证记录（2026-09-11）：布局单测 3/3、macOS Electron MP-UI-01（1280px / 600px）通过；完整 typecheck、E2E typecheck、lint（0 errors）与架构检查通过。窄窗口验证覆盖响应式 CSS，未代替手机真机及 Windows / Linux 验证。

## 布局结构

- 外层容器：`Card` 语义边框，内部使用 `lg:grid-cols-[224px_minmax(0,1fr)]`。
- 左侧：供应商导航栏，按两级展示。
  - 一级（不可点击）：`预制模型供应商`、`自定义供应商`。
  - 二级（可点击）：具体供应商名称。
- 右侧：当前选中供应商的详情区域。
  - 预制/自定义：展示 endpoint、API Key（脱敏）、模型列表、Claude 槽位映射。
  - 选择 `添加供应商` 后，右侧进入新增表单。

## 2026-07-02 Provider family 与连接方式分层

- 左侧导航只负责选择 provider family 或自定义 provider。Z.ai / BigModel 在左侧各自只占一个入口，不随 Start Plan、个人 Coding Plan 或团队 Coding Plan 数量变化。
- Start Plan、个人 Coding Plan、团队 Coding Plan 和 API Key 是同一个 provider family 下的连接方式，只在右侧详情顶部的“连接方式”菜单中切换。
- 团队 Coding Plan 可以有多个，全部作为“连接方式”菜单项展示，不生成多个左侧导航节点。
- `selectedNodeKey` 只表示左侧导航节点；当前右侧详情项由 `selectedNodeKey` 对应 family 的连接方式设置和已保存连接方式 key 派生。
- WelcomeScreen 初始选中会先选中对应 family，再按入口意图选择右侧连接方式。

## 2026-08-15 Team Plan API Key 不可用提示

- Team Plan 连接项的可用性以企业套餐返回的团队项目 API Key 预热结果为准。
- 当团队项目 API Key 预热失败且服务端返回 `apiKeyUnavailableMessage` 时，右侧状态卡应优先展示该服务端文案，例如 `您当前暂无有效的团队套餐授权记录，无法创建API Key`。
- 没有服务端文案时，继续回退到本地固定文案 `团队套餐未分配，请联系团队管理员。`。
- 该文案只影响状态卡的不可用说明，不改变 Team Plan 连接键、provider family、用量查询和 runtime key 投影语义。

## 2026-09-17 个人与团队权益来源

- 个人 Coding Plan 使用个人 API Key 请求 `GET /api/biz/subscription/list`，识别 Coding 订阅且同时满足 `status=VALID`、`inCurrentPeriod=true` 才判有权益。缺 Key、被采用的 Coding 条目字段缺失或请求失败保持未知；成功返回空数组为无权益。订阅列表按条目解析，无关或不可识别条目不遮蔽有效 Coding Plan；存在有效条目即确认权益。没有有效条目且疑似 Coding 条目损坏时保持未知，其余为无权益。
- 团队入口来自 `GET /api/biz/customer/getCustomerInfo` 的组织/项目成员关系，不能由项目存在、active 或 pricing 的客户端补值推断权益。
- 团队使用业务 access token 携带 `bigmodel-organization`、`bigmodel-project` 请求 `GET /api/biz/team/subscribe/product/querySubscribeDetail`。`hasSubscription=true`、`status=EFFECTIVE`、`memberGrantStatus=VALID` 同时成立才有权益；`hasSubscription=false`、`EXPIRED` 或 `EFFECTIVE + UNASSIGNED` 为无权益，分别保留未开通、过期或未分配语义；其他未验证状态、缺失字段保持未知。
- BigModel 上述有效响应已于 2026-09-17 用生产账号验证。Z.ai 保持 family 域名和 Bearer 鉴权隔离，未支持接口或未识别响应保持未知，不能回退 quota 猜权益。
- `includeSubscription` 保留兼容参数，但 Coding Plan 快照始终查询并返回订阅摘要，轻量入口也不能仅凭额度判权益。
- 个人和团队的 `quota/limit`（包括 `type=2`）只负责额度/用量展示。额度为零、缺 data、业务失败或传输异常，都不能生成或撤销订阅。用量快照不得从 quota level 构造订阅，也不得给团队附上个人订阅。
- 权益、调用凭据就绪和用量可用是三个独立事实；团队查询无需创建/复制 API Key。个人缺 Key 不能当成无权益，团队获取调用 Key 失败不撤销已确认权益。
- 权益 owner 沿用现有 Account 连接服务与请求身份校验，不新增缓存；既有用量缓存升级命名空间，忽略旧版由 quota 合成的订阅。个人与团队独立查询，不因 quota 或刷新失败切换当前连接。

```text
账号身份 -> 个人 API Key -> subscription/list -> 个人权益
账号身份 + org/project -> 业务 token -> querySubscribeDetail -> 团队权益
选中身份 -> 调用 Key -> quota -> 仅用量展示
桌面 / 手机 -> 同一 Host 服务结果；原 continuous/replayable 边界不变
```

验收：个人有效/非当前周期/空列表/缺 Key/异常；团队有效/未订阅/未知状态/字段缺失/异常；多个组织项目隔离；两类 quota 为零、无 data、抛错均不影响已确认权益；团队订阅不继承个人商品及续费日期。

## 状态模型

- `selectedNodeKey`：左侧当前选中的二级节点。
- `editingId`：右侧是否处于编辑态。
- `isAdding`：右侧是否处于“新增供应商”表单态。

状态同步规则：

- 进入新增态时，强制选中 `custom:add` 节点。
- 进入编辑态时，自动把左侧选中同步到该供应商节点。
- 当前选中节点失效（如删除后）时，自动回退到第一个可选节点。

## 交互约束

- 一级标题仅做分组标签，不响应点击。
- 点击任意二级供应商节点，右侧只展示该节点详情。
- `添加供应商` 作为自定义分组的二级节点，和其他节点一样通过选中驱动右侧内容。
- 保留刷新、保存、删除链路；codex/claude/gemini 官方 OAuth 不再作为模型供应商设置入口。

## 2026-06-13 左侧导航窄窗口响应

- 模型供应商设置页的左侧导航在窄窗口下从 `224px` 收缩为 `56px` 图标栏，右侧详情区域保持 `minmax(0, 1fr)`，避免左栏挤占主要表单内容。
- 响应顺序为外层 Settings 侧栏先在 `lg` 收起，模型供应商导航随后在 `md` 收起，Plan/Usage 卡片最后在 `sm` 内改为纵向。
- 紧凑态只展示供应商图标、加载态和状态点，入口保持正方形图标按钮；供应商名称、连接方式徽标、分组标题隐藏在视觉层。
- 所有可点击导航项继续使用封装的 `ControlHintTooltip`，hover/focus 时在右侧显示供应商名称，保证收起状态仍能识别当前入口。
- 拖拽排序仍保留在自定义供应商条目的图标位置，不改变现有 provider id 排序语义。

## 2026-06-13 Plan Card 窄窗口响应

- 右侧 Coding Plan / Start Plan 卡片在 `sm` 以下允许从横向布局切换为纵向布局，主信息、状态和操作按钮不再互相挤压。
- 已开通套餐的用量摘要卡在宽屏保持横向并列；`sm` 以下改为纵向堆叠，保留每张卡的标题、模型说明、百分比和进度条。
- 套餐购买卡的价格信息和购买按钮在 `sm` 以下上下排列，按钮宽度跟随容器，避免长文案或本地化文本撑破卡片。

## 2026-04-07 左侧导航样式对齐（参考 z-work）

- 左栏宽度从 `280px` 收敛到 `224px`，并统一分组/条目间距，减少视觉噪声。
- 分组标题改为 `text-ui-base + font-semibold` 的行内标题样式。
- 节点改为“边框选中态”而非纯背景选中态：
  - 选中：`border-primary + text-foreground`
  - 未选中：`border-transparent + hover:border-border-hover/60`
- 节点左侧补充供应商图标：
  - 预置供应商：使用 OAuth provider logo（`Z.AI` / `BigModel`）
  - 自定义供应商：使用通用 `Package` 图标
  - 添加供应商：沿用 `Plus` 图标并使用 `text-primary` 强化可发现性
- 节点右侧状态点改为 `CircleIcon`，按是否可用区分蓝色（`text-sky-500`）与灰色（`text-gray-400`）。

## 2026-04-07 右侧详情区样式对齐（参考 z-work）

- 详情卡片统一为 `rounded-2xl + border + bg-background/50` 的面板样式。
- 标题字重保持 `font-semibold`，字号从偏大的 `text-lg` 收敛到 `text-ui-lg`。
- 字段标签统一为 `text-ui-base font-medium text-foreground-subtle`，弱化视觉噪声。
- 输入框与只读展示统一为 `rounded-lg + bg-input`，视觉与 settings 其他表单一致。
- 模型列表“新增模型”按钮改为次级按钮样式（`secondary`），并补齐 hover 背景表现。
- 占位卡片正文说明字体统一到 `text-ui-base text-foreground-subtle`。

个人和团队订阅响应沿用既有 envelope 契约：`code` 可省略，存在时仅接受 `0` / `200`；`success=false` 始终拒绝。数据部分仍按各自订阅 schema 验证。

套餐状态行的检查态与错误态互斥：`checking` 时只显示 spinner 和正在检查文案，不叠加上一轮团队错误图标、橙色或服务端错误消息；查询完成后按最终状态恢复提示。登录按钮沿用独立的 actionStatus/loginLoading。

团队详情中，普通权益查询失败或 Project Key 获取失败不代表 OAuth 失效，应显示重试而不是连接账号。重试顺序为刷新 Host 账户/凭据，再强制刷新当前组织和项目的权益；明确未分配套餐继续显示管理员提示，只有明确未登录或登录失效才进入登录流程。

团队订阅明确 `status=EXPIRED` 时权益不可用且保留 expired 原因；`EFFECTIVE + UNASSIGNED` 为未分配。未知枚举和请求失败保持 unknown，不能推断未开通。共享权益快照在 `no_plan` 下携带可选 teamPlanUnavailableReason；UI 显示过期/未分配提示，不显示连接、获取失败或重试。明确订阅失效优先于旧 Project Key 错误。

`团队订阅响应 → 服务解析明确原因 → UsageEntitlementSnapshot → 当前团队状态行`；现有服务和快照仍是唯一状态来源，不更改桌面/手机恢复边界。

团队只读订阅查询始终使用所选导航项的 family、组织、项目身份，不受执行 Provider availability 门禁影响；身份缺失时不构造团队请求。

个人和团队明确无权益时隐藏详情中的模型列表（含添加、编辑、测试和开关），保留模型设置页面入口、套餐状态卡和既有 banner，不删除已保存配置。个人 `notPurchased`、团队 `not-allocated` / `expired` 属于明确无权益；查询中、查询失败、取 Key 失败不能推断无权益，继续保留已有模型配置展示。套餐卡和既有 banner 规则保持不变。验收覆盖有权益、无权益、失败和查询中，以及无 Effective Provider 的无权益状态。

Start Plan 详情不显示体验套餐推广 banner（包括未登录、无权益状态），保留顶部套餐状态卡和既有个人套餐 banner；个人/团队未连接时同样不显示体验套餐推广 banner，并隐藏模型列表；保留连接状态卡、个人/团队套餐 banner，不删除配置。

BigModel 已登录但个人套餐未开通时，购买区同时展示静态目录中的个人与团队套餐 banner。团队历史订阅标记不隐藏团队购买入口；价格仍来自静态目录商品，不伪造商品或价格。

Start Plan 有效期兜底：共享 balance 读取以 HTTP Date 为本次响应时间，缺失时使用有效 JSON server_time，再缺失才使用本机时间；已到 ends_at 的 active 套餐规范为 expired，并剔除仅归属过期套餐的余额桶。权益校验和用量快照消费相同结果。无有效套餐且存在过期套餐时，快照携带 startPlanExpired，UI 显示“体验套餐已过期”、隐藏余额和模型列表，保留既有升级/购买入口。多套餐中有效套餐仍展示；缺失/非法结束时间不擅自判过期。

Start Plan 详情的购买 banner 还需检查同一账号平台的个人/团队有效权益：存在 status=purchased 的个人或团队连接时，隐藏个人与团队购买 banner，仍显示 Start 过期状态。历史 subscribed、过期、未分配、查询失败和其他平台权益均不能触发隐藏；个人/团队自身详情的购买规则不变。

同平台已有有效个人或团队套餐时，Start Plan 卡片的“升级 · 150% 配额”按钮及其活动说明一并隐藏，复用购买 banner 的有效权益判断。有效/待生效 Start 多卡的余额与模型列表保持原展示；个人/团队详情自己的升级动作不变。

设置页左侧智谱导航恢复品牌命名：BigModel / Z.ai，独立体验入口显示 Start Plan；中英文界面均保持这些名称。图标、状态点、导航 key、连接方式及右侧供应商品牌标题不变。

团队连接的设置页匹配身份为平台、组织和项目。保存的商品 ID 与订阅接口当前商品 ID 不同时，同组织/项目仍保持选中；初始化权益快照和后续商品列表均不得因此显示“连接不可用”或空选项。商品 ID 继续作为套餐元数据，展示匹配不写回选择、不改变请求鉴权或执行资格；不同平台、组织、项目保持隔离。
