# 17: 按类型添加 SSH／WSL／Docker

Status: done

**Parent:** [#15 — 项目创建与远程连接管理分离](15-project-device-selection-and-connection-management.md)

**What to build:** 设置中的新建连接直接打开按 SSH、WSL、Docker 分类的添加窗口。用户选择发现候选或手动填写，显式点击「添加并连接」，经过原有认证与安装流程，成功后在设置中看到已添加设备。

**Blocked by:** [#16 — 设置内连接独立完成](16-settings-connection-completion.md)。本票依赖其连接完成意图与设置独立收尾，避免新表单提交后仍被带去选目录。

**Spec coverage:** Q2、Q4、Q5、Q8；RDUX15-04 的设置入口、RDUX15-05，并复验 RDUX15-10／18／21。RDUX15-23／24／25 覆盖分类表单、平台限制与设置入口门禁。

## Acceptance criteria

- [x] 设置「新建连接」直接打开分类添加窗口，默认 SSH；不先展示包含已保存设备的跨类型统一列表，不要求再次选择已有设备。
- [x] SSH 支持从配置文件 Host 填充与手动填写；现有认证方式、凭据输入、高级选项、端口校验与必要错误提示保持可用。
- [x] 支持的平台上，WSL 提供发行版发现和现有手动入口；Docker 提供容器发现和手动配置。遵守各自的能力限制，不把 Docker 不可用、没有运行中容器和发现失败混为同一空态。
- [x] 选择发现候选只准备配置，不发起连接；主操作明确为「添加并连接」。发现加载或失败不阻塞其他来源和已有能力允许的手动入口。
- [x] 切换连接类型或目标时，旧发现响应不得覆盖新选择；凭据只属于相应目标，不能把前一个设备的密码或私钥口令带给另一目标。
- [x] 提交后复用同一认证、安装、升级及连接流程。成功留在设置并定位设备，不创建项目或聊天；失败保留可修正的表单和错误，不把认证失败描述为本次凭据已经保存。
- [x] 尚未识别设备的配置保留在设置的「未完成的连接」中；识别成功后使用 Source 身份展示设备，同一 Source 的不同 Profile 不形成重复设备；不增加「仅保存」模式。
- [x] 取消、关闭与 Esc 沿用 #16 的请求归属保护，既有连接记录和共享连接不被误删或断开；返回表单修正后可重试，不能再收到旧请求的导航或表单覆盖。
- [x] 类型切换、字段标签、发现候选、错误和主操作支持键盘、中英文、当前深浅主题及窄窗口；不支持的平台不出现不可完成的入口。
- [x] 先补对应交互测试再实现；同步更新依赖旧选择屏的设置测试和 helper，只改本票已经完成的入口断言，记录证据与未验证平台。

## Verification

- 从真实设置入口分别走 SSH、WSL、Docker 的发现与手动配置到连接完成，断言设备状态、设置定位及项目数量不变；WSL 在支持的 Windows 环境验证。
- UI 集成测试控制发现响应顺序、发现失败和认证失败，验证选择不拨号、显式提交才连接、旧目标结果及凭据不污染新表单。
- 复用真实远程测试链验证认证／安装等待和失败重试；记录每种类型实际使用的环境，不能用 SSH 通过代替 WSL／Docker 通过。
- 本票实施须完成类型检查、lint、架构门禁、受影响单测和对应 E2E，以及适用的平台、主题和窄屏检查；新 E2E 按既有候选审核流程登记，不自行宣称 formal／CI 准入。

## Scope and handoff

- 从项目和聊天跳到该窗口并返回原草稿，分别由 [#20](20-project-draft-settings-round-trip.md) 和 [#21](21-chat-settings-round-trip.md) 接入；本票先把设置内的新增路径完整交付。
- 已添加设备候选与发现候选的产品含义按父规格区分。项目下拉菜单由 [#18](18-direct-project-creation-and-device-selection.md) 负责，本票不改变设备或项目身份，也不新增认证能力。

## Deferred verification

2026-10-12：用户明确要求本轮先不验证以下环境，保留 TODO；不记为通过。

- [ ] Windows 的真实 WSL 发现、手动添加和连接完成。
- [ ] Web／手机远控入口与 Host 能力门禁的真实端到端回归。


## Completion evidence (2026-10-12)

- 设置新建直接进入默认 SSH 分类表单；SSH config、WSL 发行版和 Docker 发现只填写配置，显式「添加并连接」才拨号。保持现有认证、安装、Source 归并和取消归属。
- 类型切换、SSH 目标修改清除旧凭据；初次发现与用户主动刷新的迟到 Docker 响应均在类型生命周期结束后失效。
- 验证：`pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint`（0 errors，208 条既有 warnings）、架构门禁（0 violations）、fixture check 均通过。受影响根单测 668 文件 / 6391 测试通过；最终远程 UI 回归 28 文件 / 295 测试通过。
- 真实 macOS Desktop + 独占 Linux SSH / Docker 环境运行 `conversation-session-settings-connection-completion.test.ts`，2 项通过：SSH config 与手填、认证失败修正、同 Source 不同 Profile、已在线复用、Docker 发现与手填、Esc 取消、设置定位及原项目恢复。所有添加路径的项目数 / 聊天数保持原值。
- 最终证据：`packages/desktop/.e2e-artifacts/desktop-e2e-20261012103617954-p8589-11f164b179b46093`，包括 16 组分类表单矩形与截图、8 组设置截图、`settings-completion-facts.json` 和测试报告；覆盖中英文、深浅主题、1440 / 480px。
- 窄屏早期断言读到了既有 100ms `transition: all` 的中间帧。运行记录显示 480px 视口中，宽度从 672px 过渡到 448px（x=16），按钮 right=447 / bottom=789.375，稳定布局完整可见。测试改为等有限动画的 `finished` 再测量，没有修改产品布局或加入产品超时。
- 旧 three-screen / walkthrough 的设置入口断言已迁移到本票语义；未重新运行其全部历史走查 / 后台场景，不沿用历史 PASS。新用例仍为 pending，不代表 formal / CI 准入。
